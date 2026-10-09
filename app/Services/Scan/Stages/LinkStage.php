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
use App\Support\NameResolver;
use Illuminate\Support\Str;

/**
 * Stage 8 — the connective tissue. Now that every class, route, view and table
 * is known, this stage resolves cross-file references into real edges:
 * dependency injection, inheritance, route-name lookups from views, tests
 * pointing at the code they cover and composer packages that are actually used.
 */
class LinkStage implements Stage
{
    public function name(): ScanStage
    {
        return ScanStage::Links;
    }

    public function run(ScanContext $context): array
    {
        $classes = $context->readArtifact('classes')['classes'] ?? [];
        $routes = $context->readArtifact('routes');
        $manifest = $context->readArtifact('manifest');
        $graph = $this->freshGraph($context);

        $created = 0;
        $created += $this->linkClassReferences($graph, $classes);
        $created += $this->linkInheritance($graph, $classes);
        $created += $this->linkRouteNames($graph, $classes, $routes);
        $created += $this->linkTests($graph, $classes, $routes);
        $created += $this->linkProvidersAndObservers($graph, $classes);
        $created += $this->linkPackages($graph, $classes, $manifest);

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->log(sprintf('Resolved %s additional relationships', number_format($created)));

        return [
            'summary' => sprintf('%s links resolved', number_format($created)),
            'metrics' => ['links_resolved' => $created],
        ];
    }

    /** Every internal class a class mentions becomes a Uses / Injects edge. */
    private function linkClassReferences(GraphBuilder $graph, array $classes): int
    {
        $count = 0;

        foreach ($classes as $fqcn => $class) {
            $key = 'class:'.$fqcn;

            if (! $graph->has($key)) {
                continue;
            }

            $injected = [];

            foreach ($class['methods'] as $method) {
                foreach ($method['params'] as $param) {
                    $type = $param['type'] ?? null;
                    if (is_string($type) && $type !== '' && ! NameResolver::isBuiltin($type)) {
                        $injected[$this->normalize($type, $class)] = true;
                    }
                }
            }

            foreach ($class['properties'] as $property) {
                $type = $property['type'] ?? null;
                if (is_string($type) && $type !== '' && ! NameResolver::isBuiltin($type) && ! in_array($type, ['int', 'string', 'bool', 'array'], true)) {
                    $injected[$this->normalize($type, $class)] = true;
                }
            }

            $references = array_merge(
                $class['type_refs'] ?? [],
                $class['static_calls'] ?? [],
                $class['instantiated'] ?? [],
                $class['class_const_refs'] ?? [],
            );

            foreach (array_unique(array_filter($references)) as $reference) {
                $target = $this->resolveReference((string) $reference, $class);

                if ($target === null || $target === $fqcn) {
                    continue;
                }

                $targetKey = 'class:'.$target;

                if (! $graph->has($targetKey)) {
                    continue;
                }

                $kind = isset($injected[$target]) ? EdgeKind::Injects : EdgeKind::Uses;

                $graph->edge($key, $targetKey, $kind, [
                    'label' => $kind === EdgeKind::Injects ? 'injects' : 'uses',
                ]);
                $count++;
            }
        }

        return $count;
    }

    private function linkInheritance(GraphBuilder $graph, array $classes): int
    {
        $count = 0;

        foreach ($classes as $fqcn => $class) {
            $key = 'class:'.$fqcn;

            if (! $graph->has($key)) {
                continue;
            }

            if (! empty($class['extends'])) {
                $parent = $this->resolveReference((string) $class['extends'], $class, true);
                if ($parent !== null && $graph->has('class:'.$parent)) {
                    $graph->edge($key, 'class:'.$parent, EdgeKind::Extends, ['label' => 'extends']);
                    $count++;
                }
            }

            foreach ($class['implements'] ?? [] as $interface) {
                $resolved = $this->resolveReference((string) $interface, $class, true);
                if ($resolved !== null && $graph->has('class:'.$resolved)) {
                    $graph->edge($key, 'class:'.$resolved, EdgeKind::Implements, ['label' => 'implements']);
                    $count++;
                }
            }

            foreach ($class['traits'] ?? [] as $trait) {
                $resolved = $this->resolveReference((string) $trait, $class, true);
                if ($resolved !== null && $graph->has('class:'.$resolved)) {
                    $graph->edge($key, 'class:'.$resolved, EdgeKind::Uses, ['label' => 'uses trait']);
                    $count++;
                }
            }
        }

        return $count;
    }

