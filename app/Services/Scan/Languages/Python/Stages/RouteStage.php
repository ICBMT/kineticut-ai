<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Python\PythonIndex;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 7 of the Python pipeline — the URLs a user can actually reach.
 *
 * Python has three conventions for this and a project may use any of them, so
 * all three are read:
 *
 *   Flask / FastAPI  `@app.route('/tasks', methods=['POST'])`, `@app.get('/x')`
 *   Django           `urlpatterns = [path('tasks/', views.task_list)]`
 *   DRF              `router.register('tasks', TaskViewSet)`
 *
 * A route node is identical in shape to the Laravel and ASP.NET ones — same
 * key, same `uri`/`method`/`action` metadata, same `http` edge to the thing that
 * handles it — so tracing, the journey bar and the inspector need no Python
 * branch to work.
 */
class RouteStage implements Stage
{
    /** Decorators that are HTTP verbs, keyed by the verb they mean. */
    private const VERBS = [
        'get' => 'GET', 'post' => 'POST', 'put' => 'PUT', 'patch' => 'PATCH',
        'delete' => 'DELETE', 'head' => 'HEAD', 'options' => 'OPTIONS',
    ];

    /** Django's URL helpers. */
    private const DJANGO_HELPERS = ['path', 're_path', 'url'];

    /** What a DRF router gives a registered viewset. */
    private const RESOURCE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

    public function __construct(private readonly PythonIndex $index) {}

