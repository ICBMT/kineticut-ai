<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Parsers\MigrationParser;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use Illuminate\Support\Str;

/**
 * Stage 6 — rebuilds the database schema from migrations: tables, columns,
 * indexes and foreign keys, then links tables to each other so the ERD is
 * grounded in real migration code.
 */
class SchemaStage implements Stage
{
    public function __construct(private readonly MigrationParser $parser) {}

    public function name(): ScanStage
    {
        return ScanStage::Schema;
    }

    public function run(ScanContext $context): array
    {
        $index = $context->readArtifact('files');
        $graph = $this->freshGraph($context);

        $migrationFiles = array_values(array_filter(
            $index['files'] ?? [],
            fn (array $file) => str_starts_with($file['path'], 'database/migrations/') && str_ends_with($file['path'], '.php')
        ));

        usort($migrationFiles, fn ($a, $b) => strcmp($a['path'], $b['path']));

        $tables = [];
        $migrationCount = 0;
        $foreignKeys = 0;

        foreach ($migrationFiles as $file) {
            $result = $this->parser->parse($context->root.'/'.$file['path'], $file['path']);
            $migrationCount++;

            $tableNames = [];

            foreach ($result['tables'] as $name => $table) {
                $tables[$name] = array_merge($tables[$name] ?? [], $table, ['name' => $name]);
                $tables[$name]['columns'] = $this->mergeColumns($tables[$name]['columns'] ?? [], $table['columns'] ?? []);
                $tables[$name]['foreign_keys'] = array_merge($tables[$name]['foreign_keys'] ?? [], $table['foreign_keys'] ?? []);
                $tableNames[] = $name;
            }

            $label = $this->migrationLabel($file['path']);
            $key = 'migration:'.$file['path'];

            $graph->node($key, NodeType::Migration, $label, [
                'file' => $file['path'],
                'loc' => $file['lines'],
                'module' => 'Database',
                'layer' => Layer::Data->value,
                'weight' => 40,
                'meta' => [
                    'actions' => $result['migrations'][0]['actions'] ?? [],
                    'tables' => $tableNames,
                    'batch_key' => $this->timestampOf($file['path']),
                ],
            ]);

            foreach ($result['tables'] as $name => $table) {
                $graph->touch('table:'.$name, $name, [
                    'type' => NodeType::Table->value,
                    'module' => 'Database',
                    'layer' => Layer::Data->value,
                ]);
                $graph->edge($key, 'table:'.$name, EdgeKind::Migrates, [
                    'label' => in_array('create:'.$name, $result['migrations'][0]['actions'] ?? [], true) ? 'creates' : 'alters',
                ]);
            }
        }

        // ---- Enrich table nodes with their columns and foreign keys ----
        foreach ($tables as $name => $table) {
            $key = 'table:'.$name;

            if (! $graph->has($key)) {
                $graph->node($key, NodeType::Table, $name, [
                    'module' => 'Database',
                    'layer' => Layer::Data->value,
                    'meta' => ['phantom' => true],
                ]);
            }

            $columns = array_values(array_filter($table['columns'] ?? [], fn ($c) => is_array($c) && isset($c['name'])));
            $existing = $graph->nodeOrNull($key)['meta'] ?? [];

            $graph->node($key, NodeType::Table, $name, [
                'meta' => [
                    'columns' => $columns,
                    'column_count' => count($columns),
                    'foreign_keys' => $table['foreign_keys'] ?? [],
                    'indexes' => $table['indexes'] ?? [],
                    'migrations' => $table['migrations'] ?? [],
                    'derived_from_model' => $existing['derived_from_model'] ?? false,
                ],
            ]);

            foreach ($table['foreign_keys'] ?? [] as $foreign) {
                $target = $foreign['table'] ?? null;

                if (is_string($target) && $target !== '' && $target !== $name) {
                    $graph->touch('table:'.$target, $target, [
                        'type' => NodeType::Table->value,
                        'module' => 'Database',
                        'layer' => Layer::Data->value,
                    ]);
                    $graph->edge('table:'.$name, 'table:'.$target, EdgeKind::BelongsTo, [
                        'label' => $foreign['column'].' → '.$target.'.'.($foreign['references'] ?? 'id'),
                        'meta' => $foreign,
                    ]);
                    $foreignKeys++;
                }
            }
        }

        // Tables discovered only through models get a gentle "no migration found" flag.
        foreach ($graph->nodes() as $key => $node) {
            if (($node['type'] ?? '') !== NodeType::Table->value) {
                continue;
            }

            $meta = $node['meta'] ?? [];

            if (($meta['migrations'] ?? []) === [] && ! ($meta['phantom'] ?? false)) {
                $graph->node($key, NodeType::Table, $node['label'], [
                    'meta' => ['migration_missing' => true],
                ]);
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);
        $context->writeArtifact('schema', ['tables' => $tables, 'migrations' => $migrationCount]);

        $context->log(sprintf(
            'Rebuilt %s tables from %s migrations (%s foreign keys)',
            number_format(count($tables)),
            number_format($migrationCount),
            number_format($foreignKeys)
        ));

        return [
            'summary' => sprintf('%s migrations → %s tables · %s FKs', number_format($migrationCount), number_format(count($tables)), number_format($foreignKeys)),
            'metrics' => [
                'migrations' => $migrationCount,
                'tables' => count($tables),
                'foreign_keys' => $foreignKeys,
                'total_columns' => array_sum(array_map(fn ($t) => count($t['columns'] ?? []), $tables)),
            ],
        ];
    }

    private function migrationLabel(string $path): string
    {
        $base = basename($path, '.php');
        $base = preg_replace('/^\d{4}_\d{2}_\d{2}_\d{6}_/', '', $base) ?? $base;

        return Str::headline(str_replace('_', ' ', $base));
    }

    private function timestampOf(string $path): ?string
    {
        $base = basename($path);

        return preg_match('/^(\d{4}_\d{2}_\d{2}_\d{6})/', $base, $m) ? $m[1] : null;
    }

    private function mergeColumns(array $existing, array $incoming): array
    {
        $byName = [];

        foreach (array_merge($existing, $incoming) as $column) {
            if (! is_array($column) || ! isset($column['name'])) {
                continue;
            }
            $byName[$column['name']] = array_merge($byName[$column['name']] ?? [], $column);
        }

        return array_values($byName);
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
