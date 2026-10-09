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
 * Reads migration files and rebuilds the schema they describe: tables, columns,
 * indexes and foreign keys. This is what lets AtlasScope draw the ERD layer
 * without ever touching a database connection.
 */
class MigrationParser
{
    private Parser $parser;

    private const SHORTCUTS = [
        'id' => ['type' => 'bigIncrements', 'primary' => true],
        'increments' => ['type' => 'increments', 'primary' => true],
        'bigIncrements' => ['type' => 'bigIncrements', 'primary' => true],
        'ulid' => ['type' => 'ulid', 'primary' => true],
        'uuid' => ['type' => 'uuid'],
        'foreignId' => ['type' => 'foreignId', 'unsigned' => true],
        'foreignUlid' => ['type' => 'foreignUlid', 'unsigned' => true],
        'foreignUuid' => ['type' => 'foreignUuid', 'unsigned' => true],
        'timestamps' => ['type' => 'timestamps', 'synthetic' => ['created_at', 'updated_at']],
        'nullableTimestamps' => ['type' => 'timestamps', 'synthetic' => ['created_at', 'updated_at'], 'nullable' => true],
        'timestampsTz' => ['type' => 'timestampsTz', 'synthetic' => ['created_at', 'updated_at']],
        'softDeletes' => ['type' => 'softDeletes', 'synthetic' => ['deleted_at']],
        'softDeletesTz' => ['type' => 'softDeletesTz', 'synthetic' => ['deleted_at']],
        'rememberToken' => ['type' => 'rememberToken', 'synthetic' => ['remember_token']],
        'morphs' => ['type' => 'morphs', 'synthetic' => ['%name%_type', '%name%_id']],
        'nullableMorphs' => ['type' => 'morphs', 'synthetic' => ['%name%_type', '%name%_id'], 'nullable' => true],
        'uuidMorphs' => ['type' => 'uuidMorphs', 'synthetic' => ['%name%_type', '%name%_id']],
        'nullableUuidMorphs' => ['type' => 'uuidMorphs', 'synthetic' => ['%name%_type', '%name%_id'], 'nullable' => true],
    ];

    public function __construct()
    {
        $this->parser = (new ParserFactory)->createForNewestSupportedVersion();
    }

