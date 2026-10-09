<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 10 — project the graph into 3D space.
 *
 * Each architectural layer becomes a horizontal deck. Inside a deck, nodes are
 * laid out with a golden-angle (sunflower) spiral after being sorted by module,
 * which clusters related code together and guarantees even spacing without a
 * simulation — the layout is therefore deterministic and identical on every
 * machine, and the coordinates stay stable between scans of the same project.
 */
class LayoutStage implements Stage
{
    /**
     * Vertical gap between two architectural decks. Kept moderate so the whole
     * stack fits a widescreen stage without the nodes shrinking to specks —
     * a taller stack looks impressive but reads far worse.
     */
    private const TIER_HEIGHT = 104.0;

    private const GOLDEN_ANGLE = 2.399963229728653;

    public function name(): ScanStage
    {
        return ScanStage::Layout;
    }

    public function run(ScanContext $context): array
    {
        $graph = $this->freshGraph($context);
        $nodes = $graph->nodes();

        $buckets = [];

        foreach ($nodes as $key => $node) {
            $layer = Layer::tryFrom($node['layer'] ?? '') ?? Layer::Application;
            $buckets[$layer->tierSlot()][] = $node;
        }

        ksort($buckets);

        $slotCount = max(array_key_exists(0, $buckets) ? max(array_keys($buckets)) + 1 : 0, 1);
        $centreOffset = ($slotCount - 1) * self::TIER_HEIGHT / 2;

        $positions = [];
        $clusters = [];

        foreach ($buckets as $slot => $tierNodes) {
            $y = -($slot * self::TIER_HEIGHT) + $centreOffset;

            // Sort by module, then by importance: related nodes end up adjacent
            // on the spiral and therefore visually grouped.
            usort($tierNodes, function (array $a, array $b) {
                $moduleCompare = strcmp((string) ($a['module'] ?? ''), (string) ($b['module'] ?? ''));

                if ($moduleCompare !== 0) {
                    return $moduleCompare;
                }

                return ($b['weight'] ?? 0) <=> ($a['weight'] ?? 0);
            });

            $count = count($tierNodes);
            $spacing = $count > 160 ? 17.0 : ($count > 80 ? 21.0 : 26.0);

            foreach ($tierNodes as $index => $node) {
                $angle = $index * self::GOLDEN_ANGLE;
                $radius = $spacing * sqrt($index + 1);

                $x = cos($angle) * $radius;
                $z = sin($angle) * $radius;

                $importance = (int) ($node['weight'] ?? 35);
                $degree = (int) ($node['fan_in'] ?? 0) + (int) ($node['fan_out'] ?? 0);

                // Final visual weight blends authored importance with real usage.
                $finalWeight = (int) round(min(100, max(14, $importance * 0.72 + min(30, log(max(1, $degree) + 1) * 9))));

                $positions[$node['key']] = [
                    'pos_x' => round($x, 2),
                    'pos_y' => round($y + ($finalWeight - 45) / 45 * 8, 2),
                    'pos_z' => round($z, 2),
                    'weight' => $finalWeight,
                    'meta' => [
                        'cluster' => $node['module'] ?? 'App',
                        'tier' => $slot,
                        'radius' => round(sqrt($x * $x + $z * $z), 2),
                        'degree' => $degree,
                        'hub' => $degree >= 8,
                    ],
                ];

                $clusters[$node['module'] ?? 'App'] = ($clusters[$node['module'] ?? 'App'] ?? 0) + 1;
            }
        }

        // Write positions back into the graph.
        foreach ($positions as $key => $position) {
            $node = $graph->nodeOrNull($key);

            if ($node === null) {
                continue;
            }

            $graph->node($key, NodeType::tryFrom($node['type']) ?? NodeType::PhpClass, $node['label'], array_merge($node, [
                'pos_x' => $position['pos_x'],
                'pos_y' => $position['pos_y'],
                'pos_z' => $position['pos_z'],
                'weight' => $position['weight'],
                'meta' => array_merge($node['meta'] ?? [], $position['meta']),
            ]));
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $bounds = $this->bounds($positions);

        $context->writeArtifact('layout', [
            'positions' => $positions,
            'clusters' => $clusters,
            'bounds' => $bounds,
            'tiers' => collect($buckets)->map(fn (array $nodes) => count($nodes))->all(),
        ]);

        $context->log(sprintf('Projected %s nodes into %s tiers', number_format(count($positions)), count($buckets)));

        return [
            'summary' => sprintf('%s nodes across %s tiers · %s clusters', number_format(count($positions)), count($buckets), count($clusters)),
            'metrics' => [
                'clusters' => $clusters,
                'bounds' => $bounds,
                'tiers' => count($buckets),
            ],
        ];
    }

    private function bounds(array $positions): array
    {
        $xs = array_column($positions, 'pos_x');
        $ys = array_column($positions, 'pos_y');
        $zs = array_column($positions, 'pos_z');

        if ($xs === []) {
            return ['x' => 0, 'y' => 0, 'z' => 0, 'radius' => 0];
        }

        return [
            'x' => [round(min($xs), 1), round(max($xs), 1)],
            'y' => [round(min($ys), 1), round(max($ys), 1)],
            'z' => [round(min($zs), 1), round(max($zs), 1)],
            'radius' => round(max(array_map(fn ($p) => sqrt($p['pos_x'] ** 2 + $p['pos_z'] ** 2), $positions)), 1),
        ];
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
