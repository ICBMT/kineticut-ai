<?php

declare(strict_types=1);

namespace App\Services;

use App\Enums\EdgeKind;
use App\Enums\Language;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Models\GraphEdge;
use App\Models\GraphNode;
use App\Models\Project;
use App\Models\Scan;
use Illuminate\Support\Collection;

/**
 * Shapes the stored graph into the compact payload the 3D renderer consumes.
 *
 * The full node metadata (methods, columns, relations…) stays in the database
 * and is fetched on demand per node — a scan of a large application would
 * otherwise ship megabytes of JSON before the first frame is drawn.
 */
class GraphPayload
{
    public function build(Project $project, Scan $scan, array $options = []): array
    {
        $maxNodes = (int) ($options['max_nodes'] ?? config('atlas.max_render_nodes', 2500));
        $maxEdges = (int) ($options['max_edges'] ?? config('atlas.max_render_edges', 6000));

        $nodes = GraphNode::where('scan_id', $scan->id)
            ->orderByDesc('weight')
            ->get();

        $truncatedNodes = false;

        if ($nodes->count() > $maxNodes) {
            $nodes = $nodes->take($maxNodes);
            $truncatedNodes = true;
        }

        $nodeKeys = $nodes->pluck('node_key')->all();

        $edges = GraphEdge::where('scan_id', $scan->id)
            ->orderByDesc('weight')
            ->get()
            ->filter(fn (GraphEdge $edge) => in_array($edge->source_key, $nodeKeys, true) && in_array($edge->target_key, $nodeKeys, true))
            ->values();

        $truncatedEdges = false;

        if ($edges->count() > $maxEdges) {
            $edges = $edges->take($maxEdges);
            $truncatedEdges = true;
        }

        // Node type labels are spoken in the project's language: a Django model
        // is a Model, not an Eloquent Model.
        $language = $project->language();

        return [
            'generated_at' => now()->toIso8601String(),
            'project' => [
                'uuid' => $project->uuid,
                'name' => $project->displayName(),
                'language' => $project->language,
                'language_label' => $project->language()->label(),
                'language_color' => $project->language()->color(),
                'framework_version' => $project->framework_version,
                'php_constraint' => $project->php_constraint,
                'composer_name' => $project->composer_name,
                'description' => $project->composer_description,
                'source_type' => $project->source_type,
                'file_count' => $project->file_count,
                'loc' => $project->loc,
                'size' => $project->sizeForHumans(),
                'package_count' => $project->package_count,
                'last_scanned_at' => optional($project->last_scanned_at)->toIso8601String(),
                // The tech strip reads the same object the atlas view does, so
                // a page that boots straight from the API still knows what the
                // project is built on.
                'stack' => app(\App\Services\TechStack::class)->build($project, $scan),
            ],
            'scan' => [
                'id' => $scan->id,
                'status' => $scan->status->value,
                'duration_ms' => $scan->duration_ms,
                'finished_at' => optional($scan->finished_at)->toIso8601String(),
            ],
            'nodes' => $nodes->map(fn (GraphNode $node) => $this->node($node, $language))->values()->all(),
            'edges' => $edges->map(fn (GraphEdge $edge) => [
                'source' => $edge->source_key,
                'target' => $edge->target_key,
                'kind' => $edge->kind->value,
                'kind_label' => $edge->kind->label(),
                'color' => $edge->kind->color(),
                'weight' => (float) $edge->weight,
                'hits' => (int) $edge->hits,
                'label' => $edge->label,
                'flow' => $edge->kind->isFlow(),
                'meta' => $edge->meta ?? [],
            ])->values()->all(),
            'layers' => $this->layers($nodes),
            'types' => $this->types($nodes, $language),
            'clusters' => $this->clusters($nodes),
            'edge_kinds' => $this->edgeKinds($edges),
            'metrics' => $scan->metrics ?? [],
            'insights' => $scan->metrics['insights']['items'] ?? [],
            'limits' => [
                'max_nodes' => $maxNodes,
                'max_edges' => $maxEdges,
                'truncated_nodes' => $truncatedNodes,
                'truncated_edges' => $truncatedEdges,
                'total_nodes' => GraphNode::where('scan_id', $scan->id)->count(),
                'total_edges' => GraphEdge::where('scan_id', $scan->id)->count(),
            ],
        ];
    }

