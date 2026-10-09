<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Cxx\CxxInsights;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use Illuminate\Support\Str;

/**
 * Stage 9 — turns the finished graph into an architectural opinion: hotspots,
 * god classes, orphans, layering violations, dependency cycles, missing
 * policies, debug leftovers and lazy-loading risks.
 *
 * Every insight carries the node keys it refers to, so the UI can highlight the
 * exact geometry that caused it.
 */
class InsightsStage implements Stage
{
    public function name(): ScanStage
    {
        return ScanStage::Insights;
    }

    public function run(ScanContext $context): array
    {
        $graph = $this->freshGraph($context);
        $classes = $context->readArtifact('classes')['classes'] ?? [];
        $insights = [];

        // These carry over to every language: they only look at the graph.
        $insights = array_merge($insights, $this->hotspots($graph));
        $insights = array_merge($insights, $this->orphans($graph));
        $insights = array_merge($insights, $this->fatClasses($graph));
        $insights = array_merge($insights, $this->layeringViolations($graph));
        $insights = array_merge($insights, $this->cycles($graph));
        $insights = array_merge($insights, $this->untested($graph));

        if ($context->isLaravel()) {
            // Eloquent, policies, migrations and blades only exist in Laravel.
            $insights = array_merge($insights, $this->missingPolicies($graph));
            $insights = array_merge($insights, $this->eagerLoadingRisks($graph, $classes));
            $insights = array_merge($insights, $this->debugLeftovers($context, $graph));
            $insights = array_merge($insights, $this->schemaGaps($graph));
        } else {
            // Compiled languages: interfaces, inheritance depth, dispatch.
            $insights = array_merge($insights, (new CxxInsights)->generate($context, $graph));
        }

        $metrics = [
            'insights' => [
                'total' => count($insights),
                'by_severity' => $this->countBy($insights, 'severity'),
                'by_category' => $this->countBy($insights, 'category'),
                // The full findings travel with the scan so the API can hand
                // them straight to the UI without a second request.
                'items' => $insights,
            ],
        ];

        $context->writeArtifact('insights', ['insights' => $insights]);
        $context->persistGraph($graph);

        $scan = $context->scan->refresh();
        $scan->update(['metrics' => array_merge($scan->metrics ?? [], $metrics)]);

        $context->log(sprintf(
            'Found %d architectural insights (%d high priority)',
            count($insights),
            count(array_filter($insights, fn ($i) => $i['severity'] === 'high'))
        ));

        return [
            'summary' => sprintf('%d insights · %d high', count($insights), count(array_filter($insights, fn ($i) => $i['severity'] === 'high'))),
            'metrics' => $metrics,
        ];
    }

    /** @return array<int, array> */
    private function hotspots(GraphBuilder $graph): array
    {
        $insights = [];
        $classes = $this->classNodes($graph);

        usort($classes, fn ($a, $b) => $b['degree'] <=> $a['degree']);

        foreach (array_slice($classes, 0, 3) as $node) {
            if ($node['degree'] < 8) {
                break;
            }

            $insights[] = $this->insight(
                id: 'hotspot:'.$node['key'],
                severity: $node['degree'] > 20 ? 'high' : 'medium',
                category: 'Coupling',
                title: $node['label'].' is a coupling hotspot',
                detail: sprintf(
                    '%s has %d incoming and %d outgoing relationships. It is the single most connected piece of the application, so changes here ripple the furthest.',
                    $node['label'],
                    $node['fan_in'],
                    $node['fan_out']
                ),
                action: 'Consider extracting the distinct responsibilities behind an interface before this class grows further.',
                nodes: [$node['key']],
            );
        }

        return $insights;
    }

    /** @return array<int, array> */
    private function orphans(GraphBuilder $graph): array
    {
        $orphans = [];

        foreach ($this->classNodes($graph) as $node) {
            $type = $node['type'];

            if (in_array($type, [NodeType::Test->value, NodeType::Interface_->value, NodeType::Trait_->value, NodeType::Enum->value, NodeType::Provider->value, NodeType::Observer->value], true)) {
                continue;
            }

            if ($node['fan_in'] === 0 && $node['fan_out'] === 0 && ($node['loc'] ?? 0) > 15) {
                $orphans[] = $node;
            }
        }

        if ($orphans === []) {
            return [];
        }

        usort($orphans, fn ($a, $b) => ($b['loc'] ?? 0) <=> ($a['loc'] ?? 0));

        return [$this->insight(
            id: 'orphans',
            severity: 'low',
            category: 'Dead code',
            title: count($orphans).' classes nothing else references',
            detail: 'These classes have no incoming or outgoing relationships in the graph: '.implode(', ', array_slice(array_map(fn ($n) => $n['label'], $orphans), 0, 8)).'. They may be unused, auto-discovered, or reachable only through string-based container resolution.',
            action: 'Confirm they are still needed, then delete or wire them explicitly.',
            nodes: array_slice(array_column($orphans, 'key'), 0, 20),
            count: count($orphans),
        )];
    }