    /** `route('users.show')` inside a view or controller points at a route node. */
    private function linkRouteNames(GraphBuilder $graph, array $classes, array $routes): int
    {
        $byName = $routes['by_name'] ?? [];
        $count = 0;

        // Views referencing named routes
        foreach ($graph->nodes() as $key => $node) {
            if (! in_array($node['type'] ?? '', [NodeType::View->value, NodeType::Component->value], true)) {
                continue;
            }

            foreach ($node['meta']['routes'] ?? [] as $routeName) {
                if (! is_string($routeName) || ! isset($byName[$routeName])) {
                    continue;
                }

                $graph->edge($key, $byName[$routeName], EdgeKind::Uses, ['label' => 'route('.$routeName.')']);
                $count++;
            }

            foreach ($node['meta']['gates'] ?? [] as $ability) {
                if (is_string($ability) && $graph->has('ability:'.$ability)) {
                    $graph->edge($key, 'ability:'.$ability, EdgeKind::Authorizes, ['label' => '@can('.$ability.')']);
                    $count++;
                }
            }
        }

        // Controllers and services referencing named routes
        foreach ($classes as $fqcn => $class) {
            if (! $graph->has('class:'.$fqcn)) {
                continue;
            }

            foreach ($class['methods'] as $method) {
                foreach ($method['captures'] as $capture) {
                    if (($capture['type'] ?? '') === 'route' && is_string($capture['value'] ?? null)) {
                        $routeName = $capture['value'];
                        if (isset($byName[$routeName])) {
                            $graph->edge('class:'.$fqcn, $byName[$routeName], EdgeKind::Uses, [
                                'label' => 'redirects to '.$routeName,
                                'meta' => ['method' => $method['name']],
                            ]);
                            $count++;
                        }
                    }

                    if (($capture['type'] ?? '') === 'eager_load') {
                        // Remember eager loading so the insights stage can spot lazy-loading risks.
                        $graph->node('class:'.$fqcn, NodeType::tryFrom($graph->nodeOrNull('class:'.$fqcn)['type'] ?? 'class') ?? NodeType::PhpClass, $class['label'], [
                            'meta' => ['eager_loads' => array_values(array_unique(array_merge(
                                $graph->nodeOrNull('class:'.$fqcn)['meta']['eager_loads'] ?? [],
                                [$method['name']]
                            )))],
                        ]);
                    }
                }
            }
        }

        return $count;
    }

    /** Tests link to the class they cover and to any route URI they call. */
    private function linkTests(GraphBuilder $graph, array $classes, array $routes): int
    {
        $count = 0;
        $routesByUri = [];

        foreach ($routes['routes'] ?? [] as $key => $route) {
            $routesByUri[$route['uri']] = $key;
        }

        foreach ($classes as $fqcn => $class) {
            $key = 'class:'.$fqcn;
            $node = $graph->nodeOrNull($key);

            if ($node === null || ($node['type'] ?? '') !== NodeType::Test->value) {
                continue;
            }

            $subject = Str::of(class_basename($fqcn))->beforeLast('Test')->value();

            // 1. Name-based matching: UserControllerTest → UserController
            foreach ($classes as $candidateFqcn => $candidate) {
                if (class_basename($candidateFqcn) !== $subject) {
                    continue;
                }

                if ($graph->has('class:'.$candidateFqcn)) {
                    $graph->edge($key, 'class:'.$candidateFqcn, EdgeKind::Tests, [
                        'label' => 'covers',
                        'weight' => 2.4,
                    ]);
                    $count++;
                }
            }

            // 2. URI matching: $this->get('/users') links the test to the route
            foreach ($node['meta']['methods'] ?? [] as $method) {
                foreach ($method['strings'] ?? [] as $string) {
                    if (! is_string($string) || ! str_starts_with($string, '/')) {
                        continue;
                    }

                    $uri = '/'.trim($string, '/');

                    if (isset($routesByUri[$uri])) {
                        $graph->edge($key, $routesByUri[$uri], EdgeKind::Tests, [
                            'label' => 'requests '.$uri,
                            'meta' => ['test_method' => $method['name'] ?? null],
                        ]);
                        $count++;
                    }
                }
            }
        }

        return $count;
    }