    /**
     * @return array{
     *   tables: array<string, array>,
     *   migrations: array<int, array>
     * }
     */
    public function parse(string $absolutePath, string $relativePath): array
    {
        $code = @file_get_contents($absolutePath);

        if ($code === false) {
            return ['tables' => [], 'migrations' => []];
        }

        try {
            $ast = $this->parser->parse($code);
        } catch (\Throwable) {
            return ['tables' => [], 'migrations' => []];
        }

        if ($ast === null) {
            return ['tables' => [], 'migrations' => []];
        }

        $traverser = new NodeTraverser;
        $traverser->addVisitor(new NameResolver(null, ['preserveOriginalNames' => true, 'replaceNodes' => false]));

        try {
            $ast = $traverser->traverse($ast);
        } catch (\Throwable) {
            return ['tables' => [], 'migrations' => []];
        }

        $tables = [];
        $summary = ['file' => $relativePath, 'actions' => [], 'lines' => count(explode("\n", $code))];

        $walker = function (array $nodes) use (&$walker, &$tables, &$summary, $relativePath): void {
            foreach ($nodes as $node) {
                if ($node instanceof Expr\StaticCall && $node->class instanceof Name) {
                    $facade = class_basename($node->class->toString());

                    if ($facade === 'Schema') {
                        $method = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
                        $args = $node->getArgs();

                        if (in_array($method, ['create', 'table', 'dropIfExists', 'drop', 'rename'], true)) {
                            $table = $this->stringValue($args[0]->value ?? null);

                            if ($table !== null) {
                                $summary['actions'][] = $method.':'.$table;

                                if ($method === 'rename') {
                                    $to = $this->stringValue($args[1]->value ?? null);
                                    if ($to !== null) {
                                        $tables[$to] = $tables[$table] ?? $this->blankTable($to);
                                    }
                                } elseif (in_array($method, ['create', 'table'], true)) {
                                    $closure = $args[1]->value ?? null;
                                    $columns = $closure instanceof Expr\Closure ? $this->readBlueprint($closure, $table) : ['columns' => [], 'indexes' => [], 'foreigns' => []];

                                    $tables[$table] ??= $this->blankTable($table);
                                    $tables[$table]['columns'] = $this->mergeColumns($tables[$table]['columns'], $columns['columns']);
                                    $tables[$table]['indexes'] = array_values(array_unique(array_merge($tables[$table]['indexes'], $columns['indexes'])));
                                    $tables[$table]['foreign_keys'] = $this->dedupeForeignKeys(array_merge(
                                        $tables[$table]['foreign_keys'],
                                        $columns['foreigns']
                                    ));
                                    $tables[$table]['migrations'][] = $relativePath;
                                    $tables[$table]['created_by'] ??= $relativePath;
                                } elseif (in_array($method, ['dropIfExists', 'drop'], true)) {
                                    $tables[$table]['dropped'] = true;
                                }
                            }
                        }
                    }
                }

                if ($node instanceof Node) {
                    foreach ($node->getSubNodeNames() as $sub) {
                        $child = $node->$sub;
                        if ($child instanceof Node) {
                            $walker([$child]);
                        } elseif (is_array($child)) {
                            $walker($child);
                        }
                    }
                }
            }
        };

        $walker($ast);

        return [
            'tables' => $tables,
            'migrations' => [[
                'file' => $relativePath,
                'actions' => $summary['actions'],
                'lines' => $summary['lines'],
                'tables' => array_keys($tables),
            ]],
        ];
    }

