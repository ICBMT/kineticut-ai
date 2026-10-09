<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use Illuminate\Support\Str;

/**
 * Stage 5 — takes the models found during class parsing and works out which
 * database table each one owns, which columns it exposes and how the models
 * relate to one another.
 */
class ModelStage implements Stage
{
    public function name(): ScanStage
    {
        return ScanStage::Models;
    }

    public function run(ScanContext $context): array
    {
        $classes = $context->readArtifact('classes')['classes'] ?? [];
        $graph = $this->freshGraph($context);

        $models = [];
        $relations = 0;
        $withoutTable = 0;

        foreach ($classes as $fqcn => $class) {
            $meta = $class['_type'] ?? null;

            if ($meta !== null && $meta !== 'model') {
                continue;
            }

            if (! $this->isModel($class)) {
                continue;
            }

            $key = 'class:'.$fqcn;
            $table = $this->tableName($class);
            $tableKey = 'table:'.$table;

            $relationList = [];
            $scopes = [];
            $accessors = [];
            $fillable = [];
            $casts = [];
            $hidden = [];
            $appends = [];
            $usesSoftDeletes = false;
            $usesTimestamps = true;

            foreach ($class['properties'] as $property) {
                $value = $property['values'][0]['value'] ?? null;
                $name = $property['name'];

                if ($name === 'fillable' && is_array($value)) {
                    $fillable = array_values(array_filter($value, 'is_string'));
                }
                if (in_array($name, ['guarded', 'hidden'], true) && is_array($value)) {
                    $hidden = array_values(array_filter($value, 'is_string'));
                }
                if ($name === 'casts' && is_array($value)) {
                    $casts = $value;
                }
                if ($name === 'appends' && is_array($value)) {
                    $appends = array_values(array_filter($value, 'is_string'));
                }
                if ($name === 'timestamps' && $value === false) {
                    $usesTimestamps = false;
                }
            }

            foreach ($class['methods'] as $method) {
                foreach ($method['captures'] as $capture) {
                    if (($capture['type'] ?? '') === 'relation') {
                        $target = $capture['target'] ?? null;

                        $relationList[] = [
                            'method' => $method['name'],
                            'type' => $capture['relation'],
                            'target' => $target ? Str::afterLast(ltrim($target, '\\'), '\\') : null,
                            'target_fqcn' => $target,
                            'line' => $method['line'],
                        ];

                        if (is_string($target) && $target !== '') {
                            $targetKey = 'class:'.ltrim($target, '\\');
                            $graph->touch($targetKey, Str::afterLast(ltrim($target, '\\'), '\\'), [
                                'type' => NodeType::Model->value,
                                'module' => 'Models',
                                'layer' => \App\Enums\Layer::Domain->value,
                            ]);

                            $kind = match ($capture['relation']) {
                                'belongsTo' => EdgeKind::BelongsTo,
                                'belongsToMany', 'morphToMany', 'morphedByMany' => EdgeKind::Pivot,
                                'hasMany', 'hasOne', 'morphMany', 'morphOne' => EdgeKind::Owns,
                                default => EdgeKind::RelatesTo,
                            };

                            $graph->edge($key, $targetKey, $kind, [
                                'label' => $method['name'].'()',
                                'meta' => ['relation' => $capture['relation'], 'method' => $method['name']],
                            ]);
                            $relations++;
                        }
                    }
                }

                if (str_starts_with($method['name'], 'scope')) {
                    $scopes[] = Str::camel(Str::after($method['name'], 'scope'));
                }

                if (preg_match('/^(get|set)(.+)Attribute$/', $method['name']) || $method['name'] === 'newFactory') {
                    $accessors[] = $method['name'];
                }
            }

            $usesSoftDeletes = in_array('Illuminate\\Database\\Eloquent\\SoftDeletes', array_map(
                fn ($t) => ltrim((string) $t, '\\'),
                $class['traits']
            ), true)
                || in_array('SoftDeletes', array_map(fn ($t) => class_basename((string) $t), $class['traits']), true);

            $tableNode = $graph->nodeOrNull($tableKey);

            if ($tableNode === null) {
                $withoutTable++;
            }

            $graph->node($key, NodeType::Model, $class['label'], [
                'fqcn' => $fqcn,
                'file' => $class['file'],
                'line' => $class['line'],
                'loc' => $class['loc'],
                'module' => 'Models',
                'weight' => NodeType::Model->importance() + min(12, count($relationList) * 2),
                'meta' => [
                    'table' => $table,
                    'fillable' => $fillable,
                    'casts' => $casts,
                    'hidden' => $hidden,
                    'appends' => $appends,
                    'relations' => $relationList,
                    'scopes' => array_values(array_unique($scopes)),
                    'accessors' => array_values(array_unique($accessors)),
                    'soft_deletes' => $usesSoftDeletes,
                    'timestamps' => $usesTimestamps,
                    'factory' => file_exists($context->root.'/database/factories/'.$class['label'].'Factory.php')
                        ? 'database/factories/'.$class['label'].'Factory.php'
                        : null,
                    'doc' => $class['docblock'],
                ],
            ]);

            $graph->touch($tableKey, $table, [
                'type' => NodeType::Table->value,
                'module' => 'Database',
                'layer' => \App\Enums\Layer::Data->value,
                'meta' => ['derived_from_model' => true],
            ]);

            $graph->edge($key, $tableKey, EdgeKind::Persists, [
                'label' => 'writes to',
                'meta' => ['table' => $table],
            ]);

            $models[$fqcn] = [
                'fqcn' => $fqcn,
                'table' => $table,
                'relations' => $relationList,
                'fillable' => $fillable,
                'casts' => $casts,
                'soft_deletes' => $usesSoftDeletes,
                'file' => $class['file'],
            ];
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);
        $context->writeArtifact('models', ['models' => $models]);

        return [
            'summary' => sprintf('%s models · %s relationships', number_format(count($models)), number_format($relations)),
            'metrics' => [
                'models' => count($models),
                'model_relations' => $relations,
                'models_without_table' => $withoutTable,
            ],
        ];
    }

    private function isModel(array $class): bool
    {
        $extends = strtolower(ltrim((string) ($class['extends'] ?? ''), '\\'));

        if (str_contains($extends, 'model') && ! str_contains($extends, 'resource')) {
            return true;
        }

        if (str_starts_with($class['namespace'] ?? '', 'App\\Models')) {
            return true;
        }

        $traits = array_map(fn ($t) => class_basename((string) $t), $class['traits'] ?? []);
        foreach (['SoftDeletes', 'HasFactory', 'Pivot'] as $trait) {
            if (in_array($trait, $traits, true)) {
                return true;
            }
        }

        return false;
    }

    private function tableName(array $class): string
    {
        foreach ($class['properties'] as $property) {
            if ($property['name'] === 'table') {
                $value = $property['values'][0]['value'] ?? null;
                if (is_string($value) && $value !== '') {
                    return $value;
                }
            }
        }

        return Str::snake(Str::pluralStudly($class['label']));
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
