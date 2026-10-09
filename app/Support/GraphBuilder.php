<?php

declare(strict_types=1);

namespace App\Support;

use App\Enums\EdgeKind;
use App\Enums\NodeType;

/**
 * Mutable, in-memory graph used while a scan is running.
 *
 * Nodes are keyed by a stable string ("class:App\Models\User") so any stage can
 * reference artefacts other stages may or may not have created yet. Edges are
 * de-duplicated on (source, target, kind) and accumulate a hit counter, which
 * makes "this controller calls that service 7 times" visible as a thicker line.
 */
class GraphBuilder
{
    /** @var array<string, array> */
    private array $nodes = [];

    /** @var array<string, array> */
    private array $edges = [];

    /** @var array<string, int> */
    private array $edgeOrder = [];

    private int $edgeSequence = 0;

    public function node(string $key, NodeType $type, string $label, array $attributes = []): array
    {
        if (isset($this->nodes[$key])) {
            // Merge: later stages enrich earlier discoveries.
            $this->nodes[$key] = $this->mergeNode($this->nodes[$key], $attributes);
            $this->nodes[$key]['type'] = $attributes['type'] ?? $this->nodes[$key]['type'];
            if ($label !== '') {
                $this->nodes[$key]['label'] = $label;
            }

            return $this->nodes[$key];
        }

        $layer = $attributes['layer'] ?? $type->layer()->value;

        $node = array_merge([
            'key' => $key,
            'type' => $type->value,
            'layer' => $layer,
            'label' => $label !== '' ? $label : $key,
            'fqcn' => null,
            'file' => null,
            'line' => null,
            'module' => null,
            'parent' => null,
            'weight' => $type->importance(),
            'loc' => 0,
            'meta' => [],
        ], array_filter($attributes, fn ($v) => $v !== null));

        $node['type'] = $type->value;
        $node['meta'] = array_merge($attributes['meta'] ?? [], ['glyph' => $type->glyph()]);

        $this->nodes[$key] = $node;

        return $node;
    }

    public function has(string $key): bool
    {
        return isset($this->nodes[$key]);
    }

    public function nodeOrNull(string $key): ?array
    {
        return $this->nodes[$key] ?? null;
    }

    public function typeOf(string $key): ?NodeType
    {
        $type = $this->nodes[$key]['type'] ?? null;

        return $type ? NodeType::tryFrom($type) : null;
    }

    /** Ensure a node exists, guessing sensible defaults when it does not. */
    public function touch(string $key, string $label = '', array $attributes = []): array
    {
        if (isset($this->nodes[$key])) {
            return $this->nodes[$key];
        }

        $type = NodeType::tryFrom($attributes['type'] ?? explode(':', $key, 2)[0]) ?? NodeType::Interface_;

        return $this->node($key, $type, $label !== '' ? $label : $this->labelFromKey($key), $attributes);
    }

    public function edge(string $source, string $target, EdgeKind $kind, array $attributes = []): void
    {
        if ($source === '' || $target === '' || $source === $target) {
            return;
        }

        $hash = $source.'|'.$target.'|'.$kind->value;

        if (isset($this->edges[$hash])) {
            $this->edges[$hash]['hits']++;
            if (isset($attributes['label'])) {
                $this->edges[$hash]['label'] = $attributes['label'];
            }

            return;
        }

        $this->edges[$hash] = [
            'source' => $source,
            'target' => $target,
            'kind' => $kind->value,
            'label' => $attributes['label'] ?? $kind->label(),
            'weight' => $attributes['weight'] ?? $kind->weight(),
            'hits' => 1,
            'meta' => $attributes['meta'] ?? [],
            '_order' => $this->edgeSequence++,
        ];

        $this->edgeOrder[$hash] = $this->edgeSequence;
    }

    public function removeNode(string $key): void
    {
        unset($this->nodes[$key]);

        foreach ($this->edges as $hash => $edge) {
            if ($edge['source'] === $key || $edge['target'] === $key) {
                unset($this->edges[$hash]);
            }
        }
    }

    public function dropEdge(string $source, string $target, ?EdgeKind $kind = null): void
    {
        foreach ($this->edges as $hash => $edge) {
            if ($edge['source'] !== $source || $edge['target'] !== $target) {
                continue;
            }
            if ($kind === null || $edge['kind'] === $kind->value) {
                unset($this->edges[$hash]);
            }
        }
    }

    /** @return array<string, array> */
    public function nodes(): array
    {
        return $this->nodes;
    }

    /** @return array<int, array> */
    public function edges(): array
    {
        return array_values($this->edges);
    }

    public function nodeCount(): int
    {
        return count($this->nodes);
    }

    public function edgeCount(): int
    {
        return count($this->edges);
    }

    /**
     * Drop edges pointing at keys that never materialised, then compute
     * fan-in / fan-out degrees used for sizing and insight detection.
     */
    public function pruneAndScore(): void
    {
        foreach ($this->edges as $hash => $edge) {
            if (! isset($this->nodes[$edge['source']]) || ! isset($this->nodes[$edge['target']])) {
                unset($this->edges[$hash]);

                continue;
            }

            $this->edges[$hash]['weight'] = round(
                max(0.35, $this->edges[$hash]['weight'] * (1 + log10(max(1, $this->edges[$hash]['hits'])))),
                2
            );
        }

        foreach ($this->nodes as $key => $node) {
            $this->nodes[$key]['fan_in'] = 0;
            $this->nodes[$key]['fan_out'] = 0;
        }

        foreach ($this->edges as $edge) {
            if ($edge['kind'] === EdgeKind::Groups->value) {
                continue; // directory containment must not inflate importance
            }

            $this->nodes[$edge['source']]['fan_out'] = ($this->nodes[$edge['source']]['fan_out'] ?? 0) + 1;
            $this->nodes[$edge['target']]['fan_in'] = ($this->nodes[$edge['target']]['fan_in'] ?? 0) + 1;
        }
    }

    public function toArray(): array
    {
        return ['nodes' => array_values($this->nodes), 'edges' => array_values($this->edges)];
    }

    public static function labelFromKey(string $key): string
    {
        $parts = explode(':', $key, 2);
        $tail = $parts[1] ?? $key;

        if (str_contains($tail, '\\')) {
            $segments = explode('\\', $tail);

            return end($segments) ?: $tail;
        }

        $segments = explode('/', $tail);

        return end($segments) ?: $tail;
    }

    private function mergeNode(array $existing, array $attributes): array
    {
        foreach (['fqcn', 'file', 'line', 'module', 'parent'] as $field) {
            if (! empty($attributes[$field]) && empty($existing[$field])) {
                $existing[$field] = $attributes[$field];
            }
        }

        // Positions are written by the layout stage long after the node was
        // first discovered, so they have to survive this merge explicitly —
        // otherwise every coordinate collapses back to the origin.
        foreach (['pos_x', 'pos_y', 'pos_z'] as $coordinate) {
            if (isset($attributes[$coordinate])) {
                $existing[$coordinate] = $attributes[$coordinate];
            }
        }

        if (isset($attributes['weight'])) {
            $existing['weight'] = max((int) $existing['weight'], (int) $attributes['weight']);
        }

        if (isset($attributes['loc'])) {
            $existing['loc'] = max((int) ($existing['loc'] ?? 0), (int) $attributes['loc']);
        }

        if (! empty($attributes['label']) && mb_strlen($attributes['label']) > mb_strlen((string) $existing['label'])) {
            $existing['label'] = $attributes['label'];
        }

        $existing['meta'] = array_replace_recursive($existing['meta'] ?? [], $attributes['meta'] ?? []);

        return $existing;
    }
}
