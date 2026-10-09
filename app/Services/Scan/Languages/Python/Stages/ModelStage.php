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

/**
 * Stage 8 of the Python pipeline — the database, as the code describes it.
 *
 * A Django model is a class with typed class attributes; a SQLAlchemy model is
 * a class with a `__tablename__`. Either way the columns, the foreign keys and
 * the relationships are written out in the class body, so they can be read
 * straight off the declaration the previous stage already produced.
 *
 * The output is deliberately identical to the Laravel one — the same `table:`
 * nodes, the same `columns` / `foreign_keys` / `relations` metadata, the same
 * `persists` and `owns` edges — because that is what the inspector, the ER
 * panel and the model insights already know how to draw.
 */
class ModelStage implements Stage
{
    /** Field types that mean "this column holds a reference to another table". */
    private const RELATIONS = [
        'foreignkey' => ['belongsTo', 'one'],
        'onetoonefield' => ['hasOne', 'one'],
        'manytomanyfield' => ['belongsToMany', 'many'],
        'relationship' => ['belongsToMany', 'many'],
        'backref' => ['hasMany', 'many'],
    ];

    /** Django field constructor → the column type a reader expects. */
    private const COLUMN_TYPES = [
        'charfield' => 'string', 'textfield' => 'text', 'slugfield' => 'string', 'emailfield' => 'string',
        'urlfield' => 'string', 'uuidfield' => 'uuid', 'integerfield' => 'integer', 'bigintegerfield' => 'bigint',
        'smallintegerfield' => 'smallint', 'positiveintegerfield' => 'integer', 'floatfield' => 'float',
        'decimalfield' => 'decimal', 'booleanfield' => 'boolean', 'datefield' => 'date', 'datetimefield' => 'datetime',
        'timefield' => 'time', 'durationfield' => 'interval', 'jsonfield' => 'json', 'binaryfield' => 'binary',
        'filefield' => 'string', 'imagefield' => 'string', 'autofield' => 'bigint', 'bigautofield' => 'bigint',
        'column' => 'column',
    ];

    public function __construct(private readonly PythonIndex $index) {}

