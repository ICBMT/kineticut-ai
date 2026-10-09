<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Parsers\RouteParser;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use App\Support\NameResolver;

/**
 * Stage 4 — reconstructs the route table exactly the way the framework would,
 * including resource routes, groups, middleware stacks and controller actions.
 */
class RouteStage implements Stage
{
    public function __construct(private readonly RouteParser $parser) {}

    public function name(): ScanStage
    {
        return ScanStage::Routes;
    }

    public function run(ScanContext $context): array
    {
        $index = $context->readArtifact('files');
        $graph = $this->freshGraph($context);

        $routeFiles = array_values(array_filter(
            $index['files'] ?? [],
            fn (array $file) => preg_match('#^routes/[a-z0-9_\-\.]+\.php$#i', $file['path'])
        ));

        $routes = [];
        $byName = [];
        $apiCount = 0;

        foreach ($routeFiles as $file) {
            $parsed = $this->parser->parse($context->root.'/'.$file['path'], $file['path']);

            foreach ($parsed as $route) {
                $isApi = str_starts_with($route['uri'], '/api/') || $file['path'] === 'routes/api.php' || $file['path'] === 'routes/api_v1.php';

                $key = 'route:'.$route['method'].' '.$route['uri'];
                $routes[$key] = $route + ['is_api' => $isApi, 'file' => $file['path']];
                $isApi && $apiCount++;

                $label = $route['name'] !== ''
                    ? $route['name']
                    : trim($route['method'].' '.($route['uri'] === '/' ? '/' : $route['uri']));

                $graph->node($key, NodeType::Route, $label, [
                    'file' => $file['path'],
                    'line' => $route['line'],
                    'module' => str_starts_with($route['uri'], '/api') ? 'API' : 'Web',
                    'weight' => $route['action_type'] === 'controller' ? 90 : 55,
                    'meta' => [
                        'uri' => $route['uri'],
                        'method' => $route['method'],
                        'name' => $route['name'] !== '' ? $route['name'] : null,
                        'action_type' => $route['action_type'],
                        'controller' => $route['controller'],
                        'action' => $route['action'] ?? null,
                        'middleware' => array_values($route['middleware'] ?? []),
                        'without_middleware' => array_values($route['without_middleware'] ?? []),
                        'domain' => $route['domain'],
                        'is_api' => $isApi,
                        'resource' => $route['resource'] ?? null,
                        'fallback' => $route['fallback'] ?? false,
                        'redirect_to' => $route['redirect_to'] ?? null,
                        'deprecated' => str_contains($route['uri'], 'deprecated'),
                    ],
                ]);

                if ($route['name'] !== '') {
                    $byName[$route['name']] = $key;
                }

                // ---- controller action ----
                if (! empty($route['controller'])) {
                    $controllerKey = 'class:'.ltrim((string) $route['controller'], '\\');
                    $graph->touch($controllerKey, NameResolver::short((string) $route['controller']), [
                        'type' => NodeType::Controller->value,
                        'layer' => Layer::Http->value,
                        'module' => 'Http',
                    ]);
                    $graph->edge($key, $controllerKey, EdgeKind::Http, [
                        'label' => '→ '.$route['action'].'()',
                        'meta' => ['action' => $route['action'] ?? null],
                    ]);
                }

                // ---- middleware guards on the route itself ----
                foreach ($route['middleware'] ?? [] as $middleware) {
                    $this->registerMiddleware($graph, $key, (string) $middleware, $route['action'] ?? null);
                }

                // ---- inline view routes render a view directly ----
                if (! empty($route['view'])) {
                    $graph->touch('view:'.$route['view'], $route['view'], [
                        'type' => NodeType::View->value,
                        'module' => 'Views',
                    ]);
                    $graph->edge($key, 'view:'.$route['view'], EdgeKind::Renders, ['label' => 'renders']);
                }
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);
        $context->writeArtifact('routes', ['routes' => $routes, 'by_name' => $byName]);

        if ($apiCount > 0) {
            $context->log(sprintf('%d API routes detected', $apiCount));
        }

        $this->flagDuplicateUris($context, $routes);

        return [
            'summary' => sprintf('%s routes (%s API)', number_format(count($routes)), number_format($apiCount)),
            'metrics' => [
                'routes' => count($routes),
                'api_routes' => $apiCount,
                'route_names' => count($byName),
                'route_files' => array_column($routeFiles, 'path'),
            ],
        ];
    }

    /** `auth:api`, `can:update,post`, `throttle:60,1` are all middleware strings. */
    private function registerMiddleware(GraphBuilder $graph, string $routeKey, string $middleware, ?string $action): void
    {
        $name = trim($middleware);

        if ($name === '') {
            return;
        }

        $key = str_contains($name, '\\') ? 'class:'.ltrim($name, '\\') : 'middleware:'.$name;

        $graph->touch($key, str_contains($name, '\\') ? NameResolver::short($name) : $name, [
            'type' => NodeType::Middleware->value,
            'layer' => Layer::Http->value,
            'module' => 'Http',
            'weight' => 50,
            'meta' => [
                'parameters' => str_contains($name, ':') ? substr($name, strpos($name, ':') + 1) : null,
                'alias' => str_contains($name, ':') ? strstr($name, ':', true) : $name,
            ],
        ]);

        $graph->edge($key, $routeKey, EdgeKind::Guards, [
            'label' => 'guards',
            'meta' => ['action' => $action],
        ]);
    }

    private function flagDuplicateUris(ScanContext $context, array $routes): void
    {
        $seen = [];

        foreach ($routes as $route) {
            $signature = $route['method'].' '.$route['uri'];

            if (isset($seen[$signature])) {
                $context->log('Duplicate route definition: '.$signature, 'warn', [
                    'first' => $seen[$signature]['file'],
                    'second' => $route['file'],
                ]);
            }

            $seen[$signature] = $route;
        }
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