    /** @return array<int, array> */
    private function fatClasses(GraphBuilder $graph): array
    {
        $insights = [];

        foreach ($this->classNodes($graph) as $node) {
            $methods = $node['meta']['methods'] ?? [];
            $heaviest = 0;

            foreach ($methods as $method) {
                $heaviest = max($heaviest, (int) ($method['loc'] ?? 0));
            }

            if (count($methods) >= 18 || $heaviest >= 90) {
                $insights[] = $this->insight(
                    id: 'fat:'.$node['key'],
                    severity: count($methods) >= 25 ? 'high' : 'medium',
                    category: 'Maintainability',
                    title: $node['label'].' is doing too much',
                    detail: sprintf(
                        'It exposes %d methods and its longest method runs for about %d lines. Classes of this size are hard to reason about and almost impossible to unit test in isolation.',
                        count($methods),
                        $heaviest
                    ),
                    action: 'Split the heaviest method into smaller, named steps or move a group of related methods into a service.',
                    nodes: [$node['key']],
                );
            }
        }

        return array_slice($insights, 0, 8);
    }

    /** @return array<int, array> */
    private function layeringViolations(GraphBuilder $graph): array
    {
        $violations = [];

        foreach ($graph->edges() as $edge) {
            $source = $graph->nodeOrNull($edge['source']);
            $target = $graph->nodeOrNull($edge['target']);

            if ($source === null || $target === null) {
                continue;
            }

            $from = $source['layer'] ?? null;
            $to = $target['layer'] ?? null;

            $isViolation = ($from === Layer::Domain->value && in_array($to, [Layer::Http->value, Layer::View->value], true))
                || ($from === Layer::Data->value && $to === Layer::Http->value);

            if ($isViolation) {
                $violations[] = [
                    'from' => $source['label'],
                    'to' => $target['label'],
                    'source_key' => $edge['source'],
                    'target_key' => $edge['target'],
                    'kind' => $edge['kind'],
                ];
            }
        }

        if ($violations === []) {
            return [];
        }

        $unique = [];
        foreach ($violations as $violation) {
            $unique[$violation['source_key'].'|'.$violation['target_key']] = $violation;
        }
        $violations = array_values($unique);

        $examples = implode(', ', array_slice(array_map(fn ($v) => $v['from'].' → '.$v['to'], $violations), 0, 4));

        return [$this->insight(
            id: 'layering',
            severity: 'medium',
            category: 'Architecture',
            title: count($violations).' layering violations',
            detail: 'Inner layers reach outward to outer ones: '.$examples.'. Domain and persistence code should not know about HTTP or presentation.',
            action: 'Introduce an interface owned by the inner layer and invert the dependency.',
            nodes: array_values(array_unique(array_merge(
                array_column($violations, 'source_key'),
                array_column($violations, 'target_key')
            ))),
            count: count($violations),
        )];
    }

