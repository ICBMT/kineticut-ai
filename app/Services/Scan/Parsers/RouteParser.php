<?php

declare(strict_types=1);

namespace App\Services\Scan\Parsers;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Name;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\Parser;
use PhpParser\ParserFactory;

/**
 * Interprets routes/*.php the way the framework would: walking the fluent
 * registrar call-by-call, honouring group prefixes, middleware stacks, name
 * prefixes and `Route::resource` expansions so the visualised route table
 * genuinely matches `php artisan route:list`.
 */
class RouteParser
{
    private Parser $parser;

    private const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'head'];

    /** Calls that actually define something (as opposed to decorating it). */
    private const DEFINITION_CALLS = [
        'get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'head',
        'resource', 'apiResource', 'singleton', 'apiSingleton', 'group',
        'view', 'redirect', 'fallback', 'match',
    ];

    private const RESOURCE_ACTIONS = [
        'index' => ['GET', ''],
        'create' => ['GET', '/create'],
        'store' => ['POST', ''],
        'show' => ['GET', '/%model%'],
        'edit' => ['GET', '/%model%/edit'],
        'update' => ['PUT|PATCH', '/%model%'],
        'destroy' => ['DELETE', '/%model%'],
    ];

    private const API_RESOURCE_ACTIONS = [
        'index' => ['GET', ''],
        'store' => ['POST', ''],
        'show' => ['GET', '/%model%'],
        'update' => ['PUT|PATCH', '/%model%'],
        'destroy' => ['DELETE', '/%model%'],
    ];

    private const SINGULAR_RESOURCE_ACTIONS = [
        'create' => ['GET', '/create'],
        'store' => ['POST', ''],
        'show' => ['GET', ''],
        'edit' => ['GET', '/edit'],
        'update' => ['PUT|PATCH', ''],
        'destroy' => ['DELETE', ''],
    ];

    public function __construct()
    {
        $this->parser = (new ParserFactory)->createForNewestSupportedVersion();
    }

    /** @return array<int, array> */
    public function parse(string $absolutePath, string $relativePath): array
    {
        $code = @file_get_contents($absolutePath);

        if ($code === false) {
            return [];
        }

        try {
            $ast = $this->parser->parse($code);
        } catch (\Throwable) {
            return [];
        }

        if ($ast === null) {
            return [];
        }

        $traverser = new NodeTraverser;
        $traverser->addVisitor(new NameResolver(null, ['preserveOriginalNames' => true, 'replaceNodes' => false]));

        try {
            $ast = $traverser->traverse($ast);
        } catch (\Throwable) {
            return [];
        }

        $neutral = [
            'uri_prefix' => '',
            'name_prefix' => '',
            'middleware' => [],
            'without_middleware' => [],
            'controller' => null,
            'domain' => null,
            'file' => $relativePath,
        ];

        return $this->handleStatements($ast, $neutral);
    }

    /** @return array<int, array> */
    private function handleStatements(array $statements, array $context): array
    {
        $routes = [];

        foreach ($statements as $statement) {
            if ($statement instanceof Stmt\Expression) {
                $routes = array_merge($routes, $this->handleExpression($statement->expr, $context));
            } elseif ($statement instanceof Stmt\If_) {
                $routes = array_merge($routes, $this->handleStatements($statement->stmts, $context));
                foreach ($statement->elseifs as $elseif) {
                    $routes = array_merge($routes, $this->handleStatements($elseif->stmts, $context));
                }
                if ($statement->else !== null) {
                    $routes = array_merge($routes, $this->handleStatements($statement->else->stmts, $context));
                }
            } elseif ($statement instanceof Stmt\TryCatch) {
                $routes = array_merge($routes, $this->handleStatements($statement->stmts, $context));
                foreach ($statement->catches as $catch) {
                    $routes = array_merge($routes, $this->handleStatements($catch->stmts, $context));
                }
            } elseif ($statement instanceof Stmt\Foreach_) {
                $routes = array_merge($routes, $this->handleStatements($statement->stmts, $context));
            }
        }

        return $routes;
    }

    /** @return array<int, array> */
    private function handleExpression(Expr $expr, array $context): array
    {
        $chain = $this->flattenChain($expr);

        if ($chain === []) {
            return [];
        }

        return $this->handleChain($chain, $context);
    }

    /**
     * Turn `Route::middleware('auth')->prefix('admin')->group($fn)` into an
     * ordered list of links we can walk.
     *
     * @return array<int, array{kind:string, name:string, class?:string, args:array, node:Node}>
     */
    private function flattenChain(Expr $expr): array
    {
        $links = [];

        $walk = function (Expr $node) use (&$walk, &$links): void {
            if ($node instanceof Expr\MethodCall) {
                $walk($node->var);
                $links[] = [
                    'kind' => 'method',
                    'name' => $node->name instanceof Node\Identifier ? $node->name->toString() : '*',
                    'args' => array_map(fn ($a) => $a->value, $node->getArgs()),
                    'node' => $node,
                ];
            } elseif ($node instanceof Expr\NullsafeMethodCall) {
                $walk($node->var);
            } elseif ($node instanceof Expr\StaticCall) {
                $class = $node->class instanceof Name ? $this->resolved($node->class) : null;
                $links[] = [
                    'kind' => 'static',
                    'name' => $node->name instanceof Node\Identifier ? $node->name->toString() : '*',
                    'class' => $class,
                    'args' => array_map(fn ($a) => $a->value, $node->getArgs()),
                    'node' => $node,
                ];
            } elseif ($node instanceof Expr\Variable && is_string($node->name)) {
                $links[] = ['kind' => 'var', 'name' => $node->name, 'args' => [], 'node' => $node];
            } elseif ($node instanceof Expr\PropertyFetch && $node->var instanceof Expr\Variable && $node->var->name === 'router') {
                $links[] = ['kind' => 'var', 'name' => 'router', 'args' => [], 'node' => $node];
            }
        };

        $walk($expr);

        return $links;
    }

    /**
     * Walk one fully-flattened call chain.
     *
     * The *last* link is the outermost call (the actual route definition); the
     * preceding links are group attributes such as `->prefix()` or `->middleware()`.
     *
     * @return array<int, array>
     */
    private function handleChain(array $chain, array $context): array
    {
        $root = $chain[0];

        // The defining call is the last link that is a verb/resource/group:
        // trailing `->name(...)`, `->middleware(...)` are decorations, while
        // leading `->prefix(...)`, `->middleware(...)` are group attributes.
        $definitionIndex = null;

        for ($i = count($chain) - 1; $i >= 0; $i--) {
            if (in_array($chain[$i]['name'], self::DEFINITION_CALLS, true)) {
                $definitionIndex = $i;

                break;
            }
        }

        if ($definitionIndex === null) {
            return [];
        }

        $headLink = $chain[$definitionIndex];
        $attributes = array_values(array_filter(
            $chain,
            fn (array $link, int $index) => $index !== $definitionIndex,
            ARRAY_FILTER_USE_BOTH
        ));

        $isRouteFacade = $root['kind'] === 'static'
            && $root['class'] !== null
            && (str_ends_with($root['class'], 'Facades\Route') || $root['class'] === 'Route');

        $isRouterVariable = $root['kind'] === 'var' && in_array($root['name'], ['router', 'route'], true);

        if (! $isRouteFacade && ! $isRouterVariable) {
            return [];
        }

        $head = $headLink['name'];
        $headArgs = $headLink['args'];
        $line = $headLink['node']->getStartLine();

        // Group with attributes: Route::middleware(..)->prefix(..)->group(fn)
        if ($head === 'group') {
            $groupContext = $this->applyAttributes($context, $attributes, $headArgs);
            $closure = $headArgs[0] ?? null;

            if ($closure instanceof Expr\Closure) {
                return $this->handleStatements($closure->stmts, $groupContext);
            }

            if ($closure instanceof Expr\Array_ && ($closure->items[0]->value ?? null) instanceof Expr\Closure) {
                return $this->handleStatements($closure->items[0]->value->stmts, $groupContext);
            }

            return [];
        }

        // Route::resource(...) / apiResource / singleton / apiSingleton
        if (in_array($head, ['resource', 'apiResource', 'singleton', 'apiSingleton'], true)) {
            $name = $this->stringValue($headArgs[0] ?? null);
            $controller = $this->classValue($headArgs[1] ?? null);
            $modifiers = $this->applyAttributes($context, $attributes, []);

            return $this->expandResource($head, (string) $name, $controller, $modifiers, $line, $context['file']);
        }

        if ($head === 'view') {
            $uri = $this->stringValue($headArgs[0] ?? null);
            $viewName = $this->stringValue($headArgs[1] ?? null);
            $route = $this->routeRecord('GET', $uri, $context, $line);
            $route['action_type'] = 'view';
            $route['view'] = $viewName;
            $route['name'] = $route['name'] ?: $this->nameFromUri($uri);

            return [$route];
        }

        if ($head === 'redirect') {
            $uri = $this->stringValue($headArgs[0] ?? null);
            $route = $this->routeRecord('GET', $uri, $context, $line);
            $route['action_type'] = 'redirect';
            $route['redirect_to'] = $this->stringValue($headArgs[1] ?? null);

            return [$route];
        }

        if ($head === 'fallback') {
            $closure = $headArgs[0] ?? null;
            $route = $this->routeRecord('GET', '/{fallback}', $context, $line);
            $route['action_type'] = 'closure';
            $route['fallback'] = true;
            $route['view'] = $this->viewInside($closure);

            return [$route];
        }

        if ($head === 'match') {
            $verbs = $this->arrayValue($headArgs[0] ?? null);
            $uri = $this->stringValue($headArgs[1] ?? null);
            $route = $this->routeRecord(
                implode('|', array_map(fn ($verb) => strtoupper((string) $verb), $verbs)),
                $uri,
                $context,
                $line
            );
            $route = $this->applyHandler($route, $headArgs[2] ?? null);

            return [$this->applyRouteAttributes($route, $attributes)];
        }

        if (in_array($head, self::HTTP_VERBS, true)) {
            $uri = $this->stringValue($headArgs[0] ?? null);
            $method = $head === 'any' ? 'ANY' : strtoupper($head);

            $route = $this->routeRecord($method, $uri, $context, $line);
            $route = $this->applyHandler($route, $headArgs[1] ?? null);

            return [$this->applyRouteAttributes($route, $attributes)];
        }

        return [];
    }

    private function applyHandler(array $route, ?Node $handler): array
    {
        if ($handler instanceof Expr\Array_) {
            $controller = $this->classValue($handler->items[0]->value ?? null);
            $action = $this->stringValue($handler->items[1]->value ?? null);
            $route['action_type'] = 'controller';
            $route['controller'] = $controller;
            $route['action'] = $action;
        } elseif ($handler instanceof Node\Scalar\String_ && str_contains($handler->value, '@')) {
            [$controller, $action] = explode('@', $handler->value, 2);
            $route['action_type'] = 'controller';
            $route['controller'] = $this->resolveShortController($controller, $route);
            $route['action'] = $action;
        } elseif ($handler instanceof Expr\Closure || $handler instanceof Expr\ArrowFunction) {
            $route['action_type'] = 'closure';
            $route['view'] = $this->viewInside($handler);
            $route['lines'] = max(1, $handler->getEndLine() - $handler->getStartLine());
        } elseif ($handler instanceof Expr\ClassConstFetch) {
            $route['action_type'] = 'invokable';
            $route['controller'] = $this->classValue($handler);
            $route['action'] = '__invoke';
        } elseif ($handler instanceof Expr\StaticCall) {
            $route['action_type'] = 'controller';
            $route['controller'] = $handler->class instanceof Name ? $this->resolved($handler->class) : null;
            $route['action'] = $handler->name instanceof Node\Identifier ? $handler->name->toString() : null;
        } elseif ($handler === null) {
            $route['action_type'] = 'closure';
        }

        return $route;
    }

    /** @return array<int, array> */
    private function applyRouteAttributes(array $route, array $links): array
    {
        foreach ($links as $link) {
            if ($link['kind'] !== 'method') {
                continue;
            }

            $args = $link['args'];

            if ($link['name'] === 'name') {
                // Inside a named group Laravel concatenates: ->name('teams.') + ->name('index')
                $route['name'] = $route['name_prefix'].($this->stringValue($args[0] ?? null) ?? '');
            } elseif ($link['name'] === 'middleware') {
                $route['middleware'] = array_values(array_unique(array_merge(
                    $route['middleware'],
                    $this->middlewareValues($args)
                )));
            } elseif ($link['name'] === 'withoutMiddleware') {
                $route['without_middleware'] = array_values(array_unique(array_merge(
                    $route['without_middleware'],
                    $this->middlewareValues($args)
                )));
            } elseif ($link['name'] === 'where') {
                $route['wheres'][] = $this->stringValue($args[1] ?? null);
            } elseif ($link['name'] === 'defaults') {
                $route['has_defaults'] = true;
            }
        }

        return $route;
    }

    /** @return array<int, array> */
    private function expandResource(string $kind, string $name, ?string $controller, array $context, int $line, string $file): array
    {
        $plural = $name;
        $modelParam = str_replace('-', '_', \Illuminate\Support\Str::singular(str_replace('/', '_', $plural)));
        $brace = chr(123);   // { — built from its code point so the source stays quote-safe
        $closeBrace = chr(125);

        $actions = match ($kind) {
            'apiResource', 'apiResources' => self::API_RESOURCE_ACTIONS,
            'singleton', 'apiSingleton' => self::SINGULAR_RESOURCE_ACTIONS,
            default => self::RESOURCE_ACTIONS,
        };

        $only = $context['only'] ?? null;
        $except = $context['except'] ?? null;
        $nameOverrides = $context['resource_names'] ?? [];

        $routes = [];

        foreach ($actions as $action => [$verb, $suffix]) {
            if (is_array($only) && ! in_array($action, $only, true)) {
                continue;
            }
            if (is_array($except) && in_array($action, $except, true)) {
                continue;
            }

            $suffix = str_replace('%model%', $brace.$modelParam.$closeBrace, $suffix);
            $uri = rtrim('/'.trim($plural, '/').$suffix, '/');
            $uri = $uri === '' ? '/' : $uri;

            $route = $this->routeRecord($verb, $uri, $context, $line);
            $route['action_type'] = 'controller';
            $route['controller'] = $controller;
            $route['action'] = $action;
            $route['resource'] = $plural;
            $route['name'] = $nameOverrides[$action]
                ?? ($route['name_prefix'].str_replace('/', '.', $plural).'.'.$action);

            $routes[] = $route;
        }

        return $routes;
    }

    private function routeRecord(string $method, ?string $uri, array $context, int $line): array
    {
        $uri = trim((string) $uri, '/');
        $full = trim($context['uri_prefix'].'/'.$uri, '/');

        return [
            'method' => $method,
            'uri' => '/'.($full === '' ? '' : $full),
            'name_prefix' => $context['name_prefix'],
            'name' => '',
            'middleware' => array_values(array_unique($context['middleware'])),
            'without_middleware' => array_values(array_unique($context['without_middleware'] ?? [])),
            'domain' => $context['domain'],
            'controller' => $context['controller'],
            'action' => null,
            'action_type' => 'closure',
            'file' => $context['file'],
            'line' => $line,
            'prefix' => $context['uri_prefix'],
        ];
    }

    private function applyAttributes(array $context, array $links, array $groupArgs): array
    {
        // Array style: Route::group(['prefix' => 'admin'], fn)
        if ($groupArgs !== []) {
            $array = $this->arrayValue($groupArgs[0] ?? null);
            if ($array !== []) {
                if (isset($array['prefix'])) {
                    $context['uri_prefix'] = trim($context['uri_prefix'].'/'.trim((string) $array['prefix'], '/'), '/');
                }
                if (isset($array['as'])) {
                    $context['name_prefix'] .= (string) $array['as'];
                }
                if (isset($array['domain'])) {
                    $context['domain'] = (string) $array['domain'];
                }
                if (isset($array['middleware'])) {
                    $context['middleware'] = array_values(array_unique(array_merge(
                        $context['middleware'],
                        is_array($array['middleware']) ? $array['middleware'] : [$array['middleware']]
                    )));
                }
                if (isset($array['controller'])) {
                    $context['controller'] = (string) $array['controller'];
                }
            }
        }

        foreach ($links as $link) {
            if (! in_array($link['kind'], ['method', 'static'], true)) {
                continue;
            }

            $args = $link['args'];

            switch ($link['name']) {
                case 'prefix':
                    $context['uri_prefix'] = trim($context['uri_prefix'].'/'.trim((string) $this->stringValue($args[0] ?? null), '/'), '/');
                    break;
                case 'name':
                case 'as':
                    $context['name_prefix'] .= (string) $this->stringValue($args[0] ?? null);
                    break;
                case 'middleware':
                    $value = $args[0] ?? null;
                    $values = $value instanceof Expr\Array_
                        ? $this->arrayValue($value)
                        : [$this->stringValue($value)];

                    if ($value instanceof Expr\Array_) {
                        $pairs = [];
                        foreach ($value->items ?? [] as $item) {
                            if ($item?->key !== null) {
                                $key = $this->stringValue($item->key);
                                if ($key !== null) {
                                    $pairs[] = $key.($item->value instanceof Node\Scalar\String_ ? ':'.$item->value->value : '');
                                }
                            } elseif ($item?->value !== null) {
                                $pairs[] = (string) $this->stringValue($item->value);
                            }
                        }
                        $values = $pairs;
                    }

                    $context['middleware'] = array_values(array_unique(array_merge(
                        $context['middleware'],
                        array_filter($values, 'is_string')
                    )));
                    break;
                case 'withoutMiddleware':
                    $values = $this->middlewareValues($args);
                    $context['without_middleware'] = array_values(array_unique(array_merge(
                        $context['without_middleware'] ?? [],
                        $values
                    )));
                    break;
                case 'domain':
                    $context['domain'] = $this->stringValue($args[0] ?? null);
                    break;
                case 'controller':
                    $context['controller'] = $this->classValue($args[0] ?? null);
                    break;
                case 'only':
                    $context['only'] = $this->arrayValue($args[0] ?? null);
                    break;
                case 'except':
                    $context['except'] = $this->arrayValue($args[0] ?? null);
                    break;
            }
        }

        return $context;
    }

    /** @return array<int, string> */
    private function middlewareValues(array $args): array
    {
        $argument = $args[0] ?? null;

        if ($argument instanceof Expr\Array_) {
            return array_values(array_filter(array_map(
                fn ($item) => $this->stringValue($item?->value),
                $argument->items ?? []
            ), 'is_string'));
        }

        $single = $this->stringValue($argument);

        return $single !== null ? [$single] : [];
    }

    private function viewInside(?Node $handler): ?string
    {
        if ($handler === null || ! property_exists($handler, 'stmts') && ! $handler instanceof Expr\ArrowFunction) {
            if (! $handler instanceof Expr\ArrowFunction) {
                return null;
            }
        }

        $found = null;

        $walk = function ($nodes) use (&$walk, &$found): void {
            foreach ((array) $nodes as $node) {
                if (! $node instanceof Node) {
                    continue;
                }

                if ($node instanceof Expr\FuncCall && $node->name instanceof Name && in_array($node->name->toLowerString(), ['view'], true)) {
                    $found = $this->stringValue($node->getArgs()[0]->value ?? null) ?? $found;
                }

                if ($node instanceof Expr\StaticCall && $node->class instanceof Name && class_basename($node->class->toString()) === 'View') {
                    $found = $this->stringValue($node->getArgs()[0]->value ?? null) ?? $found;
                }

                foreach ($node->getSubNodeNames() as $sub) {
                    $child = $node->$sub;
                    if ($child instanceof Node) {
                        $walk([$child]);
                    } elseif (is_array($child)) {
                        $walk($child);
                    }
                }
            }
        };

        if ($handler instanceof Expr\ArrowFunction) {
            $walk([$handler->expr]);
        } elseif (property_exists($handler, 'stmts')) {
            $walk($handler->stmts);
        }

        return $found;
    }

    private function nameFromUri(?string $uri): string
    {
        $clean = trim((string) $uri, '/');
        $clean = preg_replace('/\{[^}]+\}/', '', $clean) ?? $clean;
        $clean = str_replace('/', '.', trim($clean, '.'));

        return $clean === '' ? 'home' : $clean;
    }

    private function resolved(Name $name): string
    {
        $resolved = $name->getAttribute('resolvedName');

        return $resolved instanceof Name ? $resolved->toString() : $name->toString();
    }

    private function resolveShortController(string $controller, array $route): string
    {
        $controller = ltrim($controller, '\\');

        if (str_contains($controller, '\\')) {
            return $controller;
        }

        // Legacy `UserController@index` style refers to the HTTP namespace.
        return 'App\\Http\\Controllers\\'.$controller;
    }

    private function stringValue(?Node $node): ?string
    {
        if ($node instanceof Node\Scalar\String_) {
            return $node->value;
        }

        if ($node instanceof Expr\BinaryOp\Concat) {
            $left = $this->stringValue($node->left);
            $right = $this->stringValue($node->right);

            return $left !== null && $right !== null ? $left.$right : null;
        }

        if ($node instanceof Expr\ClassConstFetch) {
            return $this->classValue($node);
        }

        return null;
    }

    private function classValue(?Node $node): ?string
    {
        if ($node instanceof Expr\ClassConstFetch && $node->class instanceof Name) {
            return $this->resolved($node->class);
        }

        if ($node instanceof Node\Scalar\String_) {
            return ltrim($node->value, '\\');
        }

        if ($node instanceof Expr\StaticCall && $node->class instanceof Name) {
            return $this->resolved($node->class);
        }

        return null;
    }

    /** @return array<int|string, mixed> */
    private function arrayValue(?Node $node): array
    {
        if (! $node instanceof Expr\Array_) {
            return [];
        }

        $out = [];

        foreach ($node->items ?? [] as $item) {
            if ($item === null) {
                continue;
            }

            $key = $item->key !== null ? ($this->stringValue($item->key) ?? null) : null;
            $value = $this->stringValue($item->value);

            if ($value === null && $item->value instanceof Expr\Array_) {
                $value = $this->arrayValue($item->value);
            }

            if ($key === null) {
                $out[] = $value;
            } else {
                $out[$key] = $value;
            }
        }

        return $out;
    }
}