    /**
     * Walk a `Schema::create` closure and collect everything the Blueprint builds.
     *
     * Each statement inside is one fluent chain (`$table->foreignId('x')->constrained()`),
     * so we only ever look at the *outermost* node of a chain — recursing into
     * the chain itself would re-register partial definitions.
     *
     * @return array{columns: array<int, array>, indexes: array<int, string>, foreigns: array<int, array>}
     */
    private function readBlueprint(Expr\Closure $closure, string $table): array
    {
        $columns = [];
        $indexes = [];
        $foreigns = [];

        $inspect = function (Node $node) use (&$inspect, &$columns, &$indexes, &$foreigns, $table): void {
            if ($node instanceof Expr\MethodCall && $this->isBlueprintChain($node)) {
                $base = $this->baseCall($node);
                $method = $base->name instanceof Node\Identifier ? $base->name->toString() : null;
                $modifiers = $this->modifierChain($node);

                if ($method === 'foreign') {
                    $column = $this->stringValue($base->getArgs()[0]->value ?? null);

                    if ($column !== null) {
                        $foreigns[] = [
                            'column' => $column,
                            'table' => $modifiers['constrained_table'] ?? $this->deriveTable($column),
                            'references' => $modifiers['references'] ?? 'id',
                            'on_delete' => $modifiers['on_delete'] ?? null,
                        ];
                    }
                } elseif ($method !== null) {
                    $definition = $this->readColumnDefinition($method, $node, $table);

                    if ($definition !== null) {
                        $columns = array_merge($columns, $definition['columns']);
                        $indexes = array_merge($indexes, $definition['indexes']);

                        if ($definition['foreign'] !== null) {
                            $foreigns[] = $definition['foreign'];
                        }
                    }

                    // Composite indexes: $table->index(['a', 'b']) / ->unique([...])
                    if (in_array($method, ['index', 'unique', 'primary', 'fullText'], true)) {
                        $target = $base->getArgs()[0]->value ?? null;

                        if ($target instanceof Expr\Array_) {
                            $names = array_values(array_filter(array_map(
                                fn ($item) => $this->stringValue($item?->value),
                                $target->items ?? []
                            ), 'is_string'));
                            $indexes[] = $method.':'.implode(',', $names);
                        } elseif (is_string($single = $this->stringValue($target))) {
                            $indexes[] = $method.':'.$single;
                        }
                    }
                }
            }

            foreach ($node->getSubNodeNames() as $sub) {
                // The `var` of a method call is the rest of the same chain: already handled.
                if ($sub === 'var' && $node instanceof Expr\MethodCall) {
                    continue;
                }

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

        foreach ($closure->stmts as $statement) {
            $inspect($statement);
        }

        return [
            'columns' => $columns,
            'indexes' => array_values(array_unique($indexes)),
            'foreigns' => $this->dedupeForeignKeys($foreigns),
        ];
    }

    /** user_id => users (used when `constrained()` is called without a table). */
    private function deriveTable(?string $column): ?string
    {
        if ($column === null || ! str_ends_with($column, '_id')) {
            return null;
        }

        return \Illuminate\Support\Str::plural(substr($column, 0, -3));
    }

    /** True when the fluent chain starts with `$table->something(...)`. */
    private function isBlueprintChain(Expr\MethodCall $node): bool
    {
        return $this->baseCall($node)->var instanceof Expr\Variable
            && $this->baseCall($node)->var->name === 'table';
    }

    /**
     * `$table->foreignId('user_id')->constrained()->onDelete('cascade')` is one
     * expression; the definition lives in the innermost link, the modifiers in
     * the ones that follow.
     */
    private function baseCall(Expr\MethodCall $call): Expr\MethodCall
    {
        $node = $call;

        while ($node->var instanceof Expr\MethodCall) {
            $node = $node->var;
        }

        return $node;
    }

    /**
     * Turn one Blueprint column definition (plus its modifier chain) into a column.
     *
     * @return array{columns: array<int, array>, indexes: array<int, string>, foreign: ?array}|null
     */
    private function readColumnDefinition(string $method, Expr\MethodCall $call, string $table): ?array
    {
        $base = $this->baseCall($call);
        $columnName = $this->stringValue($base->getArgs()[0]->value ?? null);
        $modifiers = $this->modifierChain($call);
        $indexes = [];
        $columns = [];

        $shortcut = self::SHORTCUTS[$method] ?? null;
        $type = $shortcut['type'] ?? $method;

        // Helpers that expand into several columns (timestamps, softDeletes, morphs...)
        if ($shortcut !== null && isset($shortcut['synthetic'])) {
            foreach ($shortcut['synthetic'] as $suffix) {
                $columns[] = [
                    'name' => str_replace('%name%', (string) $columnName, $suffix),
                    'type' => str_contains($suffix, '_at') || str_contains($suffix, 'token') ? 'timestamp' : 'string',
                    'nullable' => (bool) ($shortcut['nullable'] ?? false) || (bool) ($modifiers['nullable'] ?? false),
                    'default' => null,
                    'primary' => false,
                    'unique' => false,
                    'virtual' => true,
                ];
            }

            return ['columns' => $columns, 'indexes' => [], 'foreign' => null];
        }

        if ($columnName === null || $columnName === '') {
            return null;
        }

        if ($modifiers['unique'] ?? false) {
            $indexes[] = 'unique:'.$columnName;
        }
        if ($modifiers['index'] ?? false) {
            $indexes[] = 'index:'.$columnName;
        }
        if ($modifiers['primary'] ?? ($shortcut['primary'] ?? false)) {
            $indexes[] = 'primary:'.$columnName;
        }

        $columns[] = [
            'name' => $columnName,
            'type' => $type,
            'nullable' => (bool) ($modifiers['nullable'] ?? false),
            'default' => $modifiers['default'] ?? null,
            'primary' => (bool) ($modifiers['primary'] ?? ($shortcut['primary'] ?? false)),
            'unique' => (bool) ($modifiers['unique'] ?? false),
            'unsigned' => (bool) ($shortcut['unsigned'] ?? ($modifiers['unsigned'] ?? false)),
            'comment' => $modifiers['comment'] ?? null,
            'auto_increment' => (bool) ($shortcut['primary'] ?? false),
        ];

        $foreign = null;

        if (in_array($type, ['foreignId', 'foreignUlid', 'foreignUuid'], true)) {
            $foreign = [
                'column' => $columnName,
                'table' => $modifiers['constrained_table'] ?? $this->deriveTable($columnName),
                'references' => $modifiers['references'] ?? 'id',
                'on_delete' => $modifiers['on_delete'] ?? null,
            ];
        }

        return ['columns' => $columns, 'indexes' => $indexes, 'foreign' => $foreign];
    }

    /** @return array<string, mixed> */
    private function modifierChain(Expr\MethodCall $root): array
    {
        $modifiers = [];

        $walk = function (Node $node) use (&$walk, &$modifiers): void {
            if ($node instanceof Expr\MethodCall) {
                $walk($node->var);

                $name = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
                if ($name === null) {
                    return;
                }

                $arg = $node->getArgs()[0]->value ?? null;

                match ($name) {
                    'nullable' => $modifiers['nullable'] = true,
                    'unique' => $modifiers['unique'] = true,
                    'primary' => $modifiers['primary'] = true,
                    'index' => $modifiers['index'] = true,
                    'unsigned' => $modifiers['unsigned'] = true,
                    'useCurrent' => $modifiers['default'] = 'CURRENT_TIMESTAMP',
                    'autoIncrement' => $modifiers['primary'] = true,
                    'constrained' => $modifiers['constrained_table'] = $this->stringValue($arg),
                    'on' => $modifiers['constrained_table'] = $this->stringValue($arg),
                    'references' => $modifiers['references'] = $this->stringValue($arg),
                    'onDelete' => $modifiers['on_delete'] = $this->stringValue($arg),
                    'default' => $modifiers['default'] = $this->literal($arg),
                    'comment' => $modifiers['comment'] = $this->stringValue($arg),
                    'after' => $modifiers['after'] = $this->stringValue($arg),
                    default => null,
                };
            } elseif ($node instanceof Expr\StaticCall || $node instanceof Expr\PropertyFetch || $node instanceof Expr\Variable) {
                // base of the chain
            }
        };

        $walk($root);

        return $modifiers;
    }

    /** Deduplicate foreign key definitions (they are arrays, so array_unique cannot help). */
    private function dedupeForeignKeys(array $keys): array
    {
        $out = [];
        $seen = [];

        foreach ($keys as $key) {
            if (! is_array($key) || ! isset($key['column'])) {
                continue;
            }
            $signature = $key['column'].'|'.($key['table'] ?? '').'|'.($key['references'] ?? '');
            if (isset($seen[$signature])) {
                continue;
            }
            $seen[$signature] = true;
            $out[] = $key;
        }

        return $out;
    }

    private function blankTable(string $name): array
    {
        return [
            'name' => $name,
            'columns' => [],
            'indexes' => [],
            'foreign_keys' => [],
            'migrations' => [],
            'created_by' => null,
            'dropped' => false,
        ];
    }

    private function mergeColumns(array $existing, array $incoming): array
    {
        $byName = [];
        foreach ($existing as $column) {
            $byName[$column['name']] = $column;
        }
        foreach ($incoming as $column) {
            $byName[$column['name']] = array_merge($byName[$column['name']] ?? [], $column);
        }

        return array_values($byName);
    }

    private function stringValue(?Node $node): ?string
    {
        return $node instanceof Node\Scalar\String_ ? $node->value : null;
    }

    private function literal(?Node $node): mixed
    {
        if ($node instanceof Node\Scalar\String_ || $node instanceof Node\Scalar\Int_ || $node instanceof Node\Scalar\Float_) {
            return $node->value;
        }

        if ($node instanceof Expr\ConstFetch) {
            return $node->name->toString();
        }

        return null;
    }
}