    /** @return array<int, array> */
    private function cycles(GraphBuilder $graph): array
    {
        $adjacency = [];

        // Only *code* dependencies count. Eloquent relationships are naturally
        // bidirectional (Post belongsTo User, User hasMany Posts) and would
        // otherwise flood this report with false cycles.
        $dependencyKinds = [
            EdgeKind::Injects->value,
            EdgeKind::Extends->value,
            EdgeKind::Implements->value,
            EdgeKind::Dispatches->value,
            EdgeKind::Listens->value,
            EdgeKind::Provides->value,
        ];

        foreach ($graph->edges() as $edge) {
            if (! in_array($edge['kind'], $dependencyKinds, true)) {
                continue;
            }

            if (($graph->nodeOrNull($edge['source'])['layer'] ?? null) === Layer::Test->value) {
                continue;
            }

            $adjacency[$edge['source']][] = $edge['target'];
        }

        $index = 0;
        $stack = [];
        $onStack = [];
        $indices = [];
        $lowlink = [];
        $components = [];

        $strongConnect = function (string $node) use (&$strongConnect, &$index, &$stack, &$onStack, &$indices, &$lowlink, &$components, $adjacency): void {
            $indices[$node] = $index;
            $lowlink[$node] = $index;
            $index++;
            $stack[] = $node;
            $onStack[$node] = true;

            foreach ($adjacency[$node] ?? [] as $successor) {
                if (! isset($indices[$successor])) {
                    $strongConnect($successor);
                    $lowlink[$node] = min($lowlink[$node], $lowlink[$successor]);
                } elseif ($onStack[$successor] ?? false) {
                    $lowlink[$node] = min($lowlink[$node], $indices[$successor]);
                }
            }

            if ($lowlink[$node] === $indices[$node]) {
                $component = [];
                do {
                    $member = array_pop($stack);
                    $onStack[$member] = false;
                    $component[] = $member;
                } while ($member !== $node && $stack !== []);

                if (count($component) > 1 && count($component) <= 12) {
                    $components[] = $component;
                }
            }
        };

        foreach ($this->classNodes($graph) as $node) {
            if (! isset($indices[$node['key']])) {
                $strongConnect($node['key']);
            }
        }

        if ($components === []) {
            return [];
        }

        $insights = [];

        foreach (array_slice($components, 0, 5) as $component) {
            $labels = array_map(fn ($key) => $graph->nodeOrNull($key)['label'] ?? $key, $component);

            $insights[] = $this->insight(
                id: 'cycle:'.md5(implode(',', $component)),
                severity: 'medium',
                category: 'Architecture',
                title: 'Circular dependency of '.count($component).' classes',
                detail: implode(' → ', $labels).' → '.$labels[0].'. Circular couples make refactoring risky and can surprise the container.',
                action: 'Break the loop by introducing an interface, an event, or by moving the shared behaviour into a third class.',
                nodes: $component,
            );
        }

        return $insights;
    }

    /** @return array<int, array> */
    private function missingPolicies(GraphBuilder $graph): array
    {
        $missing = [];

        foreach ($graph->nodes() as $node) {
            if (($node['type'] ?? '') !== NodeType::Model->value) {
                continue;
            }

            $expected = 'class:App\\Policies\\'.$node['label'].'Policy';

            if (! $graph->has($expected)) {
                $missing[] = $node;
            }
        }

        $withAuth = array_filter($graph->nodes(), fn ($n) => str_contains(json_encode($n['meta'] ?? []), 'auth') || str_contains(json_encode($n['meta'] ?? []), 'authorize'));

        if ($missing === [] || count($withAuth) === 0) {
            return [];
        }

        return [$this->insight(
            id: 'policies',
            severity: 'low',
            category: 'Security',
            title: count($missing).' models without an explicit policy',
            detail: 'The project performs authorization checks, but these models have no matching App\\Policies class: '.implode(', ', array_slice(array_map(fn ($n) => $n['label'], $missing), 0, 10)).'.',
            action: 'Add a policy for each model that is exposed through a controller.',
            nodes: array_slice(array_column($missing, 'key'), 0, 20),
            count: count($missing),
        )];
    }

    /** @return array<int, array> */
    private function untested(GraphBuilder $graph): array
    {
        $tested = [];

        foreach ($graph->edges() as $edge) {
            if ($edge['kind'] === EdgeKind::Tests->value) {
                $tested[$edge['target']] = true;
            }
        }

        $untested = [];

        foreach ($this->classNodes($graph) as $node) {
            if (! in_array($node['type'], [NodeType::Controller->value, NodeType::Service->value, NodeType::Action->value, NodeType::Model->value, NodeType::Job->value], true)) {
                continue;
            }

            if (! isset($tested[$node['key']]) && ($node['loc'] ?? 0) > 20) {
                $untested[] = $node;
            }
        }

        if ($untested === [] || count($this->classNodes($graph)) < 12) {
            return [];
        }

        usort($untested, fn ($a, $b) => ($b['fan_in'] + $b['fan_out']) <=> ($a['fan_in'] + $a['fan_out']));

        return [$this->insight(
            id: 'untested',
            severity: 'low',
            category: 'Testing',
            title: count($untested).' significant classes with no test coverage',
            detail: 'No test in the suite references these class nodes: '.implode(', ', array_slice(array_map(fn ($n) => $n['label'], $untested), 0, 10)).'.',
            action: 'Start with the highest-traffic controllers — they carry the most risk.',
            nodes: array_slice(array_column($untested, 'key'), 0, 25),
            count: count($untested),
        )];
    }

