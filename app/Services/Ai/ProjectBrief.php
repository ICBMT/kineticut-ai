<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Models\GraphNode;
use App\Models\Project;
use App\Models\Scan;
use App\Services\TechStack;
use Illuminate\Support\Facades\Cache;

/**
 * What the model is told about the project before anyone asks anything.
 *
 * The graph has already answered the questions a reader would ask first — what
 * is this built with, how big is it, how is it organised, where does execution
 * enter, what did the analysis notice. Putting those answers in the prompt is
 * what makes "what does this app do?" an instant reply instead of a code
 * crawl, and it costs a few kilobytes per scan, so it is built once and cached.
 */
class ProjectBrief
{
    /** Nodes named in the index. The heads of the graph, not all of it. */
    private const INDEX_LIMIT = 320;

    private const ROUTE_LIMIT = 60;

    private const INSIGHT_LIMIT = 8;

    public function __construct(private readonly TechStack $stack)
    {
    }

    public function text(Project $project, Scan $scan): string
    {
        return Cache::remember(
            "atlas:brief:{$scan->id}",
            now()->addHours(6),
            fn () => $this->compose($project, $scan),
        );
    }

    private function compose(Project $project, Scan $scan): string
    {
        $metrics = $scan->metrics ?? [];
        $stack = $this->stack->build($project, $scan);

        $lines = [];
        $lines[] = 'PROJECT: '.$project->displayName();
        $lines[] = 'STACK: '.implode(' · ', array_map(
            fn (array $item) => $item['label'].' '.$item['value'].($item['hint'] ? ' ('.$item['hint'].')' : ''),
            $stack['items'],
        ));

        if ($stack['packages'] !== []) {
            $lines[] = 'DEPENDENCIES: '.implode(', ', array_map(
                fn (array $package) => $package['name'].($package['version'] ? ' '.$package['version'] : ''),
                $stack['packages'],
            ));
        }

        // Counted from the graph rather than read from the metrics blob: the
        // metrics carry per-stage numbers, and a brief that said "0 nodes"
        // because it looked in the wrong key made the whole thing look broken.
        $lines[] = sprintf(
            'SIZE: %s files · %s lines · %d nodes · %d relationships · %d layers · %d modules',
            number_format((int) ($project->file_count ?? 0)),
            number_format((int) ($project->loc ?? 0)),
            $scan->nodes()->count(),
            $scan->edges()->count(),
            $scan->nodes()->distinct()->count('layer'),
            $scan->nodes()->whereNotNull('module')->distinct()->count('module'),
        );

        if ($description = $project->composer_description) {
            $lines[] = 'DESCRIPTION: '.$description;
        }

        // ---- how the code is organised -------------------------------------
        $layers = $scan->nodes()
            ->selectRaw('layer, count(*) as total')
            ->groupBy('layer')
            ->orderByDesc('total')
            ->pluck('total', 'layer');

        if ($layers->isNotEmpty()) {
            $lines[] = '';
            $lines[] = 'ARCHITECTURE (a layer is a band of responsibility, entry at the top):';
            foreach ($layers as $layer => $total) {
                $lines[] = sprintf('  - %s: %d nodes', \App\Enums\Layer::tryFrom((string) $layer)?->label() ?? $layer, $total);
            }
        }

        $modules = $scan->nodes()
            ->selectRaw('module, count(*) as total')
            ->whereNotNull('module')
            ->groupBy('module')
            ->orderByDesc('total')
            ->limit(24)
            ->pluck('total', 'module');

        if ($modules->isNotEmpty()) {
            $lines[] = 'MODULES (a module is a folder or namespace group): '.$modules->map(
                fn ($total, $module) => "{$module} ({$total})",
            )->implode(', ');
        }

        // ---- where execution enters ----------------------------------------
        $routes = $scan->nodes()->where('type', 'route')->orderByDesc('weight')->limit(self::ROUTE_LIMIT)->get();

        if ($routes->isNotEmpty()) {
            $lines[] = '';
            $lines[] = 'ENTRY POINTS (HTTP routes this project answers):';
            foreach ($routes as $route) {
                $lines[] = sprintf(
                    '  - %s [%s]',
                    $route->label,
                    $route->file_path ? $route->file_path.($route->line ? ':'.$route->line : '') : 'no file',
                );
            }

            $extra = $scan->nodes()->where('type', 'route')->count() - $routes->count();

            if ($extra > 0) {
                $lines[] = "  (and {$extra} more)";
            }
        } else {
            $entries = $scan->nodes()
                ->where(fn ($query) => $query->where('type', 'executable')
                    ->orWhere(fn ($inner) => $inner->where('type', 'function')->where('layer', 'entry')))
                ->orderByDesc('weight')
                ->get();

            if ($entries->isNotEmpty()) {
                $lines[] = '';
                // Why there is no route table is language-specific, and getting
                // it wrong makes the model answer about the wrong kind of
                // project — a Python script is not "compiled code".
                $lines[] = 'ENTRY POINTS ('.match ($project->language) {
                    'python' => 'a Python program has no route table, so execution starts at these scripts',
                    'cpp', 'csharp' => 'this is compiled code: execution starts at these, there is no route table',
                    default => 'execution starts at these',
                }.') :';
                foreach ($entries as $entry) {
                    $lines[] = sprintf(
                        '  - %s [%s] [%s]',
                        $entry->label,
                        $entry->type->value,
                        $entry->file_path ? $entry->file_path.($entry->line ? ':'.$entry->line : '') : 'no file',
                    );
                }
            }
        }

        // ---- what the analysis noticed --------------------------------------
        $insights = $metrics['insights']['items'] ?? [];

        if ($insights !== []) {
            $lines[] = '';
            $lines[] = 'INSIGHTS (static analysis findings — the graph looked at itself):';
            foreach (array_slice($insights, 0, self::INSIGHT_LIMIT) as $insight) {
                $lines[] = sprintf(
                    '  - [%s] %s — %s',
                    $insight['severity'] ?? 'note',
                    $insight['title'] ?? '',
                    $insight['detail'] ?? '',
                );
            }
        }

        // ---- the node index --------------------------------------------------
        $nodes = $scan->nodes()
            ->orderByDesc('weight')
            ->orderByDesc('fan_in')
            ->limit(self::INDEX_LIMIT)
            ->get();

        $lines[] = '';
        $lines[] = 'KEY INDEX — every node you may cite, "key · type · layer · file":';

        foreach ($nodes as $node) {
            $lines[] = sprintf(
                '  %s · %s · %s · %s',
                $node->node_key,
                $node->type->value,
                $node->layer->value,
                $node->file_path ? $node->file_path.($node->line ? ':'.$node->line : '') : '—',
            );
        }

        if ($scan->nodes()->count() > $nodes->count()) {
            $lines[] = sprintf('  (%d smaller nodes are not listed; ask about them by name and they will be read)', $scan->nodes()->count() - $nodes->count());
        }

        return implode("\n", $lines);
    }

    /** Cache key the scan invalidation uses. */
    public static function forget(Scan $scan): void
    {
        Cache::forget("atlas:brief:{$scan->id}");
    }

    /** Kept for tests and tooling: the first N keys the brief lists. */
    public function keys(Project $project, Scan $scan, int $limit = 5): array
    {
        return GraphNode::where('scan_id', $scan->id)
            ->orderByDesc('weight')
            ->limit($limit)
            ->pluck('node_key')
            ->all();
    }
}
