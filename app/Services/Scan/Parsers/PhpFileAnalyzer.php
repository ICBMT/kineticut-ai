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
use PhpParser\PrettyPrinter\Standard as PrettyPrinter;

/**
 * Parses one PHP file into a rich, framework-aware description.
 *
 * Beyond the raw class shape (name, methods, imports) it recognises Laravel
 * idioms — `view()`, `dispatch()`, `$this->authorize()`, Eloquent relationship
 * calls, middleware registrations, form request validation rules, provider
 * bindings — and reports them as structured "captures" that later stages turn
 * into edges of the graph.
 */
class PhpFileAnalyzer
{
    private Parser $parser;

    private PrettyPrinter $printer;

    /** Relationship methods that make an Eloquent model method a relationship. */
    private const RELATION_METHODS = [
        'hasOne', 'hasMany', 'belongsTo', 'belongsToMany', 'morphOne', 'morphMany',
        'morphTo', 'morphToMany', 'morphedByMany', 'hasManyThrough', 'hasOneThrough',
    ];

    private const CALL_CAPTURES = [
        'view' => 'view',
        'make' => null,               // handled specially (View::make)
        'route' => 'route',
        'to_route' => 'route',
        'redirect' => null,
        'dispatch' => 'dispatch',
        'dispatchAfterResponse' => 'dispatch',
        'dispatchSync' => 'dispatch',
        'event' => 'event',
        'broadcast' => 'broadcast',
        'notify' => 'notify',
        'transaction' => null,
        'cache' => 'cache',
        'authorize' => 'authorize',
        'can' => 'gate',
        'cannot' => 'gate',
        'gate' => 'gate',
        'policy' => 'policy',
        'validate' => 'validate',
        'validateWithBag' => 'validate',
        'with' => 'eager_load',
        'load' => 'eager_load',
        'loadMissing' => 'eager_load',
        'withCount' => 'eager_load',
        'middleware' => 'middleware',
        'withoutMiddleware' => 'without_middleware',
        'name' => 'route_name',
        'paginate' => 'paginate',
        'simplePaginate' => 'paginate',
        'cursorPaginate' => 'paginate',
        'send' => 'mail',
        'queue' => 'mail',
        'later' => 'mail',
        'define' => 'gate_definition',
        'listen' => 'listener',
        'bind' => 'binding',
        'singleton' => 'binding',
        'scoped' => 'binding',
        'instance' => 'binding',
        'observe' => 'observer',
        'schedule' => 'schedule',
        'job' => 'job',
        'call' => 'schedule',
        'command' => 'schedule',
    ];

    public function __construct()
    {
        $this->parser = (new ParserFactory)->createForNewestSupportedVersion();
        $this->printer = new PrettyPrinter;
    }