    /**
     * Classic N+1 smell: a method loops over models and touches their
     * relationships, but never eager loads anything in the same method.
     *
     * @return array<int, array>
     */
    private function eagerLoadingRisks(GraphBuilder $graph, array $classes): array
    {
        $risks = [];

        foreach ($classes as $fqcn => $class) {
            $node = $graph->nodeOrNull('class:'.$fqcn);

            if ($node === null || ! in_array($node['type'] ?? '', [NodeType::Controller->value, NodeType::Service->value, NodeType::Livewire->value, NodeType::Job->value], true)) {
                continue;
            }

            foreach ($class['methods'] as $method) {
                if (! ($method['has_loop'] ?? false)) {
                    continue;
                }

                $eagerLoaded = false;

                foreach ($method['captures'] ?? [] as $capture) {
                    if (($capture['type'] ?? '') === 'eager_load') {
                        $eagerLoaded = true;
                    }
                }

                if ($eagerLoaded) {
                    continue;
                }

                // Loops over relation methods on a model ($task->project->name) are the risk.
                $relationAccess = false;
                foreach ($method['captures'] ?? [] as $capture) {
                    if (in_array($capture['type'] ?? '', ['paginate', 'eager_load'], true)) {
                        $relationAccess = true;
                    }
                }

                foreach (($node['meta']['methods'] ?? []) as $metaMethod) {
                    if (($metaMethod['name'] ?? null) !== $method['name']) {
                        continue;
                    }
                    foreach ($metaMethod['captures'] ?? [] as $capture) {
                        if (($capture['type'] ?? '') === 'eager_load') {
                            $eagerLoaded = true;
                        }
                    }
                }

                if ($eagerLoaded || ! $relationAccess) {
                    continue;
                }

                $risks[] = [
                    'class' => $class['label'],
                    'method' => $method['name'],
                    'key' => 'class:'.$fqcn,
                ];
            }
        }

        if ($risks === []) {
            return [];
        }

        $examples = implode(', ', array_slice(array_map(fn ($r) => $r['class'].'@'.$r['method'].'()', $risks), 0, 5));

        return [$this->insight(
            id: 'n_plus_one',
            severity: 'medium',
            category: 'Performance',
            title: 'Possible N+1 query patterns',
            detail: 'These methods loop over models and read related records without eager loading them in the same method: '.$examples.'. Every iteration can trigger an extra query.',
            action: "Eager load what the loop touches, e.g. Post::with('user')->get(), or use ->load() before iterating.",
            nodes: array_values(array_unique(array_column($risks, 'key'))),
            count: count($risks),
        )];
    }

    /** @return array<int, array> */
    private function debugLeftovers(ScanContext $context, GraphBuilder $graph): array
    {
        $index = $context->readArtifact('files');
        $hits = [];

        foreach ($index['files'] ?? [] as $file) {
            if ($file['ext'] !== 'php' || ! str_starts_with($file['path'], 'app/')) {
                continue;
            }

            $code = @file_get_contents($context->root.'/'.$file['path']);

            if ($code === false) {
                continue;
            }

            if (preg_match_all('/(?<![\w>])(dd|dump|var_dump|ray)\s*\(/', $code, $matches, PREG_OFFSET_CAPTURE)) {
                foreach ($matches[1] as $match) {
                    $line = substr_count(substr($code, 0, (int) $match[1]), "\n") + 1;
                    $hits[] = ['file' => $file['path'], 'line' => $line, 'call' => $match[0]];
                }
            }
        }

        if ($hits === []) {
            return [];
        }

        return [$this->insight(
            id: 'debug_leftovers',
            severity: 'medium',
            category: 'Hygiene',
            title: count($hits).' debug statements left in app code',
            detail: implode(', ', array_slice(array_map(fn ($h) => $h['file'].':'.$h['line'].' ('.$h['call'].')', $hits), 0, 6)),
            action: 'Remove dd()/dump() calls before shipping, or use Log::debug() instead.',
            nodes: [],
            count: count($hits),
        )];
    }