    /** Provider bindings, gates and model observers become visible edges. */
    private function linkProvidersAndObservers(GraphBuilder $graph, array $classes): int
    {
        $count = 0;

        foreach ($classes as $fqcn => $class) {
            if (! $graph->has('class:'.$fqcn)) {
                continue;
            }

            foreach ($class['methods'] as $method) {
                foreach ($method['captures'] as $capture) {
                    $type = $capture['type'] ?? '';
                    $value = $capture['value'] ?? null;

                    if ($type === 'binding' && is_string($value)) {
                        $target = $this->resolveReference($value, $class);
                        if ($target !== null && $graph->has('class:'.$target)) {
                            $graph->edge('class:'.$fqcn, 'class:'.$target, EdgeKind::Provides, [
                                'label' => 'binds',
                                'meta' => ['method' => $method['name']],
                            ]);
                            $count++;
                        }
                    }

                    if ($type === 'gate_definition' && is_string($value)) {
                        $graph->touch('ability:'.$value, 'can '.$value, [
                            'type' => NodeType::Policy->value,
                            'module' => 'Authorization',
                        ]);
                        $graph->edge('class:'.$fqcn, 'ability:'.$value, EdgeKind::Provides, ['label' => 'defines gate']);
                        $count++;
                    }

                    if ($type === 'observer' && is_string($value)) {
                        $target = $this->resolveReference($value, $class);
                        if ($target !== null && $graph->has('class:'.$target)) {
                            $graph->edge('class:'.$fqcn, 'class:'.$target, EdgeKind::Listens, [
                                'label' => 'observed by',
                                'meta' => ['method' => $method['name']],
                            ]);
                            $count++;
                        }
                    }

                    if ($type === 'mail' || $type === 'notify') {
                        $target = is_string($value) ? $this->resolveReference($value, $class) : null;
                        if ($target !== null && $graph->has('class:'.$target)) {
                            $graph->edge('class:'.$fqcn, 'class:'.$target, EdgeKind::Notifies, [
                                'label' => $type === 'mail' ? 'sends mail' : 'notifies',
                            ]);
                            $count++;
                        }
                    }
                }
            }
        }

        return $count;
    }

    /**
     * Composer packages become real nodes when the application actually imports
     * them, so the third-party surface of the project is visible at a glance.
     */
    private function linkPackages(GraphBuilder $graph, array $classes, array $manifest): int
    {
        $packages = $manifest['packages'] ?? [];
        $count = 0;

        $vendorNamespaces = [];

        foreach ($classes as $fqcn => $class) {
            foreach (array_merge(
                $class['type_refs'] ?? [],
                $class['static_calls'] ?? [],
                $class['instantiated'] ?? [],
                $class['class_const_refs'] ?? [],
            ) as $reference) {
                $reference = ltrim((string) $reference, '\\');

                if ($reference === '' || ! str_contains($reference, '\\')) {
                    continue;
                }

                if (! NameResolver::isFramework($reference) && ! $this->isInternal($reference, $classes)) {
                    $vendorNamespaces[NameResolver::vendorOf($reference)][] = [$fqcn, $reference];
                }
            }
        }

        $used = 0;

        foreach ($vendorNamespaces as $vendor => $hits) {
            $matched = collect($packages)->first(fn (array $package) => ($package['vendor'] ?? '') === $vendor || Str::startsWith($package['name'] ?? '', Str::lower($vendor).'/'));

            if ($matched === null || count($hits) < 2) {
                continue;
            }

            $packageKey = 'package:'.$matched['name'];
            $graph->node($packageKey, NodeType::Package, $matched['name'], [
                'module' => 'Packages',
                'layer' => Layer::External->value,
                'weight' => 30,
                'meta' => [
                    'constraint' => $matched['constraint'] ?? null,
                    'dev' => (bool) ($matched['dev'] ?? false),
                    'usages' => count($hits),
                    'vendor' => $vendor,
                ],
            ]);

            $linked = [];

            foreach ($hits as [$classFqcn, $reference]) {
                if (isset($linked[$classFqcn])) {
                    continue;
                }
                $linked[$classFqcn] = true;

                if ($graph->has('class:'.$classFqcn)) {
                    $graph->edge('class:'.$classFqcn, $packageKey, EdgeKind::Uses, [
                        'label' => 'uses '.$matched['name'],
                        'weight' => 0.8,
                    ]);
                    $count++;
                }
            }

            $used++;
        }

        return $count;
    }

    private function isInternal(string $reference, array $classes): bool
    {
        return isset($classes[$reference]);
    }

    /** Normalise a short type name (e.g. `User`) to a FQCN using the file imports. */
    private function normalize(string $type, array $class): string
    {
        $type = ltrim($type, '\\');

        if (str_contains($type, '\\')) {
            return $type;
        }

        $imports = $class['imports'] ?? [];

        if (isset($imports[$type])) {
            return $imports[$type];
        }

        $namespace = $class['namespace'] ?? '';

        return $namespace !== '' ? $namespace.'\\'.$type : $type;
    }

    private function resolveReference(string $reference, array $class, bool $allowExternal = false): ?string
    {
        $reference = trim($reference, '\\');

        if ($reference === '' || NameResolver::isBuiltin($reference)) {
            return null;
        }

        $resolved = $this->normalize($reference, $class);

        return $resolved === '' ? null : $resolved;
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