    /**
     * @return array<int, array> zero or more class-like descriptors
     */
    public function analyze(string $absolutePath, string $relativePath): array
    {
        $code = @file_get_contents($absolutePath);

        if ($code === false || trim($code) === '') {
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
        $traverser->addVisitor(new NameResolver(null, [
            'preserveOriginalNames' => true,
            'replaceNodes' => false,
        ]));

        try {
            $ast = $traverser->traverse($ast);
        } catch (\Throwable) {
            return [];
        }

        $imports = $this->collectImports($ast);
        $classes = [];

        // Namespaced files wrap everything in Stmt\Namespace_, so we have to
        // descend before we can see any class-like declaration.
        foreach ($this->classLikeNodes($ast) as $node) {
            $classes[] = $this->describeClass($node, $relativePath, $imports, $code);
        }

        return array_values(array_filter($classes));
    }

    /**
     * @param  array<int, Node>  $statements
     * @return array<int, Stmt\ClassLike>
     */
    private function classLikeNodes(array $statements): array
    {
        $found = [];

        foreach ($statements as $statement) {
            if ($statement instanceof Stmt\ClassLike) {
                $found[] = $statement;
            } elseif ($statement instanceof Stmt\Namespace_) {
                $found = array_merge($found, $this->classLikeNodes($statement->stmts));
            }
        }

        return $found;
    }

    /** Cheap syntactic probe used to decide whether a file is worth parsing. */
    public function looksLikePhpClass(string $code): bool
    {
        return (bool) preg_match('/\b(class|interface|trait|enum)\s+[A-Za-z_]/', $code);
    }

    /** @return array<string, string> alias => FQCN */
    private function collectImports(array $ast): array
    {
        $imports = [];

        foreach ($ast as $statement) {
            if ($statement instanceof Stmt\Use_) {
                foreach ($statement->uses as $use) {
                    $fqcn = $use->name->toString();
                    $alias = $use->alias?->toString() ?? basename(str_replace('\\', '/', $fqcn));
                    if ($statement->type === Stmt\Use_::TYPE_FUNCTION || $statement->type === Stmt\Use_::TYPE_CONSTANT) {
                        continue;
                    }
                    $imports[$alias] = $fqcn;
                }
            } elseif ($statement instanceof Stmt\GroupUse) {
                foreach ($statement->uses as $use) {
                    $fqcn = $statement->prefix->toString().'\\'.$use->name->toString();
                    $alias = $use->alias?->toString() ?? basename(str_replace('\\', '/', $fqcn));
                    $imports[$alias] = $fqcn;
                }
            }
        }

        return $imports;
    }

    private function describeClass(Stmt\ClassLike $node, string $relativePath, array $imports, string $source): ?array
    {
        $fqcn = isset($node->namespacedName) ? $node->namespacedName->toString() : null;

        if ($fqcn === null && $node->name !== null) {
            $fqcn = $node->name->toString();
        }

        if ($fqcn === null) {
            return null; // anonymous class
        }

        $namespace = Name::class === get_class($node) ? '' : (str_contains($fqcn, '\\') ? substr($fqcn, 0, (int) strrpos($fqcn, '\\')) : '');

        $kind = match (true) {
            $node instanceof Stmt\Interface_ => 'interface',
            $node instanceof Stmt\Trait_ => 'trait',
            $node instanceof Stmt\Enum_ => 'enum',
            default => 'class',
        };

        $extends = null;
        $implements = [];
        $traits = [];

        if ($node instanceof Stmt\Class_ && $node->extends !== null) {
            $extends = $this->resolvedName($node->extends);
        }

        if ($node instanceof Stmt\ClassLike) {
            foreach ($node->implements ?? [] as $interface) {
                $implements[] = $this->resolvedName($interface);
            }
        }

        foreach ($node->stmts as $statement) {
            if ($statement instanceof Stmt\TraitUse) {
                foreach ($statement->traits as $trait) {
                    $traits[] = $this->resolvedName($trait);
                }
            }
        }

        $startLine = $node->getStartLine();
        $endLine = $node->getEndLine();

        $descriptor = [
            'fqcn' => $fqcn,
            'label' => $node->name?->toString() ?? $fqcn,
            'namespace' => $namespace,
            'file' => $relativePath,
            'line' => $startLine,
            'end_line' => $endLine,
            'loc' => max(1, $endLine - $startLine),
            'kind' => $kind,
            'abstract' => $node instanceof Stmt\Class_ && $node->isAbstract(),
            'final' => $node instanceof Stmt\Class_ && $node->isFinal(),
            'readonly' => $node instanceof Stmt\Class_ && method_exists($node, 'isReadonly') && $node->isReadonly(),
            'extends' => $extends,
            'implements' => array_values(array_filter($implements)),
            'traits' => array_values(array_filter($traits)),
            'attributes' => $this->describeAttributes($node->attrGroups),
            'docblock' => $this->docSummary($node),
            'imports' => $imports,
            'methods' => [],
            'properties' => [],
            'constants' => [],
            'captures' => [],
            'type_refs' => [],
            'static_calls' => [],
            'instantiated' => [],
            'class_const_refs' => [],
            'promoted_types' => [],
        ];

        $typeRefs = [];
        $staticCalls = [];
        $instantiated = [];
        $classConstRefs = [];

        if ($extends !== null) {
            $typeRefs[] = $extends;
        }
        $typeRefs = array_merge($typeRefs, $implements, $traits);

        $propertyTypes = [];

        foreach ($node->stmts as $statement) {
            if ($statement instanceof Stmt\Property) {
                $descriptor['properties'][] = $this->describeProperty($statement);

                $type = $statement->type;
                if ($type instanceof Node\Name || $type instanceof Node\NullableType) {
                    $inner = $type instanceof Node\NullableType ? $type->type : $type;
                    if ($inner instanceof Node\Name) {
                        $resolved = $this->resolvedName($inner);
                        $propertyTypes[$statement->props[0]->name->toString()] = $resolved;
                        $typeRefs[] = $resolved;
                    }
                }

                if ($statement->isStatic() && $statement->props[0]->default instanceof Expr\ConstFetch) {
                    // ignore
                }
            } elseif ($statement instanceof Stmt\ClassConst) {
                foreach ($statement->consts as $const) {
                    $descriptor['constants'][] = [
                        'name' => $const->name->toString(),
                        'value' => $this->literal($const->value),
                    ];
                }
            } elseif ($statement instanceof Stmt\ClassMethod) {
                $method = $this->describeMethod($statement, $propertyTypes, $descriptor);

                $descriptor['methods'][] = $method['method'];
                $descriptor['captures'] = array_merge($descriptor['captures'], $method['captures']);
                $typeRefs = array_merge($typeRefs, $method['type_refs']);
                $staticCalls = array_merge($staticCalls, $method['static_calls']);
                $instantiated = array_merge($instantiated, $method['instantiated']);
                $classConstRefs = array_merge($classConstRefs, $method['class_const_refs']);

                if (str_starts_with($statement->name->toString(), '__construct')) {
                    foreach ($statement->params as $param) {
                        $type = $param->type;
                        $inner = $type instanceof Node\NullableType ? $type->type : $type;
                        if ($inner instanceof Node\Name && $param->var instanceof Expr\Variable && is_string($param->var->name)) {
                            $resolved = $this->resolvedName($inner);
                            $descriptor['promoted_types'][$param->var->name] = $resolved;
                            $typeRefs[] = $resolved;
                        }
                    }
                }
            }
        }

        $descriptor['type_refs'] = array_values(array_unique(array_filter($typeRefs)));
        $descriptor['static_calls'] = array_values(array_unique(array_filter($staticCalls)));
        $descriptor['instantiated'] = array_values(array_unique(array_filter($instantiated)));
        $descriptor['class_const_refs'] = array_values(array_unique(array_filter($classConstRefs)));

        return $descriptor;
    }

    private function describeProperty(Stmt\Property $node): array
    {
        $type = null;
        $inner = $node->type instanceof Node\NullableType ? $node->type->type : $node->type;
        if ($inner instanceof Node\Name) {
            $type = $inner->toString();
        } elseif ($inner instanceof Node\Identifier) {
            $type = $inner->toString();
        }

        $props = [];
        foreach ($node->props as $property) {
            $props[] = [
                'name' => $property->name->toString(),
                'value' => $this->literal($property->default),
            ];
        }

        return [
            'name' => $props[0]['name'] ?? 'property',
            'names' => array_column($props, 'name'),
            'values' => $props,
            'type' => $type,
            'visibility' => $this->visibility($node),
            'static' => $node->isStatic(),
            'readonly' => method_exists($node, 'isReadonly') && $node->isReadonly(),
        ];
    }

    /**
     * Walk a single method body collecting every useful reference.
     *
     * @return array{method: array, captures: array, type_refs: array, static_calls: array, instantiated: array, class_const_refs: array}
     */
    private function describeMethod(Stmt\ClassMethod $node, array $propertyTypes, array $descriptor): array
    {
        $captures = [];
        $typeRefs = [];
        $staticCalls = [];
        $instantiated = [];
        $classConstRefs = [];
        $propertyCalls = [];
        $stringArgs = [];

        foreach ($node->params as $param) {
            $type = $param->type;
            $inner = $type instanceof Node\NullableType ? $type->type : $type;
            if ($inner instanceof Node\Name) {
                $typeRefs[] = $this->resolvedName($inner);
            } elseif ($inner instanceof Node\UnionType) {
                foreach ($inner->types as $union) {
                    if ($union instanceof Node\Name) {
                        $typeRefs[] = $this->resolvedName($union);
                    }
                }
            }
        }

        $returnType = null;
        $returnNode = $node->returnType instanceof Node\NullableType ? $node->returnType->type : $node->returnType;
        if ($returnNode instanceof Node\Name) {
            $returnType = $this->resolvedName($returnNode);
            $typeRefs[] = $returnType;
        } elseif ($returnNode instanceof Node\UnionType) {
            foreach ($returnNode->types as $union) {
                if ($union instanceof Node\Name) {
                    $typeRefs[] = $this->resolvedName($union);
                }
            }
        } elseif ($returnNode instanceof Node\Identifier) {
            $returnType = $returnNode->toString();
        }

        if ($node->stmts !== null) {
            $walker = new NodeTraverser;
            $visitor = new class($this, $propertyTypes, $descriptor) extends \PhpParser\NodeVisitorAbstract
            {
                public array $captures = [];

                public array $typeRefs = [];

                public array $staticCalls = [];

                public array $instantiated = [];

                public array $classConstRefs = [];

                public array $propertyCalls = [];

                public array $strings = [];

                public function __construct(
                    private readonly PhpFileAnalyzer $analyzer,
                    private readonly array $propertyTypes,
                    private readonly array $descriptor,
                ) {}

                public function enterNode(Node $node): null
                {
                    // new Foo(...)
                    if ($node instanceof Expr\New_ && $node->class instanceof Name) {
                        $this->instantiated[] = $this->analyzer->publicResolvedName($node->class);
                        $this->captureFromNew($node);
                    }

                    // Foo::class
                    if ($node instanceof Expr\ClassConstFetch
                        && $node->class instanceof Name
                        && $node->name instanceof Node\Identifier
                        && $node->name->toLowerString() === 'class') {
                        $this->classConstRefs[] = $this->analyzer->publicResolvedName($node->class);
                    }

                    // Foo::method(...)
                    if ($node instanceof Expr\StaticCall && $node->class instanceof Name) {
                        $fqcn = $this->analyzer->publicResolvedName($node->class);
                        $this->staticCalls[] = $fqcn;
                        $this->captureStatic($fqcn, $node);
                    }

                    // instanceof / catch / typed params already handled elsewhere
                    if ($node instanceof Expr\Instanceof_ && $node->class instanceof Name) {
                        $this->typeRefs[] = $this->analyzer->publicResolvedName($node->class);
                    }

                    if ($node instanceof Stmt\Catch_) {
                        foreach ($node->types as $type) {
                            $this->typeRefs[] = $this->analyzer->publicResolvedName($type);
                        }
                    }

                    // $this->authorize(...), $this->middleware(...), $this->dispatch(...)
                    if ($node instanceof Expr\MethodCall
                        && $node->var instanceof Expr\Variable
                        && $node->var->name === 'this'
                        && $node->name instanceof Node\Identifier) {
                        $this->captureThisCall($node->name->toString(), $node);
                    }

                    // $query->paginate(25), ->with([...]) etc. recognised on any receiver
                    if ($node instanceof Expr\MethodCall && $node->name instanceof Node\Identifier) {
                        $chain = $node->name->toString();

                        if (in_array($chain, ['paginate', 'simplePaginate', 'cursorPaginate'], true)) {
                            $this->captures[] = ['type' => 'paginate', 'value' => $chain];
                        }

                        // `->with('project')` is eager loading; `->with('status', 'Saved!')`
                        // on a redirect is flash data, so multi-argument calls are ignored.
                        if (in_array($chain, ['with', 'load', 'loadMissing', 'withCount'], true) && count($node->getArgs()) === 1) {
                            $relations = $this->analyzer->literalValue($node->getArgs()[0]->value ?? null);
                            $this->captures[] = [
                                'type' => 'eager_load',
                                'value' => is_array($relations)
                                    ? implode(',', array_map('strval', array_keys($relations)))
                                    : (is_string($relations) ? $relations : $chain),
                            ];
                        }

                        // redirect()->route('tasks.show')
                        if ($chain === 'route' && count($node->getArgs()) >= 1) {
                            $target = $this->analyzer->literalValue($node->getArgs()[0]->value ?? null);
                            if (is_string($target)) {
                                $this->captures[] = ['type' => 'route', 'value' => $target];
                            }
                        }
                    }

                    // $this->service->doSomething()
                    if ($node instanceof Expr\MethodCall
                        && $node->var instanceof Expr\PropertyFetch
                        && $node->var->var instanceof Expr\Variable
                        && $node->var->var->name === 'this'
                        && $node->var->name instanceof Node\Identifier) {
                        $property = $node->var->name->toString();
                        $target = $this->propertyTypes[$property] ?? null;
                        if ($target !== null) {
                            $this->propertyCalls[$target][] = $node->name instanceof Node\Identifier ? $node->name->toString() : '*';
                        }
                    }

                    // String literals anywhere (used for facades like Storage/Cache)
                    if ($node instanceof Node\Scalar\String_) {
                        $this->strings[] = $node->value;
                    }

                    if ($node instanceof Expr\FuncCall && $node->name instanceof Name) {
                        $this->captureFunction($node->name->toLowerString(), $node);
                    }

                    return null;
                }

                private function captureFunction(string $fn, Expr\FuncCall $node): void
                {
                    $first = $node->getArgs()[0] ?? null;
                    $value = $first ? $this->analyzer->literalValue($first->value) : null;

                    switch ($fn) {
                        case 'view':
                        case 'to_route':
                        case 'dispatch':
                        case 'dispatch_sync':
                        case 'event':
                        case 'broadcast':
                        case 'report':
                            $this->captures[] = ['type' => $fn === 'view' ? 'view' : ($fn === 'to_route' ? 'route' : $fn), 'value' => $value];
                            break;
                        case 'resolve':
                        case 'app':
                            if ($first && $first->value instanceof Expr\ClassConstFetch) {
                                $this->captures[] = ['type' => 'resolve', 'value' => $value];
                            }
                            break;
                        case 'abort':
                        case 'abort_if':
                        case 'abort_unless':
                            $this->captures[] = ['type' => 'abort', 'value' => $value];
                            break;
                        case 'env':
                            $this->captures[] = ['type' => 'env', 'value' => $value];
                            break;
                        case 'config':
                            $this->captures[] = ['type' => 'config', 'value' => $value];
                            break;
                        case 'trans':
                        case '__':
                            $this->captures[] = ['type' => 'translation', 'value' => $value];
                            break;
                    }
                }

                private function captureStatic(string $fqcn, Expr\StaticCall $node): void
                {
                    $method = $node->name instanceof Node\Identifier ? $node->name->toString() : '*';
                    $first = $node->getArgs()[0] ?? null;
                    $value = $first ? $this->analyzer->literalValue($first->value) : null;
                    $short = class_basename($fqcn);

                    switch ($short) {
                        case 'View':
                            if ($method === 'make') {
                                $this->captures[] = ['type' => 'view', 'value' => $value];
                            }
                            break;
                        case 'Route':
                            $this->captures[] = ['type' => 'route_registrar', 'value' => $method.'|'.($value ?? '')];
                            break;
                        case 'Gate':
                            if ($method === 'define') {
                                $this->captures[] = ['type' => 'gate_definition', 'value' => $value];
                            } elseif (in_array($method, ['allows', 'denies', 'authorize', 'inspect'], true)) {
                                $this->captures[] = ['type' => 'gate', 'value' => $value];
                            }
                            break;
                        case 'Event':
                            if ($method === 'listen') {
                                $this->captures[] = ['type' => 'listener', 'value' => $value];
                            } elseif (in_array($method, ['dispatch', 'dispatchIf', 'dispatchUnless'], true)) {
                                $this->captures[] = ['type' => 'event', 'value' => $value];
                            }
                            break;
                        case 'Notification':
                        case 'Mail':
                            $this->captures[] = ['type' => $short === 'Mail' ? 'mail' : 'notify', 'value' => $value];
                            break;
                        case 'Cache':
                            $this->captures[] = ['type' => 'cache', 'value' => $value];
                            break;
                        case 'Storage':
                            $this->captures[] = ['type' => 'storage', 'value' => $value];
                            break;
                        case 'Blade':
                            $this->captures[] = ['type' => 'blade_directive', 'value' => $value];
                            break;
                        case 'Schedule':
                            $this->captures[] = ['type' => 'schedule', 'value' => $value];
                            break;
                        case 'Model':
                            if (in_array($method, ['observe', 'withoutEvents', 'preventLazyLoading'], true)) {
                                $this->captures[] = ['type' => 'model_config', 'value' => $method];
                            }
                            break;
                    }

                    // Anything::dispatch(...) => queue a job
                    if (in_array($method, ['dispatch', 'dispatchIf', 'dispatchUnless', 'dispatchAfterResponse', 'dispatchSync'], true)
                        && ! str_starts_with($fqcn, 'Illuminate\\')) {
                        $this->captures[] = ['type' => 'dispatch_class', 'value' => $fqcn];
                    }
                }

                /** Laravel's controller-helper style calls made on $this. */
                private function captureThisCall(string $method, Expr\MethodCall $node): void
                {
                    $first = $node->getArgs()[0]->value ?? null;
                    $value = $this->analyzer->literalValue($first);

                    switch ($method) {
                        case 'middleware':
                            $this->captures[] = ['type' => 'middleware', 'value' => is_string($value) ? $value : '*'];
                            break;
                        case 'withoutMiddleware':
                            $this->captures[] = ['type' => 'without_middleware', 'value' => is_string($value) ? $value : '*'];
                            break;
                        case 'authorize':
                            $this->captures[] = ['type' => 'authorize', 'value' => is_string($value) ? $value : '*'];
                            break;
                        case 'authorizeResource':
                            $this->captures[] = ['type' => 'authorize_resource', 'value' => $value];
                            break;
                        case 'validate':
                        case 'validateWithBag':
                            $rules = $this->analyzer->literalValue($node->getArgs()[count($node->getArgs()) - 1]->value ?? null);
                            $this->captures[] = [
                                'type' => 'validate',
                                'value' => is_array($rules) ? implode(',', array_map('strval', array_keys($rules))) : null,
                            ];
                            break;
                        case 'dispatch':
                        case 'dispatchSync':
                        case 'dispatchAfterResponse':
                            if ($first instanceof Expr\ClassConstFetch && $first->class instanceof Name) {
                                $this->captures[] = ['type' => 'dispatch_class', 'value' => $this->analyzer->publicResolvedName($first->class)];
                            }
                            break;
                        case 'event':
                        case 'notify':
                            if ($first instanceof Expr\ClassConstFetch && $first->class instanceof Name) {
                                $this->captures[] = ['type' => $method, 'value' => $this->analyzer->publicResolvedName($first->class)];
                            }
                            break;
                        case 'view':
                            $this->captures[] = ['type' => 'view', 'value' => is_string($value) ? $value : null];
                            break;
                    }
                }

                private function captureFromNew(Expr\New_ $node): void
                {
                    $fqcn = $node->class instanceof Name ? $this->analyzer->publicResolvedName($node->class) : null;
                    if ($fqcn === null) {
                        return;
                    }

                    if (str_ends_with($fqcn, 'Resource') || str_contains($fqcn, '\\Resources\\')) {
                        $this->captures[] = ['type' => 'resource', 'value' => $fqcn];
                    }
                }
            };

            $walker->addVisitor($visitor);

            try {
                $walker->traverse($node->stmts);
            } catch (\Throwable) {
                // A malformed method must not abort the whole file.
            }

            $captures = $visitor->captures;
            $typeRefs = array_merge($typeRefs, $visitor->typeRefs);
            $staticCalls = array_merge($staticCalls, $visitor->staticCalls);
            $instantiated = array_merge($instantiated, $visitor->instantiated);
            $classConstRefs = array_merge($classConstRefs, $visitor->classConstRefs);
            $propertyCalls = $visitor->propertyCalls;
            $stringArgs = $visitor->strings;
        }

        // Relationship detection for Eloquent models — the return statement drives it.
        $relation = $this->detectRelation($node);

        if ($relation !== null) {
            $captures[] = $relation;
        }

        // Controller-attribute middleware (Laravel 12+/13 style)
        foreach ($node->attrGroups as $group) {
            foreach ($group->attrs as $attr) {
                $name = $attr->name->toString();
                $short = class_basename($name);
                $arg = $attr->args[0] ?? null;
                $value = $arg ? $this->literalValue($arg->value) : null;

                if (in_array($short, ['Middleware', 'WithoutMiddleware'], true)) {
                    $captures[] = ['type' => $short === 'Middleware' ? 'middleware' : 'without_middleware', 'value' => $value ?? '*'];
                } elseif ($short === 'Authorize') {
                    $captures[] = ['type' => 'authorize', 'value' => $value ?? '*'];
                }
            }
        }

        return [
            'method' => [
                'name' => $node->name->toString(),
                'visibility' => $this->visibility($node),
                'static' => $node->isStatic(),
                'abstract' => $node->isAbstract(),
                'line' => $node->getStartLine(),
                'loc' => max(1, $node->getEndLine() - $node->getStartLine()),
                'params' => array_map(function ($param) {
                    $inner = $param->type instanceof Node\NullableType ? $param->type->type : $param->type;
                    $type = null;
                    if ($inner instanceof Node\Name) {
                        $type = $inner->toString();
                    } elseif ($inner instanceof Node\Identifier) {
                        $type = $inner->toString();
                    } elseif ($inner instanceof Node\UnionType) {
                        $type = implode('|', array_map(fn ($t) => $t->toString(), $inner->types));
                    }

                    return [
                        'name' => $param->var instanceof Expr\Variable && is_string($param->var->name) ? $param->var->name : 'arg',
                        'type' => $type,
                        'optional' => $param->default !== null,
                    ];
                }, $node->params),
                'return' => $returnType,
                'docblock' => $this->docSummary($node),
                'attributes' => $this->describeAttributes($node->attrGroups),
                'captures' => array_values(array_filter($captures, fn ($c) => ($c['value'] ?? null) !== null
                    || ($c['target'] ?? null) !== null
                    || in_array($c['type'], ['middleware', 'eager_load', 'relation', 'abort', 'schedule', 'model_config'], true))),
                'property_calls' => $propertyCalls,
                'has_loop' => $this->containsLoop($node),
                'has_query' => $this->containsQuery($node),
                'strings' => array_slice(array_values(array_unique($stringArgs)), 0, 40),
            ],
            'captures' => $captures,
            'type_refs' => $typeRefs,
            'static_calls' => $staticCalls,
            'instantiated' => $instantiated,
            'class_const_refs' => $classConstRefs,
        ];
    }

    /** Does the method iterate (foreach/for/while/->each) over anything? */
    private function containsLoop(Stmt\ClassMethod $method): bool
    {
        if ($method->stmts === null) {
            return false;
        }

        $found = false;

        $inspect = function (Node $node) use (&$inspect, &$found): void {
            if ($found) {
                return;
            }

            if ($node instanceof Stmt\Foreach_ || $node instanceof Stmt\For_ || $node instanceof Stmt\While_) {
                $found = true;

                return;
            }

            if ($node instanceof Expr\MethodCall
                && $node->name instanceof Node\Identifier
                && in_array($node->name->toString(), ['each', 'map', 'filter', 'transform', 'chunk', 'lazy'], true)) {
                $found = true;

                return;
            }

            foreach ($node->getSubNodeNames() as $sub) {
                $child = $node->$sub;
                if ($child instanceof Node) {
                    $inspect($child);
                } elseif (is_array($child)) {
                    foreach ($child as $item) {
                        if ($item instanceof Node) {
                            $inspect($item);
                        }
                    }
                }
            }
        };

        foreach ($method->stmts as $statement) {
            $inspect($statement);
        }

        return $found;
    }

    /** Does the method hit the database (query builder / Eloquent call)? */
    private function containsQuery(Stmt\ClassMethod $method): bool
    {
        if ($method->stmts === null) {
            return false;
        }

        $found = false;

        $inspect = function (Node $node) use (&$inspect, &$found): void {
            if ($found) {
                return;
            }

            if ($node instanceof Expr\MethodCall && $node->name instanceof Node\Identifier) {
                $name = $node->name->toString();

                if (in_array($name, ['get', 'all', 'first', 'find', 'findOrFail', 'paginate', 'count', 'where', 'with', 'load', 'pluck', 'sum', 'latest', 'cursor'], true)) {
                    $found = true;

                    return;
                }
            }

            foreach ($node->getSubNodeNames() as $sub) {
                $child = $node->$sub;
                if ($child instanceof Node) {
                    $inspect($child);
                } elseif (is_array($child)) {
                    foreach ($child as $item) {
                        if ($item instanceof Node) {
                            $inspect($item);
                        }
                    }
                }
            }
        };

        foreach ($method->stmts as $statement) {
            $inspect($statement);
        }

        return $found;
    }

    /** Spot `return $this->hasMany(Post::class);` and friends. */
    private function detectRelation(Stmt\ClassMethod $method): ?array
    {
        if ($method->stmts === null) {
            return null;
        }

        $methodName = $method->name->toString();
        $found = null;

        $inspect = function (Node $node) use (&$inspect, &$found): void {
            if ($found !== null) {
                return;
            }

            if ($node instanceof Stmt\Return_ && $node->expr instanceof Expr\MethodCall) {
                $call = $node->expr;
                $relation = $call->name instanceof Node\Identifier ? $call->name->toString() : null;

                if ($relation !== null && in_array($relation, self::RELATION_METHODS, true)) {
                    $target = null;
                    $first = $call->getArgs()[0] ?? null;

                    if ($first !== null) {
                        $value = $first->value;

                        if ($value instanceof Expr\ClassConstFetch && $value->class instanceof Name) {
                            $target = $this->resolvedName($value->class);
                        } elseif ($value instanceof Node\Scalar\String_) {
                            $target = $value->value;
                        }
                    }

                    $found = [
                        'type' => 'relation',
                        'relation' => $relation,
                        'target' => $target,
                    ];
                }
            }

            foreach ($node->getSubNodeNames() as $sub) {
                $child = $node->$sub;

                if ($child instanceof Node) {
                    $inspect($child);
                } elseif (is_array($child)) {
                    foreach ($child as $item) {
                        if ($item instanceof Node) {
                            $inspect($item);
                        }
                    }
                }
            }
        };

        foreach ($method->stmts as $statement) {
            $inspect($statement);
        }

        return $found === null ? null : $found + ['method' => $methodName];
    }

    private function describeAttributes(array $attrGroups): array
    {
        $out = [];

        foreach ($attrGroups as $group) {
            foreach ($group->attrs as $attr) {
                $out[] = [
                    'name' => $attr->name->toString(),
                    'short' => class_basename($attr->name->toString()),
                    'args' => array_map(fn ($arg) => $this->literalValue($arg->value), $attr->args),
                ];
            }
        }

        return $out;
    }

    private function docSummary(Node $node): ?string
    {
        $doc = $node->getDocComment();

        if ($doc === null) {
            return null;
        }

        $text = preg_replace('/^\s*\/\*\*|\*\/\s*$/', '', $doc->getText()) ?? '';
        $lines = preg_split('/\R/', $text) ?: [];
        $kept = [];

        foreach ($lines as $line) {
            $line = trim(preg_replace('/^\s*\*\s?/', '', $line) ?? '');
            if ($line === '' || str_starts_with($line, '@')) {
                continue;
            }
            $kept[] = $line;
            if (count($kept) >= 3) {
                break;
            }
        }

        $summary = trim(implode(' ', $kept));

        return $summary === '' ? null : mb_substr($summary, 0, 240);
    }

    private function visibility($node): string
    {
        if (method_exists($node, 'isPrivate') && $node->isPrivate()) {
            return 'private';
        }
        if (method_exists($node, 'isProtected') && $node->isProtected()) {
            return 'protected';
        }

        return 'public';
    }

    public function resolvedName(Name $name): string
    {
        $resolved = $name->getAttribute('resolvedName');

        if ($resolved instanceof Name) {
            return $resolved->toString();
        }

        return $name->toString();
    }

    public function publicResolvedName(Name $name): string
    {
        return $this->resolvedName($name);
    }

    /** Convert a constant expression into a JSON-friendly value. */
    public function literalValue(?Node $node): mixed
    {
        if ($node === null) {
            return null;
        }

        if ($node instanceof Expr\ClassConstFetch && $node->class instanceof Name) {
            return $this->resolvedName($node->class).'::'.$node->name->toString();
        }

        if ($node instanceof Node\Scalar\String_) {
            return $node->value;
        }

        if ($node instanceof Node\Scalar\Int_ || $node instanceof Node\Scalar\Float_) {
            return $node->value;
        }

        if ($node instanceof Expr\ConstFetch) {
            return $node->name->toString();
        }

        if ($node instanceof Expr\Array_) {
            $items = [];
            foreach ($node->items as $item) {
                if ($item === null) {
                    continue;
                }
                $key = $item->key ? $this->literalValue($item->key) : count($items);
                $items[$key] = $this->literalValue($item->value);
            }

            return $items;
        }

        if ($node instanceof Expr\Variable && is_string($node->name)) {
            return '$'.$node->name;
        }

        if ($node instanceof Expr\StaticCall || $node instanceof Expr\New_ || $node instanceof Expr\MethodCall) {
            try {
                return mb_substr($this->printer->prettyPrintExpr($node), 0, 200);
            } catch (\Throwable) {
                return null;
            }
        }

        return null;
    }

    private function literal(?Node $node): mixed
    {
        return $this->literalValue($node);
    }
}
