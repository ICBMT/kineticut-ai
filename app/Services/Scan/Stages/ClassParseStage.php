<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\ClassClassifier;
use App\Services\Scan\Parsers\PhpFileAnalyzer;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use App\Support\NameResolver;

/**
 * Stage 3 — the heavy lifting. Parses every PHP file into an AST, classifies
 * each class, and records the Laravel-specific behaviour it found (queued jobs,
 * dispatched events, rendered views, relation methods, middleware, bindings…).
 */
class ClassParseStage implements Stage
{
    private const MAX_FILES = 6_000;

    public function __construct(
        private readonly PhpFileAnalyzer $analyzer,
        private readonly ClassClassifier $classifier,
    ) {}

    public function name(): ScanStage
    {
        return ScanStage::Classes;
    }

    public function run(ScanContext $context): array
    {
        $index = $context->readArtifact('files');
        $files = $index['files'] ?? [];

        $graph = $this->freshGraph($context);
        $classes = [];
        $failures = [];
        $parsed = 0;

        foreach ($files as $file) {
            if ($parsed >= self::MAX_FILES) {
                $context->log('Reached the '.number_format(self::MAX_FILES).' file parsing ceiling; remaining files were skipped.', 'warn');

                break;
            }

            if ($file['ext'] !== 'php' || ! $this->shouldParse($file['path'])) {
                continue;
            }

            $absolute = $context->root.'/'.$file['path'];
            $parsed++;

            $found = $this->analyzer->analyze($absolute, $file['path']);

            if ($found === []) {
                $code = @file_get_contents($absolute);

                // Anonymous classes (migrations, one-off factories) legitimately
                // yield nothing; only flag files that genuinely failed to parse.
                if ($code !== false
                    && $this->analyzer->looksLikePhpClass($code)
                    && ! preg_match('/return\s+new\s+class\b/', $code)) {
                    $failures[] = $file['path'];
                }

                continue;
            }

            foreach ($found as $class) {
                $class['lines'] = $file['lines'];
                $classes[$class['fqcn']] = $class;

                $type = $this->classifier->classify($class);
                $module = $this->classifier->moduleFor($file['path'], $class['fqcn']);
                $key = 'class:'.$class['fqcn'];

                $graph->node($key, $type, $class['label'], [
                    'fqcn' => $class['fqcn'],
                    'file' => $file['path'],
                    'line' => $class['line'],
                    'module' => $module,
                    'parent' => $this->parentDirectoryKey($file['path']),
                    'loc' => $class['loc'],
                    'weight' => $type->importance(),
                    'meta' => [
                        'namespace' => $class['namespace'] !== '' ? $class['namespace'] : '\\',
                        'kind' => $class['kind'],
                        'extends' => $class['extends'],
                        'abstract' => $class['abstract'],
                        'final' => $class['final'],
                        'doc' => $class['docblock'],
                        'methods' => array_map(fn ($m) => [
                            'name' => $m['name'],
                            'visibility' => $m['visibility'],
                            'static' => $m['static'],
                            'line' => $m['line'],
                            'loc' => $m['loc'],
                            'params' => $m['params'],
                            'return' => $m['return'],
                            'doc' => $m['docblock'],
                            'captures' => $m['captures'],
                        ], $class['methods']),
                        'properties' => array_map(fn ($p) => [
                            'name' => $p['name'],
                            'type' => $p['type'],
                            'visibility' => $p['visibility'],
                            'static' => $p['static'],
                            'value' => $p['values'][0]['value'] ?? null,
                        ], $class['properties']),
                        'constants' => $class['constants'],
                        'traits' => $class['traits'],
                        'implements' => $class['implements'],
                        'type_refs' => array_values(array_unique($class['type_refs'])),
                        'static_calls' => array_values(array_unique($class['static_calls'])),
                        'instantiated' => array_values(array_unique($class['instantiated'])),
                        'method_count' => count($class['methods']),
                        'property_count' => count($class['properties']),
                    ],
                ]);

                $this->applySemanticCaptures($graph, $key, $type, $class);
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);
        $context->writeArtifact('classes', ['classes' => $classes, 'failures' => $failures]);

        if ($failures !== []) {
            $context->log(count($failures).' file(s) could not be parsed (syntax error or PHP 8.4+ only syntax).', 'warn', [
                'files' => array_slice($failures, 0, 12),
            ]);
        }

        $byType = [];
        foreach ($classes as $class) {
            $type = $this->classifier->classify($class)->value;
            $byType[$type] = ($byType[$type] ?? 0) + 1;
        }
        arsort($byType);

        $context->log(sprintf(
            'Parsed %s PHP files → %s classes',
            number_format($parsed),
            number_format(count($classes))
        ));

        return [
            'summary' => sprintf('%s classes from %s files', number_format(count($classes)), number_format($parsed)),
            'metrics' => [
                'classes' => count($classes),
                'php_files_parsed' => $parsed,
                'class_types' => $byType,
                'unparsed_files' => count($failures),
            ],
        ];
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

    /**
     * Convert the Laravel idioms discovered inside a class into graph edges.
     * Only targets we can name without ambiguity are linked here; everything
     * else is resolved in the Links stage once the class index is complete.
     */
    private function applySemanticCaptures(GraphBuilder $graph, string $key, NodeType $type, array $class): void
    {
        foreach ($class['methods'] as $method) {
            $methodName = $method['name'];

            foreach ($method['captures'] as $capture) {
                $value = $capture['value'] ?? null;

                switch ($capture['type'] ?? '') {
                    case 'view':
                        if (is_string($value) && $value !== '') {
                            $graph->touch('view:'.$value, $value, ['type' => NodeType::View->value, 'module' => 'Views']);
                            $graph->edge($key, 'view:'.$value, EdgeKind::Renders, [
                                'label' => $methodName.'()',
                                'meta' => ['method' => $methodName],
                            ]);
                        }
                        break;

                    case 'dispatch':
                    case 'dispatch_class':
                        $target = $this->classKeyFor($value);
                        if ($target !== null) {
                            $graph->touch($target, NameResolver::short(ltrim((string) $value, '\\')), [
                                'type' => NodeType::Job->value,
                                'module' => 'Jobs',
                            ]);
                            $graph->edge($key, $target, EdgeKind::Dispatches, [
                                'label' => $methodName.'()',
                                'meta' => ['method' => $methodName],
                            ]);
                        }
                        break;

                    case 'event':
                    case 'broadcast':
                        $target = $this->classKeyFor($value);
                        if ($target !== null) {
                            $graph->touch($target, NameResolver::short(ltrim((string) $value, '\\')), [
                                'type' => NodeType::Event->value,
                                'module' => 'Events',
                            ]);
                            $graph->edge($key, $target, EdgeKind::Dispatches, [
                                'label' => $methodName.'()',
                                'meta' => ['method' => $methodName],
                            ]);
                        }
                        break;

                    case 'listener':
                        $target = $this->classKeyFor($value);
                        if ($target !== null) {
                            $graph->touch($target, NameResolver::short(ltrim((string) $value, '\\')), [
                                'type' => NodeType::Event->value,
                                'module' => 'Events',
                            ]);
                            $graph->edge($key, $target, EdgeKind::Listens, ['label' => 'listens for '.$methodName.'()']);
                        }
                        break;

                    case 'relation':
                        $target = $capture['target'] ?? null;
                        $relation = $capture['relation'];

                        if (is_string($target) && $target !== '') {
                            $targetKey = 'class:'.ltrim($target, '\\');
                            $graph->touch($targetKey, NameResolver::short(ltrim($target, '\\')), [
                                'type' => NodeType::Model->value,
                                'module' => 'Models',
                            ]);

                            $kind = match ($relation) {
                                'belongsTo' => EdgeKind::BelongsTo,
                                'belongsToMany', 'morphToMany', 'morphedByMany' => EdgeKind::Pivot,
                                'hasMany', 'hasOne', 'morphMany', 'morphOne', 'hasManyThrough', 'hasOneThrough' => EdgeKind::Owns,
                                default => EdgeKind::RelatesTo,
                            };

                            $graph->edge($key, $targetKey, $kind, [
                                'label' => $methodName.'()',
                                'meta' => ['method' => $methodName, 'relation' => $relation],
                            ]);
                        }
                        break;

                    case 'middleware':
                    case 'without_middleware':
                        $name = is_string($value) && $value !== '' ? $value : 'custom';
                        $middlewareKey = 'middleware:'.$name;
                        $graph->touch($middlewareKey, $name, [
                            'type' => NodeType::Middleware->value,
                            'module' => 'Http',
                            'layer' => \App\Enums\Layer::Http->value,
                        ]);

                        if ($capture['type'] === 'middleware') {
                            $graph->edge($middlewareKey, $key, EdgeKind::Guards, [
                                'label' => 'guards '.$methodName.'()',
                                'meta' => ['method' => $methodName],
                            ]);
                        } else {
                            $graph->edge($key, $middlewareKey, EdgeKind::Guards, [
                                'label' => 'skips '.$name,
                                'meta' => ['method' => $methodName],
                            ]);
                        }
                        break;

                    case 'authorize':
                        if (is_string($value) && $value !== '') {
                            $ability = trim(explode(',', $value)[0]);
                            if ($ability !== '') {
                                $graph->node('ability:'.$ability, NodeType::Policy, 'can '.$ability, [
                                    'module' => 'Authorization',
                                    'weight' => 40,
                                    'meta' => ['ability' => $ability],
                                ]);
                                $graph->edge($key, 'ability:'.$ability, EdgeKind::Authorizes, [
                                    'label' => 'authorize('.$ability.')',
                                    'meta' => ['method' => $methodName],
                                ]);
                            }
                        }
                        break;
                }
            }
        }

        // Eloquent specific meta: fillable, casts, table name, scopes.
        if ($type === NodeType::Model) {
            $graph->node($key, $type, $class['label'], [
                'meta' => $this->modelMeta($class),
            ]);
        }
    }

    /** Turn a captured class reference into a graph key, ignoring literals. */
    private function classKeyFor(mixed $value): ?string
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        if (str_contains($value, '\\')) {
            return 'class:'.ltrim($value, '\\');
        }

        return null;
    }

    private function modelMeta(array $class): array
    {
        $meta = [];
        $constants = collect($class['constants'])->keyBy('name');

        foreach ($class['properties'] as $property) {
            $name = $property['name'];
            $value = $property['values'][0]['value'] ?? null;

            if (in_array($name, ['fillable', 'guarded', 'hidden', 'appends', 'casts', 'with', 'table', 'primaryKey', 'timestamps', 'incrementing', 'perPage', 'connection'], true)) {
                $meta['eloquent'][$name] = $value;
            }
        }

        $relations = [];
        $scopes = [];
        $accessors = [];

        foreach ($class['methods'] as $method) {
            foreach ($method['captures'] as $capture) {
                if (($capture['type'] ?? '') === 'relation') {
                    $relations[] = [
                        'method' => $method['name'],
                        'type' => $capture['relation'],
                        'target' => $capture['target'] ?? null,
                        'line' => $method['line'],
                    ];
                }
            }

            if (str_starts_with($method['name'], 'scope')) {
                $scopes[] = lcfirst(substr($method['name'], 5));
            }
            if (preg_match('/^get(.+)Attribute$/', $method['name'], $m) || $method['name'] === 'casts') {
                $accessors[] = $method['name'];
            }
        }

        if ($relations !== []) {
            $meta['relations'] = $relations;
        }
        if ($scopes !== []) {
            $meta['scopes'] = array_values(array_unique($scopes));
        }
        if ($accessors !== []) {
            $meta['accessors'] = $accessors;
        }

        $meta['soft_deletes'] = in_array('Illuminate\\Database\\Eloquent\\SoftDeletes', array_map(fn ($t) => ltrim((string) $t, '\\'), $class['traits']), true);
        $meta['table'] = $meta['eloquent']['table'] ?? \Illuminate\Support\Str::snake(\Illuminate\Support\Str::pluralStudly($class['label']));

        return $meta;
    }

    private function shouldParse(string $path): bool
    {
        if (str_starts_with($path, 'vendor/') || str_starts_with($path, 'node_modules/')) {
            return false;
        }

        if (str_contains($path, '/resources/views/')) {
            return false; // blade files are handled by the view stage
        }

        foreach (['app/', 'routes/', 'database/', 'tests/', 'config/', 'bootstrap/', 'src/', 'packages/', 'modules/', 'domain/'] as $prefix) {
            if (str_starts_with($path, $prefix)) {
                return true;
            }
        }

        return ! str_contains($path, '/');
    }

    private function parentDirectoryKey(string $path): ?string
    {
        $dir = dirname($path);
        $dir = $dir === '.' ? '' : $dir;

        // Directory nodes only exist two levels deep; walk up to the nearest one.
        while ($dir !== '' && substr_count($dir, '/') > 1) {
            $dir = dirname($dir);
        }

        return $dir === '' ? null : 'dir:'.$dir;
    }
}