    private function node(GraphNode $node, ?Language $language = null): array
    {
        return [
            'key' => $node->node_key,
            'label' => $node->label,
            'type' => $node->type->value,
            'type_label' => $node->type->label($language),
            'glyph' => $node->type->glyph(),
            'layer' => $node->layer->value,
            'layer_label' => $node->layer->label(),
            'color' => $node->layer->color(),
            'module' => $node->module,
            'file' => $node->file_path,
            'line' => $node->line,
            'fqcn' => $node->fqcn,
            'loc' => (int) $node->loc,
            'size' => round(0.45 + ((int) $node->weight / 100) * 1.35, 3),
            'weight' => (int) $node->weight,
            'fan_in' => (int) $node->fan_in,
            'fan_out' => (int) $node->fan_out,
            'degree' => (int) $node->fan_in + (int) $node->fan_out,
            'x' => (float) $node->pos_x,
            'y' => (float) $node->pos_y,
            'z' => (float) $node->pos_z,
            'parent' => $node->parent_key,
            'summary' => $this->summary($node),
        ];
    }

    /** A one-line description used by tooltips and the explorer list. */
    private function summary(GraphNode $node): ?string
    {
        $meta = $node->meta ?? [];

        return match ($node->type) {
            NodeType::Route => trim(($meta['method'] ?? 'GET').' '.($meta['uri'] ?? '')),
            NodeType::Model => isset($meta['table']) ? 'table: '.$meta['table'] : null,
            NodeType::Table => isset($meta['column_count']) ? $meta['column_count'].' columns' : null,
            NodeType::View => $meta['view_name'] ?? null,
            NodeType::Controller, NodeType::Service, NodeType::Action, NodeType::Job => isset($meta['method_count']) ? $meta['method_count'].' methods' : null,
            NodeType::Middleware => isset($meta['alias']) ? 'alias: '.($meta['alias'] ?: '—') : null,
            NodeType::Command => $meta['signature'] ?? null,
            NodeType::Package => isset($meta['usages']) ? $meta['usages'].' usages' : null,
            default => isset($meta['namespace']) ? $meta['namespace'] : null,
        };
    }

    /** Layer statistics for the legend / filter rail. */
    private function layers(Collection $nodes): array
    {
        $grouped = $nodes->groupBy(fn (GraphNode $node) => $node->layer->value);

        $out = [];

        foreach (Layer::cases() as $layer) {
            $count = $grouped->get($layer->value)?->count() ?? 0;

            if ($count === 0) {
                continue;
            }

            $out[] = [
                'value' => $layer->value,
                'label' => $layer->label(),
                'description' => $layer->description(),
                'color' => $layer->color(),
                'tier' => $layer->tierSlot(),
                'count' => $count,
                'runtime' => in_array($layer, [Layer::Entry, Layer::Http, Layer::Application, Layer::Domain, Layer::Data, Layer::View], true),
            ];
        }

        return $out;
    }

    private function types(Collection $nodes, ?Language $language = null): array
    {
        $grouped = $nodes->groupBy(fn (GraphNode $node) => $node->type->value);

        $out = [];

        foreach (NodeType::cases() as $type) {
            $count = $grouped->get($type->value)?->count() ?? 0;

            if ($count === 0) {
                continue;
            }

            $out[] = [
                'value' => $type->value,
                'label' => $type->label($language),
                'glyph' => $type->glyph(),
                'layer' => $type->layer()->value,
                'color' => $type->layer()->color(),
                'count' => $count,
                'runtime' => $type->isRuntimeFacing(),
            ];
        }

        usort($out, fn ($a, $b) => $b['count'] <=> $a['count']);

        return $out;
    }

    private function clusters(Collection $nodes): array
    {
        return $nodes
            ->filter(fn (GraphNode $node) => $node->module !== null)
            ->groupBy('module')
            ->map(fn (Collection $group, string $module) => [
                'name' => $module,
                'count' => $group->count(),
                'layer' => $group->first()->layer->value,
            ])
            ->sortByDesc('count')
            ->values()
            ->all();
    }

    private function edgeKinds(Collection $edges): array
    {
        return $edges
            ->groupBy(fn (GraphEdge $edge) => $edge->kind->value)
            ->map(fn (Collection $group, string $kind) => [
                'value' => $kind,
                'label' => EdgeKind::from($kind)->label(),
                'color' => EdgeKind::from($kind)->color(),
                'count' => $group->count(),
                'flow' => EdgeKind::from($kind)->isFlow(),
            ])
            ->sortByDesc('count')
            ->values()
            ->all();
    }
}
