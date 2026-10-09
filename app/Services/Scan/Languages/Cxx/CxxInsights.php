<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx;

use App\Enums\EdgeKind;
use App\Enums\NodeType;
use App\Services\Scan\ScanContext;
use App\Support\GraphBuilder;

/**
 * The architectural findings that only make sense for compiled, statically
 * typed code.
 *
 * Laravel's insights are about routes, Eloquent and migrations; a C++ or C#
 * project has no such things, but it has interfaces that are expensive to
 * implement, inheritance chains deep enough to be fragile, and dynamic
 * dispatch that hides its own call graph. Those are the things worth telling a
 * reader about, so they are checked here and merged into the same insight feed
 * the Laravel pipeline fills.
 */
class CxxInsights
{
    private const MAX_INTERFACE_MEMBERS = 10;

    private const MAX_INHERITANCE_DEPTH = 3;

    /** @return array<int, array> */
    public function generate(ScanContext $context, GraphBuilder $graph): array
    {
        return array_merge(
            $this->wideInterfaces($graph),
            $this->deepInheritance($graph),
            $this->externalBases($graph),
            $this->dynamicDispatch($context),
        );
    }

    /** @return array<int, array> */
    private function wideInterfaces(GraphBuilder $graph): array
    {
        $insights = [];

        foreach ($graph->nodes() as $node) {
            if (($node['type'] ?? '') !== NodeType::Interface_->value) {
                continue;
            }

            $count = (int) ($node['meta']['member_count'] ?? count($node['meta']['members'] ?? []));

            if ($count <= self::MAX_INTERFACE_MEMBERS) {
                continue;
            }

            $insights[] = $this->insight(
                id: 'wide-interface:'.$node['key'],
                severity: $count > 25 ? 'high' : 'medium',
                category: 'Design',
                title: $node['label'].' is a wide interface',
                detail: sprintf(
                    '%s declares %d members, so every implementation must satisfy all of them — including the implementations that need only a few.',
                    $node['label'],
                    $count,
                ),
                action: 'Split it along the axes that vary together, or provide a default implementation for the parts most callers ignore.',
                nodes: [$node['key']],
            );
        }

        return $insights;
    }

    /** @return array<int, array> */
    private function deepInheritance(GraphBuilder $graph): array
    {
        $insights = [];
        $extends = [];

        foreach ($graph->edges() as $edge) {
            if (($edge['kind'] ?? '') === EdgeKind::Extends->value) {
                $extends[$edge['source']][] = $edge['target'];
            }
        }

        foreach (array_keys($extends) as $key) {
            $depth = $this->depth($key, $extends, 0);

            if ($depth <= self::MAX_INHERITANCE_DEPTH) {
                continue;
            }

            $node = $graph->nodeOrNull($key);

            if ($node === null) {
                continue;
            }

            $insights[] = $this->insight(
                id: 'deep-inheritance:'.$key,
                severity: $depth > 5 ? 'high' : 'medium',
                category: 'Design',
                title: $node['label'].' sits '.$depth.' levels deep',
                detail: sprintf(
                    '%s inherits through %d levels, so a change near the top of that chain touches almost everything below it.',
                    $node['label'],
                    $depth,
                ),
                action: 'Favour composition for the behaviour that varies; keep inheritance for the parts that genuinely are the same thing.',
                nodes: [$key],
            );
        }

        return array_slice($insights, 0, 5);
    }

    /** Bases that live outside the project — worth knowing, not a problem. */
    private function externalBases(GraphBuilder $graph): array
    {
        $externals = [];

        foreach ($graph->nodes() as $node) {
            if (($node['meta']['rule'] ?? '') !== 'unresolved-base') {
                continue;
            }

            $externals[$node['label']] = $node['key'];
        }

        if (count($externals) < 3) {
            return [];
        }

        $names = array_slice(array_keys($externals), 0, 6);

        return [$this->insight(
            id: 'external-bases',
            severity: 'low',
            category: 'Dependencies',
            title: count($externals).' base types come from outside the project',
            detail: sprintf(
                'These types are inherited or implemented but never declared here: %s%s. They are frameworks or third-party libraries, so their behaviour is fixed.',
                implode(', ', $names),
                count($externals) > count($names) ? ' and more' : '',
            ),
            action: 'Keep new behaviour behind your own interfaces where the third-party base is likely to change.',
            nodes: array_values($externals),
            count: count($externals),
        )];
    }

    /** Unresolved call sites are a real limitation of reading code statically. */
    private function dynamicDispatch(ScanContext $context): array
    {
        $metrics = $context->scan->refresh()->metrics['calls'] ?? [];
        $total = (int) ($metrics['calls'] ?? 0);
        $unresolved = (int) ($metrics['unresolved'] ?? 0);

        if ($total < 25 || $unresolved < 40 || $unresolved / max($total, 1) < 0.4) {
            return [];
        }

        return [$this->insight(
            id: 'unresolved-calls',
            severity: 'low',
            category: 'Coverage',
            title: sprintf('%d of %d call sites could not be resolved', $unresolved, $total),
            detail: 'Calls through interfaces, function pointers and delegates cannot be followed from syntax alone, so those edges are missing from the map rather than wrong.',
            action: 'Read the unresolved calls as "dynamic dispatch happens here" — the brighter hubs in the graph are where it concentrates.',
            nodes: [],
            count: $unresolved,
        )];
    }

    private function depth(string $key, array $extends, int $depth): int
    {
        if ($depth > 12 || ! isset($extends[$key])) {
            return $depth;
        }

        $best = $depth;

        foreach ($extends[$key] as $parent) {
            $best = max($best, $this->depth($parent, $extends, $depth + 1));
        }

        return $best;
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
            'nodes' => $nodes,
            'count' => $count,
        ];
    }
}