    public function name(): ScanStage
    {
        return ScanStage::Models;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $modules = $this->index->modules($context);

        $typeKeys = $symbols['types'] ?? [];
        $modelIndex = $this->modelIndex($modules, $typeKeys);
        $models = [];
        $tables = [];
        $relations = 0;
        $foreignKeys = 0;

        foreach ($modules as $module) {
            $dotted = $module['module'];
            $parsed = $module['parsed'];

            foreach ($parsed['types'] ?? [] as $type) {
                $key = $typeKeys[$dotted.'.'.($type['name'] ?? '')] ?? null;

                if ($key === null) {
                    continue;
                }

                $isDjango = false;
                $isSqlAlchemy = false;

                foreach ($type['bases'] ?? [] as $base) {
                    $name = strtolower((string) ($base['name'] ?? ''));

                    if ($name === 'model' || str_ends_with($name, '.model')) {
                        $isDjango = true;
                    }

                    if (str_contains($name, 'declarative') || $name === 'base' || str_ends_with($name, 'base')) {
                        $isSqlAlchemy = true;
                    }
                }

                if (! $isDjango && ! $isSqlAlchemy) {
                    continue;
                }

                $fields = $type['fields'] ?? [];
                $table = $this->tableName($type, $fields, $isDjango);
                $columns = [];
                $keySpecs = [];
                $relationList = [];

                foreach ($fields as $field) {
                    $value = (string) ($field['value'] ?? '');

                    // Django declares a column's type with the field it calls:
                    // `title = models.CharField(...)`. An annotation wins when
                    // there is one, because it is the more explicit statement.
                    $fieldType = strtolower($this->baseName((string) ($field['type'] ?? '')));

                    if ($fieldType === '') {
                        $fieldType = strtolower($this->callName($value));
                    }

                    // A relationship is a field whose constructor is one.
                    if (isset(self::RELATIONS[$fieldType])) {
                        [$relation, $cardinality] = self::RELATIONS[$fieldType];
                        $target = $this->firstString($value);

                        $relationList[] = [
                            'method' => (string) $field['name'],
                            'type' => $relation,
                            'target' => $target,
                            'target_fqcn' => $target,
                            'cardinality' => $cardinality,
                            'line' => $field['line'] ?? null,
                        ];

                        if (in_array($relation, ['belongsTo', 'hasOne'], true)) {
                            $column = (string) $field['name'].'_id';

                            // Django and SQLAlchemy both store the key in a
                            // `*_id` column, so the table shows it the way a
                            // reader of the schema would find it.
                            $columns[] = [
                                'name' => $column,
                                'type' => 'bigint',
                                'nullable' => str_contains($value, 'null=True'),
                                'unique' => str_contains($value, 'unique=True'),
                                'primary' => false,
                                'default' => null,
                                'line' => $field['line'] ?? null,
                                'foreign' => $target,
                            ];
                            $keySpecs[] = ['column' => $column, 'target' => $target];
                        }

                        continue;
                    }

                    if ($isSqlAlchemy) {
                        // `id = Column(Integer, primary_key=True)` or `db.Column(db.String(80))`.
                        if (preg_match('/Column\s*\(\s*([^,\)]*)/i', $value, $match) === 1) {
                            $sqlType = strtolower(trim($match[1]));
                            if (str_contains($sqlType, '.')) {
                                $parts = explode('.', $sqlType);
                                $sqlType = (string) end($parts);
                            }

                            $columns[] = [
                                'name' => (string) $field['name'],
                                'type' => self::COLUMN_TYPES[$sqlType] ?? ($sqlType !== '' ? $sqlType : 'column'),
                                'nullable' => str_contains($value, 'nullable=False') ? false : true,
                                'unique' => str_contains($value, 'unique=True'),
                                'primary' => str_contains($value, 'primary_key=True'),
                                'default' => $this->keywordValue($value, 'default'),
                                'line' => $field['line'] ?? null,
                            ];
                        }

                        continue;
                    }

                    // Django: `title = models.CharField(max_length=200)`.
                    $columns[] = [
                        'name' => (string) $field['name'],
                        'type' => self::COLUMN_TYPES[$fieldType] ?? ($fieldType !== '' ? $fieldType : 'string'),
                        'nullable' => str_contains($value, 'null=True'),
                        'unique' => str_contains($value, 'unique=True'),
                        'primary' => str_contains($value, 'primary_key=True'),
                        'default' => $this->keywordValue($value, 'default'),
                        'line' => $field['line'] ?? null,
                    ];
                }

                // Django and SQLAlchemy both add an `id` the code never writes.
                if ($columns !== [] && ! array_filter($columns, fn (array $column) => $column['primary'])) {
                    array_unshift($columns, [
                        'name' => 'id', 'type' => 'bigint', 'nullable' => false, 'unique' => true,
                        'primary' => true, 'default' => null, 'line' => $type['line'] ?? null, 'implicit' => true,
                    ]);
                }

                $tableKey = 'table:'.$table;

                $graph->touch($tableKey, $table, [
                    'type' => NodeType::Table->value,
                    'module' => 'Database',
                    'layer' => Layer::Data->value,
                    'weight' => NodeType::Table->importance(),
                ]);

                $graph->node($tableKey, NodeType::Table, $table, [
                    'loc' => count($columns),
                    'meta' => [
                        'columns' => $columns,
                        'column_count' => count($columns),
                        'foreign_keys' => [],
                        'indexes' => [],
                        'derived_from_model' => true,
                        'model' => $dotted.'.'.$type['name'],
                        'orm' => $isDjango ? 'django-orm' : 'sqlalchemy',
                    ],
                ]);

                $graph->edge($key, $tableKey, EdgeKind::Persists, ['label' => 'persists']);

                $graph->node($key, $graph->typeOf($key) ?? NodeType::Model, '', [
                    'meta' => [
                        'table' => $table,
                        'orm' => $isDjango ? 'django-orm' : 'sqlalchemy',
                        'relations' => $relationList,
                        'columns' => $columns,
                        'column_count' => count($columns),
                        'fillable' => array_values(array_map(fn (array $column) => $column['name'], $columns)),
                    ],
                ]);

                // Foreign keys: real table-to-table edges, which is what makes
                // the ER view of a Django project readable.
                foreach ($keySpecs as $spec) {
                    foreach ($spec['target'] !== null ? [$spec['target']] : [] as $target) {
                        $targetModel = $this->findModel($target, $modelIndex);

                        if ($targetModel === null) {
                            continue;
                        }

                        $graph->edge($tableKey, $targetModel['tableKey'], EdgeKind::BelongsTo, [
                            'label' => $spec['column'].' → '.$targetModel['table'].'.id',
                            'meta' => ['column' => $spec['column'], 'target' => $targetModel['table']],
                        ]);

                        $graph->node($tableKey, NodeType::Table, '', [
                            'meta' => [
                                'foreign_keys' => [[
                                    'column' => $spec['column'],
                                    'table' => $targetModel['table'],
                                    'references' => 'id',
                                    'on_delete' => null,
                                ]],
                            ],
                        ]);

                        $foreignKeys++;
                    }
                }

                foreach ($relationList as $relation) {
                    if (($relation['type'] ?? '') === 'belongsToMany') {
                        continue;
                    }

                    $target = $this->findModel((string) ($relation['target'] ?? ''), $modelIndex);

                    if ($target === null || $target['key'] === $key) {
                        continue;
                    }

                    $graph->edge(
                        $key,
                        $target['key'],
                        in_array($relation['type'], ['hasMany', 'hasOne'], true) ? EdgeKind::Owns : EdgeKind::RelatesTo,
                        ['label' => $relation['method'].'()'],
                    );

                    $relations++;
                }

                $models[$dotted.'.'.$type['name']] = [
                    'table' => $table,
                    'orm' => $isDjango ? 'django-orm' : 'sqlalchemy',
                    'columns' => count($columns),
                    'relations' => count($relationList),
                    'file' => $module['path'],
                ];
                $tables[$table] = ['columns' => $columns, 'model' => $dotted.'.'.$type['name']];
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('models', ['models' => $models, 'tables' => $tables]);

        $context->log(sprintf(
            '%d models · %d tables · %d relationships · %d foreign keys',
            count($models),
            count($tables),
            $relations,
            $foreignKeys,
        ));

        return [
            'summary' => sprintf('%d models · %d relationships', count($models), $relations),
            'metrics' => [
                'models' => count($models),
                'model_relations' => $relations,
                'tables' => count($tables),
                'foreign_keys' => $foreignKeys,
            ],
        ];
    }

    /**
     * Django uses `<app>_<classname>` and mostly writes `Meta.db_table` when it
     * differs; SQLAlchemy states `__tablename__` outright.
     */
    private function tableName(array $type, array $fields, bool $isDjango): string
    {
        foreach ($fields as $field) {
            if (($field['name'] ?? '') === '__tablename__') {
                $stated = $this->firstString((string) ($field['value'] ?? ''));

                if ($stated !== null) {
                    return $stated;
                }
            }
        }

        $name = (string) $type['name'];

        // `BookmarkCategory` → `bookmark_category`, the Django default.
        $snake = strtolower((string) preg_replace('/(?<!^)[A-Z]|(?<=[a-z0-9])[A-Z]/', '_$0', $name));

        return $snake;
    }

    /**
     * Every model class in the project, by simple name — so a relationship can
     * find its target without re-walking the modules for each field.
     *
     * @return array<string, array{key:string, table:string, tableKey:string}>
     */
    private function modelIndex(array $modules, array $typeKeys): array
    {
        $index = [];

        foreach ($modules as $module) {
            $dotted = $module['module'];

            foreach ($module['parsed']['types'] ?? [] as $type) {
                $key = $typeKeys[$dotted.'.'.($type['name'] ?? '')] ?? null;

                if ($key === null) {
                    continue;
                }

                $table = $this->tableName($type, $type['fields'] ?? [], true);

                $index[(string) ($type['name'] ?? '')] ??= ['key' => $key, 'table' => $table, 'tableKey' => 'table:'.$table];
            }
        }

        return $index;
    }

    /** Find the model class a relationship names, and the table it maps to. */
    private function findModel(?string $name, array $modelIndex): ?array
    {
        if ($name === null || $name === '') {
            return null;
        }

        if (str_contains($name, '.')) {
            $segments = explode('.', $name);
            $name = (string) end($segments);
        }

        return $modelIndex[$name] ?? null;
    }

    /** `max_length=200` → `200`; `default=now` → `now`. */
    private function keywordValue(string $value, string $keyword): ?string
    {
        if (preg_match('/'.$keyword.'\s*=\s*([^,\)]+)/', $value, $match) === 1) {
            return trim($match[1], ' \'"');
        }

        return null;
    }

    /** The first quoted string inside a field value: `ForeignKey('Bookmark')`. */
    private function firstString(string $value): ?string
    {
        if (preg_match('/[\'"]([A-Za-z_][A-Za-z0-9_.]*)[\'"]/', $value, $match) === 1) {
            return $match[1];
        }

        return null;
    }

    /** `models.ForeignKey("User", ...)` → `ForeignKey`. */
    private function callName(string $value): string
    {
        if (preg_match('/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)\s*\(/', trim($value), $match) === 1) {
            return $match[1];
        }

        return '';
    }

    private function baseName(string $type): string
    {
        $type = trim($type);

        if ($type === '') {
            return '';
        }

        $segments = explode('.', $type);

        return (string) end($segments);
    }
}