    public function name(): ScanStage
    {
        return ScanStage::Routes;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $modules = $this->index->modules($context);

        $moduleKeys = $symbols['modules'] ?? [];
        $typeKeys = $symbols['types'] ?? [];
        $functionKeys = $symbols['functions'] ?? [];

        $routes = [];
        $counts = ['routes' => 0, 'decorators' => 0, 'urlpatterns' => 0, 'routers' => 0, 'unresolved' => 0];

        foreach ($modules as $module) {
            $dotted = $module['module'];
            $parsed = $module['parsed'];
            $moduleKey = $moduleKeys[$dotted] ?? null;
            $directory = dirname($module['path']) === '.' ? '' : dirname($module['path']);

            if ($moduleKey === null) {
                continue;
            }

            // ---- Flask / FastAPI decorators ---------------------------------
            foreach ($parsed['functions'] ?? [] as $function) {
                $owner = $function['owner'] ?? null;
                $handlerKey = $owner !== null
                    ? ($typeKeys[$dotted.'.'.$owner] ?? $moduleKey)
                    : ($functionKeys[$dotted.'.'.$function['name']] ?? $moduleKey);

                foreach ($function['decorator_records'] ?? [] as $decorator) {
                    $produced = $this->decoratorRoutes($graph, $module, $decorator, $function, $handlerKey);

                    if ($produced === 0) {
                        continue;
                    }

                    $counts['decorators']++;
                    $counts['routes'] += $produced;
                    $routes[] = ['file' => $module['path'], 'handler' => $function['name'], 'kind' => 'decorator'];
                }
            }

            // ---- Django `urlpatterns` ----------------------------------------
            foreach ($parsed['calls'] ?? [] as $call) {
                $name = (string) ($call['name'] ?? '');

                if (! in_array($name, self::DJANGO_HELPERS, true)) {
                    continue;
                }

                $arguments = (string) ($call['args'] ?? '');
                $pattern = $this->firstArgument($arguments);

                if ($pattern === null) {
                    continue;
                }

                // `path("", views.index)` is the site root, not a missing
                // argument — Django spells the front page as the empty string.
                $uri = $this->normaliseUri($pattern);

                if ($uri === null) {
                    continue;
                }

                // `include('shop.urls')` is a mounted app, not a view.
                $target = str_contains($arguments, 'include(')
                    ? $this->includeTarget($arguments, $dotted, $directory, $moduleKeys)
                    : $this->djangoTarget($arguments, $dotted, $directory, $moduleKeys, $typeKeys, $functionKeys);

                $this->route($graph, $module, 'GET', $uri, $target['key'], [
                    'action_type' => str_contains($arguments, 'include(') ? 'include' : 'django-url',
                    'handler' => $target['label'],
                    'name' => $this->keyword($arguments, 'name'),
                    'framework' => 'django',
                ], $call['line'] ?? null);

                $counts['urlpatterns']++;
                $counts['routes']++;
                $counts['unresolved'] += $target['key'] === null ? 1 : 0;
                $routes[] = ['file' => $module['path'], 'handler' => $target['label'], 'kind' => 'urlpattern'];
            }

            // ---- DRF routers ---------------------------------------------------
            foreach ($parsed['calls'] ?? [] as $call) {
                if (($call['name'] ?? '') !== 'register') {
                    continue;
                }

                $arguments = $this->splitArguments((string) ($call['args'] ?? ''));

                if (count($arguments) < 2) {
                    continue;
                }

                $prefix = trim($this->unquote($arguments[0]), '/');
                $viewset = trim($arguments[1]);

                if ($prefix === '' || $viewset === '') {
                    continue;
                }

                $segments = explode('.', $viewset);
                $base = (string) end($segments);
                $handlerKey = $this->findType($base, $dotted, $typeKeys);

                foreach (self::RESOURCE_METHODS as $verb) {
                    $suffix = in_array($verb, ['GET', 'POST'], true) ? '' : '/{id}';

                    $this->route($graph, $module, $verb, '/'.$prefix.$suffix, $handlerKey ?? $moduleKey, [
                        'action_type' => 'viewset',
                        'handler' => $base,
                        'resource' => $prefix,
                        'framework' => 'drf',
                    ], $call['line'] ?? null);

                    $counts['routes']++;
                }

                $counts['routers']++;
                $counts['unresolved'] += $handlerKey === null ? 1 : 0;
                $routes[] = ['file' => $module['path'], 'handler' => $base, 'kind' => 'router'];
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('routes', ['routes' => $routes, 'groups' => []]);

        $context->log(sprintf(
            '%d routes — %d decorated views, %d urlpatterns, %d routers%s',
            $counts['routes'],
            $counts['decorators'],
            $counts['urlpatterns'],
            $counts['routers'],
            $counts['unresolved'] > 0 ? ' · '.$counts['unresolved'].' handler(s) not resolved' : '',
        ));

        return [
            'summary' => $counts['routes'].' routes',
            'metrics' => $counts,
        ];
    }

    /**
     * `@app.route('/tasks', methods=['POST'])` and `@app.get('/tasks')`.
     *
     * @return int  how many routes the decorator produced
     */
    private function decoratorRoutes(GraphBuilder $graph, array $module, array $decorator, array $function, string $handlerKey): int
    {
        $name = strtolower((string) ($decorator['name'] ?? ''));
        $arguments = (string) ($decorator['raw'] ?? '');
        $strings = $decorator['args'] ?? [];
        $verbs = [];
        $uri = null;

        if (str_ends_with($name, '.route') || $name === 'route') {
            $verbs = $this->methods($arguments);
            $uri = $this->firstRouteString($strings);
        } elseif (preg_match('/\.([a-z_]+)$/', $name, $match) === 1 && isset(self::VERBS[$match[1]])) {
            $verbs = [self::VERBS[$match[1]]];
            $uri = $this->firstRouteString($strings);
        }

        if ($verbs === []) {
            return 0;
        }

        $uri = $this->normaliseUri($uri ?? '/'.$function['name']);

        if ($uri === null) {
            return 0;
        }

        foreach ($verbs as $verb) {
            $this->route($graph, $module, $verb, $uri, $handlerKey, [
                'action_type' => 'flask-view',
                'handler' => $function['name'],
                'name' => $this->endpoint($arguments),
                'framework' => 'flask',
            ], $function['line'] ?? null);
        }

        return count($verbs);
    }

    /** The first string argument that looks like a URL path. */
    private function firstRouteString(array $strings): ?string
    {
        foreach ($strings as $string) {
            if (str_starts_with(trim((string) $string), '/')) {
                return (string) $string;
            }
        }

        return $strings !== [] ? (string) $strings[0] : null;
    }

    private function route(GraphBuilder $graph, array $module, string $verb, string $uri, ?string $handlerKey, array $meta, ?int $line): void
    {
        $key = 'route:'.$verb.' '.$uri;

        if (! $graph->has($key)) {
            $graph->node($key, NodeType::Route, trim($verb.' '.$uri), [
                'file' => $module['path'],
                'line' => $line,
                'module' => 'Http',
                'layer' => Layer::Http->value,
                'weight' => 90,
                'meta' => [
                    'uri' => $uri,
                    'method' => $verb,
                    'name' => $meta['name'] ?? null,
                    'action_type' => $meta['action_type'] ?? 'view',
                    'controller' => $meta['handler'] ?? null,
                    'action' => $meta['handler'] ?? null,
                    'middleware' => [],
                    'without_middleware' => [],
                    'domain' => null,
                    'is_api' => str_starts_with($uri, '/api'),
                    'resource' => $meta['resource'] ?? null,
                    'fallback' => false,
                    'redirect_to' => null,
                    'deprecated' => false,
                    'framework' => $meta['framework'] ?? 'python',
                    'language' => 'python',
                ],
            ]);
        }

        if ($handlerKey !== null && $handlerKey !== '' && $graph->has($handlerKey) && $handlerKey !== $key) {
            $graph->edge($key, $handlerKey, EdgeKind::Http, ['label' => $meta['handler'] ?? 'handles']);
        }
    }

    /** Resolve `views.task_list` or `TaskViewSet.as_view()` to a node in the project. */
    private function djangoTarget(string $arguments, string $dotted, string $directory, array $moduleKeys, array $typeKeys, array $functionKeys): array
    {
        $parts = $this->splitArguments($arguments);
        $reference = $parts[1] ?? null;

        if ($reference === null) {
            return ['key' => null, 'label' => null];
        }

        $reference = preg_replace('/\.as_view\s*\(\s*\)$/', '', trim($reference)) ?? trim($reference);
        $segments = explode('.', $reference);
        $name = (string) end($segments);
        $owner = count($segments) > 1 ? $segments[count($segments) - 2] : null;

        // `views.task_list` where `views.py` sits beside the urls module.
        if ($owner !== null) {
            $candidate = ($directory === '' ? '' : str_replace('/', '.', $directory).'.').$owner;

            if (isset($functionKeys[$candidate.'.'.$name])) {
                return ['key' => $functionKeys[$candidate.'.'.$name], 'label' => $name];
            }

            if (isset($typeKeys[$candidate.'.'.$name])) {
                return ['key' => $typeKeys[$candidate.'.'.$name], 'label' => $name];
            }
        }

        $key = $this->findFunction($name, $dotted, $functionKeys) ?? $this->findType($name, $dotted, $typeKeys);

        if ($key !== null) {
            return ['key' => $key, 'label' => $name];
        }

        return ['key' => null, 'label' => $name];
    }

    /** `include('shop.urls')` — point at the module whose `urlpatterns` these are. */
    private function includeTarget(string $arguments, string $dotted, string $directory, array $moduleKeys): array
    {
        if (preg_match_all('/[\'"]([A-Za-z_][A-Za-z0-9_.]*)[\'"]/', $arguments, $matches) === false) {
            return ['key' => null, 'label' => null];
        }

        foreach ($matches[1] as $candidate) {
            if (isset($moduleKeys[$candidate])) {
                return ['key' => $moduleKeys[$candidate], 'label' => $candidate];
            }

            $sibling = ($directory === '' ? '' : str_replace('/', '.', $directory).'.').$candidate;

            if (isset($moduleKeys[$sibling])) {
                return ['key' => $moduleKeys[$sibling], 'label' => $candidate];
            }
        }

        return ['key' => null, 'label' => trim($arguments, " '")];
    }

    private function findFunction(string $name, string $dotted, array $functionKeys): ?string
    {
        if (isset($functionKeys[$dotted.'.'.$name])) {
            return $functionKeys[$dotted.'.'.$name];
        }

        foreach ($functionKeys as $qualified => $key) {
            if (str_ends_with($qualified, '.'.$name)) {
                return $key;
            }
        }

        return null;
    }

    private function findType(string $name, string $dotted, array $typeKeys): ?string
    {
        if (isset($typeKeys[$dotted.'.'.$name])) {
            return $typeKeys[$dotted.'.'.$name];
        }

        foreach ($typeKeys as $qualified => $key) {
            if (str_ends_with($qualified, '.'.$name)) {
                return $key;
            }
        }

        return null;
    }

    /** `methods=['POST', 'PUT']` → ['POST', 'PUT']; absent → ['GET']. */
    private function methods(string $arguments): array
    {
        if (preg_match('/methods\s*=\s*\[([^\]]*)\]/i', $arguments, $match) === 0) {
            return ['GET'];
        }

        preg_match_all('/[\'"]([A-Za-z]+)[\'"]/', $match[1], $verbs);

        $out = [];

        foreach ($verbs[1] as $verb) {
            $verb = strtoupper($verb);

            if (in_array($verb, self::VERBS, true)) {
                $out[] = $verb;
            }
        }

        return $out === [] ? ['GET'] : array_values(array_unique($out));
    }

    private function endpoint(string $arguments): ?string
    {
        return $this->keyword($arguments, 'endpoint') ?? $this->keyword($arguments, 'name');
    }

    private function keyword(string $arguments, string $keyword): ?string
    {
        if (preg_match('/'.$keyword.'\s*=\s*[\'"]([^\'"]+)[\'"]/i', $arguments, $match) === 1) {
            return $match[1];
        }

        return null;
    }

    /** The first argument as written; `null` only when there is no call at all. */
    private function firstArgument(string $arguments): ?string
    {
        $parts = $this->splitArguments($arguments);

        if ($parts === []) {
            return null;
        }

        return $this->unquote($parts[0]);
    }

    /** Split a call's arguments on the commas that separate them. */
    private function splitArguments(string $arguments): array
    {
        $parts = [];
        $buffer = '';
        $depth = 0;
        $quote = null;
        $length = strlen($arguments);

        for ($i = 0; $i < $length; $i++) {
            $character = $arguments[$i];

            if ($quote !== null) {
                $buffer .= $character;

                if ($character === $quote && ($i === 0 || $arguments[$i - 1] !== '\\')) {
                    $quote = null;
                }

                continue;
            }

            if ($character === '"' || $character === "'") {
                $quote = $character;
                $buffer .= $character;

                continue;
            }

            if ($character === '(' || $character === '[' || $character === '{') {
                $depth++;
            } elseif ($character === ')' || $character === ']' || $character === '}') {
                $depth--;
            }

            if ($character === ',' && $depth === 0) {
                $parts[] = trim($buffer);
                $buffer = '';

                continue;
            }

            $buffer .= $character;
        }

        if (trim($buffer) !== '') {
            $parts[] = trim($buffer);
        }

        return $parts;
    }

    private function unquote(string $value): string
    {
        return trim(trim($value), "'\"");
    }

    /** Django's `<int:pk>` and Flask's `<id>` read best as `{pk}` / `{id}`. */
    private function normaliseUri(?string $uri): ?string
    {
        if ($uri === null) {
            return null;
        }

        $uri = trim($uri);

        if ($uri === '') {
            return '/';
        }

        $uri = preg_replace('/<(?:[a-z]+:)?([A-Za-z_][A-Za-z0-9_]*)>/', '{$1}', $uri) ?? $uri;
        $uri = preg_replace('/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>[^)]*\)/', '{$1}', $uri) ?? $uri;

        return '/'.trim($uri, '/');
    }
}