    /** @return array<int, array> */
    private function schemaGaps(GraphBuilder $graph): array
    {
        $insights = [];
        $noMigration = [];
        $noModel = [];

        foreach ($graph->nodes() as $node) {
            if (($node['type'] ?? '') !== NodeType::Table->value) {
                continue;
            }

            $meta = $node['meta'] ?? [];

            if (($meta['migration_missing'] ?? false) === true) {
                $noMigration[] = $node;
            }
        }

        $modelTables = [];
        foreach ($graph->nodes() as $node) {
            if (($node['type'] ?? '') === NodeType::Model->value) {
                $modelTables['table:'.($node['meta']['table'] ?? '')] = true;
            }
        }

        foreach ($graph->nodes() as $node) {
            if (($node['type'] ?? '') !== NodeType::Table->value) {
                continue;
            }

            $frameworkTables = ['migrations', 'password_reset_tokens', 'sessions', 'cache', 'cache_locks', 'jobs', 'job_batches', 'failed_jobs', 'personal_access_tokens'];

            if (isset($modelTables[$node['key']]) || in_array($node['label'], $frameworkTables, true)) {
                continue;
            }

            // Pivot tables (project_user, tag_task) legitimately have no model.
            if ($this->looksLikePivot($node['label'], array_keys($modelTables))) {
                continue;
            }

            $noModel[] = $node;
        }

        if ($noMigration !== []) {
            $insights[] = $this->insight(
                id: 'tables_without_migration',
                severity: 'low',
                category: 'Database',
                title: count($noMigration).' tables with no migration',
                detail: 'Models point at '.implode(', ', array_slice(array_map(fn ($n) => $n['label'], $noMigration), 0, 8)).' but no migration creates them. They may be legacy tables or created outside migrations.',
                action: 'Generate migrations so the schema is reproducible from a clean checkout.',
                nodes: array_slice(array_column($noMigration, 'key'), 0, 15),
                count: count($noMigration),
            );
        }

        if (count($noModel) >= 3) {
            $insights[] = $this->insight(
                id: 'tables_without_model',
                severity: 'low',
                category: 'Database',
                title: count($noModel).' tables without an Eloquent model',
                detail: implode(', ', array_slice(array_map(fn ($n) => $n['label'], $noModel), 0, 10)).' exist in the schema but have no model class. Query builders or raw SQL may be used against them.',
                action: 'Either add models or confirm the tables are framework-owned.',
                nodes: array_slice(array_column($noModel, 'key'), 0, 15),
                count: count($noModel),
            );
        }

        return $insights;
    }

    /**
     * Heuristic: a table whose name is two model table names joined by an
     * underscore is almost always a pivot table.
     */
    private function looksLikePivot(string $table, array $modelTableKeys): bool
    {
        $known = array_map(fn (string $key) => substr($key, strlen('table:')), $modelTableKeys);

        if (in_array($table, $known, true)) {
            return false;
        }

        $parts = explode('_', $table);

        if (count($parts) !== 2) {
            return false;
        }

        return in_array($parts[0], $known, true) && in_array($parts[1], $known, true);
    }

    /** @return array<int, array> */
    private function classNodes(GraphBuilder $graph): array
    {
        $out = [];

        foreach ($graph->nodes() as $node) {
            if (! isset($node['fqcn']) || $node['fqcn'] === null) {
                continue;
            }

            $node['degree'] = (int) ($node['fan_in'] ?? 0) + (int) ($node['fan_out'] ?? 0);
            $node['type'] = $node['type'] ?? NodeType::PhpClass->value;
            $out[] = $node;
        }

        return $out;
    }

    private function insight(string $id, string $severity, string $category, string $title, string $detail, string $action, array $nodes, int $count = 1): array
    {
        return [
            'id' => $id,
            'severity' => $severity,
            'category' => $category,
            'title' => $title,
            'detail' => $detail,
            'action' => $action,
            'nodes' => array_values(array_unique($nodes)),
            'count' => $count,
        ];
    }

    private function countBy(array $items, string $field): array
    {
        $out = [];

        foreach ($items as $item) {
            $key = $item[$field] ?? 'unknown';
            $out[$key] = ($out[$key] ?? 0) + 1;
        }

        arsort($out);

        return $out;
    }

    private function freshGraph(ScanContext $context): GraphBuilder
    {
        $graph = new GraphBuilder;
        $payload = $context->readArtifact('graph');

        foreach ($payload['nodes'] ?? [] as $node) {
            $graph->node($node['key'], NodeType::tryFrom($node['type']) ?? NodeType::PhpClass, $node['label'], $node);
        }
        foreach ($payload['edges'] ?? [] as $edge) {
            $graph->edge($edge['source'], $edge['target'], EdgeKind::tryFrom($edge['kind']) ?? EdgeKind::Uses, $edge);
        }

        return $graph;
    }
}
