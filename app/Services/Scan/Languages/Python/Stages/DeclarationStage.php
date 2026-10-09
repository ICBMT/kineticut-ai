<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python\Stages;

use App\Enums\EdgeKind;
use App\Enums\Language;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Python\PythonIndex;
use App\Services\Scan\Languages\Python\PythonSymbolClassifier;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;

/**
 * Stage 4 of the Python pipeline — classes, functions, methods and the modules
 * that hold them.
 *
 * This is where a folded pile of `.py` files becomes a map of things with
 * names. Every module that declares something gets a node, every class and
 * function hangs off it with a `groups` edge, and inheritance is recorded as
 * `extends` or `implements` — the three relationships that make a Python
 * project legible, because `import` is how Python says "this depends on that"
 * and a class header is how it says "this replaces that".
 *
 * The stage also writes down what the later stages need but cannot recover
 * cheaply: which names each module imported and from where, and the raw call
 * sites with their enclosing class or function.
 */
class DeclarationStage implements Stage
{
    public function __construct(
        private readonly PythonIndex $index,
        private readonly PythonSymbolClassifier $classifier,
    ) {}

    public function name(): ScanStage
    {
        return ScanStage::Declarations;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $modules = $this->index->modules($context);

        $symbols = [
            'types' => [],
            'types_by_name' => [],
            'functions' => [],
            'functions_by_name' => [],
            'methods' => [],
            'modules' => [],
            'files' => [],
        ];

        $declarations = ['types' => [], 'functions' => [], 'members' => [], 'modules' => []];
        $variables = [];
        $callSites = [];
        $imports = [];
        $references = [];
        $inheritances = [];
        $counts = ['modules' => 0, 'types' => 0, 'functions' => 0, 'members' => 0, 'files' => 0, 'entry' => 0];

        $moduleKeys = [];

        // ---- pass one: the modules themselves -------------------------------
        foreach ($modules as $module) {
            $dotted = $module['module'];
            $parsed = $module['parsed'];
            $declares = ($parsed['types'] ?? []) !== [] || ($parsed['functions'] ?? []) !== [];

            // An entry module *is* its own node — `manage.py` should read as
            // "this starts the project", not as another folder of code.
            $key = $graph->has('entry:'.$dotted) ? 'entry:'.$dotted : $this->index->moduleKey($dotted);
            $moduleKeys[$dotted] = $key;

            if (! $graph->has($key) && $declares) {
                $graph->node($key, NodeType::Namespace, $dotted, [
                    'file' => $module['path'],
                    'module' => str_contains($dotted, '.') ? explode('.', $dotted)[0] : $dotted,
                    'parent' => $this->directoryKey($module['path']),
                    'loc' => $module['lines'],
                    'layer' => Layer::Structure->value,
                    'weight' => NodeType::Namespace->importance(),
                    'meta' => [
                        'namespace' => $dotted,
                        'language' => Language::Python->value,
                        'kind' => basename($module['path']) === '__init__.py' ? 'package' : 'module',
                        'path' => $module['path'],
                        'doc' => $parsed['doc'] ?? null,
                        'lines' => $module['lines'],
                    ],
                ]);

                $counts['modules']++;
            }

            if ($graph->has($key)) {
                // Nesting: `app.bookmarks.models` hangs under `app.bookmarks`.
                $parentModule = $this->parentModule($dotted);

                if ($parentModule !== null && isset($moduleKeys[$parentModule]) && $moduleKeys[$parentModule] !== $key) {
                    $graph->edge($moduleKeys[$parentModule], $key, EdgeKind::Groups, ['label' => 'package']);
                } elseif (($dir = $this->directoryKey($module['path'])) !== null && $graph->has($dir) && $dir !== $key) {
                    $graph->edge($dir, $key, EdgeKind::Groups, ['label' => 'folder']);
                }
            }

            $symbols['files'][$module['path']] = ['module' => $dotted, 'key' => $key];
            $symbols['modules'][$dotted] = $key;
            $declarations['modules'][$dotted] = [
                'key' => $key,
                'file' => $module['path'],
                'lines' => $module['lines'],
                'doc' => $parsed['doc'] ?? null,
                'types' => count($parsed['types'] ?? []),
                'functions' => count($parsed['functions'] ?? []),
            ];
            $counts['files']++;

            if ($graph->has('entry:'.$dotted)) {
                $counts['entry']++;
            }

            // ---- what this module imports, for the reference stage ----------
            $imports[$dotted] = $this->importMap($parsed['imports'] ?? [], $dotted);

            foreach ($parsed['imports'] ?? [] as $import) {
                $references[] = [
                    'kind' => 'import',
                    'module' => $dotted,
                    'file' => $module['path'],
                    'target' => $import['module'] ?? '',
                    'name' => null,
                    'alias' => $import['alias'] ?? null,
                    'line' => $import['line'] ?? null,
                    'relative' => (int) ($import['relative'] ?? 0),
                ];

                foreach ($import['names'] ?? [] as $name) {
                    $references[] = [
                        'kind' => 'from',
                        'module' => $dotted,
                        'file' => $module['path'],
                        'target' => $import['module'] ?? '',
                        'name' => $name['name'] ?? null,
                        'alias' => $name['alias'] ?? null,
                        'line' => $import['line'] ?? null,
                        'relative' => (int) ($import['relative'] ?? 0),
                    ];
                }
            }
        }

        // ---- pass two: types -------------------------------------------------
        $typeKeys = [];
        $methodsByType = [];
        $localNames = [];

        foreach ($modules as $module) {
            $dotted = $module['module'];
            $parsed = $module['parsed'];
            $moduleKey = $moduleKeys[$dotted] ?? null;

            foreach ($parsed['types'] ?? [] as $position => $type) {
                $verdict = $this->classifier->classify($type, $module['path']);
                $qualified = $dotted.'.'.$type['name'];
                $key = 'class:'.$qualified;

                $typeKeys[$dotted.'#'.$position] = $key;
                $localNames[$dotted][$type['name']] = $key;

                $graph->node($key, $verdict['type'], $type['name'], [
                    'fqcn' => $qualified,
                    'file' => $module['path'],
                    'line' => $type['line'] ?? null,
                    'module' => $this->moduleBucket($dotted),
                    'parent' => $moduleKey,
                    'loc' => max(1, (int) ($type['end_line'] ?? $type['line']) - (int) ($type['line'] ?? 1) + 1),
                    'layer' => $verdict['layer']->value,
                    'weight' => $verdict['type']->importance(),
                    'meta' => [
                        'language' => Language::Python->value,
                        'kind' => $type['kind'] ?? 'class',
                        'rule' => $verdict['rule'],
                        'namespace' => $dotted,
                        'module_name' => $dotted,
                        'doc' => $type['doc'] ?? null,
                        'decorators' => array_values(array_filter(array_map(
                            fn ($decorator) => is_array($decorator) ? ($decorator['name'] ?? null) : $decorator,
                            $type['decorators'] ?? [],
                        ))),
                        'bases' => array_values(array_filter(array_map(
                            fn ($base) => (string) ($base['name'] ?? ''),
                            $type['bases'] ?? [],
                        ))),
                        'fields' => array_values(array_map(fn (array $field) => [
                            'name' => $field['name'] ?? '',
                            'type' => $field['type'] ?? null,
                            'default' => $field['value'] ?? null,
                            'line' => $field['line'] ?? null,
                        ], $type['fields'] ?? [])),
                        'field_count' => count($type['fields'] ?? []),
                    ],
                ]);

                if ($moduleKey !== null) {
                    $graph->edge($moduleKey, $key, EdgeKind::Groups, ['label' => 'declares']);
                }

                foreach ($type['bases'] ?? [] as $base) {
                    $name = (string) ($base['name'] ?? '');

                    if ($name !== '') {
                        $inheritances[] = [
                            'from' => $key,
                            'module' => $dotted,
                            'base' => $name,
                            'kind' => ($type['kind'] ?? '') === 'protocol' ? 'implements' : 'extends',
                            'line' => $type['line'] ?? null,
                        ];
                    }
                }

                $symbols['types'][$qualified] = $key;
                $symbols['types_by_name'][$type['name']][] = $qualified;
                $symbols['files'][$module['path']]['keys'][] = $key;
                $symbols['files'][$module['path']]['primary'] ??= $key;
                $declarations['types'][$qualified] = [
                    'key' => $key,
                    'file' => $module['path'],
                    'line' => $type['line'] ?? null,
                    'kind' => $type['kind'] ?? 'class',
                    'layer' => $verdict['layer']->value,
                    'type' => $verdict['type']->value,
                ];
                $counts['types']++;
            }

            // ---- pass three: functions, free and bound ----------------------
            foreach ($parsed['functions'] ?? [] as $function) {
                $ownerIndex = $function['owner_index'] ?? null;

                if ($ownerIndex !== null && isset($typeKeys[$dotted.'#'.$ownerIndex])) {
                    $methodsByType[$typeKeys[$dotted.'#'.$ownerIndex]][] = [
                        'name' => $function['name'],
                        'params' => array_values(array_map(fn (array $argument) => [
                            'name' => $argument['name'] ?? '',
                            'type' => $argument['annotation'] ?? null,
                        ], $function['args'] ?? [])),
                        'line' => $function['line'] ?? null,
                        'visibility' => str_starts_with((string) $function['name'], '_') && ! str_starts_with((string) $function['name'], '__')
                            ? 'protected'
                            : (str_starts_with((string) $function['name'], '__') ? 'private' : 'public'),
                        'static' => in_array('staticmethod', $function['decorators'] ?? [], true)
                            || in_array('classmethod', $function['decorators'] ?? [], true),
                        'async' => (bool) ($function['async'] ?? false),
                        'returns' => $function['returns'] ?? null,
                        'signature' => $function['signature'] ?? null,
                        'decorators' => array_values(array_filter(array_map(
                            fn ($decorator) => is_array($decorator) ? ($decorator['name'] ?? null) : $decorator,
                            $function['decorators'] ?? [],
                        ))),
                        'doc' => $function['doc'] ?? null,
                    ];

                    $symbols['methods'][$this->ownerQualified($modules, $dotted, $ownerIndex).'::'.$function['name']] = $typeKeys[$dotted.'#'.$ownerIndex];

                    continue;
                }

                $verdict = $this->classifier->classify($function, $module['path']);
                $qualified = $dotted.'.'.$function['name'];
                $key = 'func:'.$qualified;

                $localNames[$dotted][$function['name']] = $key;

                $graph->node($key, NodeType::Function, $function['name'], [
                    'fqcn' => $qualified,
                    'file' => $module['path'],
                    'line' => $function['line'] ?? null,
                    'module' => $this->moduleBucket($dotted),
                    'parent' => $moduleKey,
                    'loc' => max(1, (int) ($function['end_line'] ?? $function['line']) - (int) ($function['line'] ?? 1) + 1),
                    'layer' => $verdict['layer']->value,
                    'weight' => NodeType::Function->importance(),
                    'meta' => [
                        'language' => Language::Python->value,
                        'kind' => 'function',
                        'rule' => $verdict['rule'],
                        'namespace' => $dotted,
                        'module_name' => $dotted,
                        'signature' => $function['signature'] ?? null,
                        'returns' => $function['returns'] ?? null,
                        'async' => (bool) ($function['async'] ?? false),
                        'decorators' => array_values(array_filter(array_map(
                            fn ($decorator) => is_array($decorator) ? ($decorator['name'] ?? null) : $decorator,
                            $function['decorators'] ?? [],
                        ))),
                        'doc' => $function['doc'] ?? null,
                    ],
                ]);

                if ($moduleKey !== null) {
                    $graph->edge($moduleKey, $key, EdgeKind::Groups, ['label' => 'declares']);
                }

                $symbols['functions'][$qualified] = $key;
                $symbols['functions_by_name'][$function['name']][] = $qualified;
                $symbols['files'][$module['path']]['keys'][] = $key;
                $declarations['functions'][$qualified] = [
                    'key' => $key,
                    'file' => $module['path'],
                    'line' => $function['line'] ?? null,
                    'layer' => $verdict['layer']->value,
                ];
                $counts['functions']++;
            }

            // ---- call sites and literal evidence ----------------------------
            foreach ($parsed['calls'] ?? [] as $call) {
                $callSites[] = [
                    'module' => $dotted,
                    'file' => $module['path'],
                    'owner' => $call['owner'] ?? null,
                    'function' => $call['function'] ?? null,
                    'receiver' => $call['receiver'] ?? null,
                    'name' => $call['name'] ?? '',
                    'chain' => $call['chain'] ?? '',
                    'args' => $call['args'] ?? '',
                    'line' => $call['line'] ?? null,
                    'decorator' => (bool) ($call['decorator'] ?? false),
                ];
            }

            foreach ($parsed['variables'] ?? [] as $variable) {
                if (($variable['call'] ?? null) === null && ($variable['annotation'] ?? null) === null) {
                    continue;
                }

                $variables[] = [
                    'module' => $dotted,
                    'name' => $variable['name'] ?? '',
                    'call' => $variable['call'] ?? null,
                    'annotation' => $variable['annotation'] ?? null,
                    'owner' => $variable['owner'] ?? null,
                    'function' => $variable['function'] ?? null,
                    'attribute' => (bool) ($variable['attribute'] ?? false),
                    'line' => $variable['line'] ?? null,
                ];
            }

            foreach ($parsed['literals'] ?? [] as $literal) {
                $references[] = [
                    'kind' => 'literal',
                    'module' => $dotted,
                    'file' => $module['path'],
                    'target' => $literal['value'] ?? '',
                    'name' => null,
                    'alias' => null,
                    'line' => $literal['line'] ?? null,
                    'relative' => 0,
                ];
            }
        }

        // ---- methods and members, now that the functions are known ----------
        foreach ($methodsByType as $typeKey => $methods) {
            $members = array_map(fn (array $method) => [
                'name' => $method['name'],
                'kind' => $this->memberKind($method),
                'line' => $method['line'],
                'signature' => $method['signature'],
            ], $methods);

            $graph->node($typeKey, $graph->typeOf($typeKey) ?? NodeType::PhpClass, '', [
                'meta' => [
                    'methods' => $methods,
                    'method_count' => count($methods),
                    'members' => $members,
                    'member_count' => count($members),
                ],
            ]);

            $declarations['members'][$typeKey] = $members;
            $counts['members'] += count($methods);
        }

        // ---- inheritance, resolved inside the project ------------------------
        $resolved = 0;

        foreach ($inheritances as $inheritance) {
            $key = $this->resolveName($inheritance['base'], $inheritance['module'], $localNames, $imports, $symbols);

            if ($key === null) {
                continue;
            }

            /*
             * An interface in the base list is implemented; a class is extended —
             * the rule the C++ scanner uses, so `class Card(Renderable)` reads the
             * same way as `class Card : IRenderable` does. Asking the base what it
             * *is* beats asking the subclass, which only ever says "class".
             */
            $kind = $graph->typeOf($key) === NodeType::Interface_
                ? EdgeKind::Implements
                : EdgeKind::Extends;

            $graph->edge($inheritance['from'], $key, $kind, ['label' => $inheritance['base']]);
            $resolved++;
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('symbols', $symbols);
        $context->writeArtifact('declarations', $declarations);
        $context->writeArtifact('references', ['references' => $references]);
        $context->writeArtifact('call_sites', [
            'call_sites' => $callSites,
            'variables' => $variables,
            'local' => $this->localNames($localNames, $modules),
        ]);

        // How the classes came out, by kind — the project report's Composition
        // card reads exactly this, and it is the same shape the Laravel stage
        // writes, so the report page does not need to know which scanner ran.
        $byType = [];

        foreach ($declarations['types'] as $declared) {
            $byType[$declared['type']] = ($byType[$declared['type']] ?? 0) + 1;
        }

        arsort($byType);

        $context->log(sprintf(
            '%d modules · %d classes · %d functions · %d methods · %d inheritance links',
            $counts['modules'],
            $counts['types'],
            $counts['functions'],
            $counts['members'],
            $resolved,
        ));

        return [
            'summary' => sprintf(
                '%d classes · %d functions · %d modules',
                $counts['types'],
                $counts['functions'],
                $counts['modules'],
            ),
            'metrics' => [
                'modules' => $counts['modules'],
                'types' => $counts['types'],
                'class_types' => $byType,
                'functions' => $counts['functions'],
                'members' => $counts['members'],
                'entry_points' => $counts['entry'],
                'inheritance' => $resolved,
                'imports' => count($references),
            ],
        ];
    }

    /** @return array<string, array{module: ?string, name: ?string, alias: ?string}> */
    private function importMap(array $imports, string $dotted): array
    {
        $map = [];

        foreach ($imports as $import) {
            $module = (string) ($import['module'] ?? '');
            $alias = $import['alias'] ?? null;
            $names = $import['names'] ?? [];

            if ($names === []) {
                // `import app.bookmarks.models [as models]` — the local name is
                // the last segment unless an alias says otherwise.
                $segments = array_values(array_filter(explode('.', $module)));
                $local = $alias ?? ($segments !== [] ? $segments[count($segments) - 1] : $module);

                if ($local !== '') {
                    $map[$local] = ['module' => $module, 'name' => null, 'alias' => $alias];
                }

                continue;
            }

            foreach ($names as $name) {
                $local = $name['alias'] ?? ($name['name'] ?? '');

                if ($local === '') {
                    continue;
                }

                $map[$local] = ['module' => $module, 'name' => $name['name'] ?? null, 'alias' => $name['alias'] ?? null];
            }
        }

        return $map;
    }

    /**
     * Turn an imported or locally declared name into a node key.
     *
     * @param  array<string, array<string, string>>  $localNames
     * @param  array<string, array<string, array{module:?string,name:?string,alias:?string}>>  $imports
     */
    public function resolveName(string $name, string $dotted, array $localNames, array $imports, array $symbols): ?string
    {
        $name = trim($name);
        $name = ltrim($name, '\\');

        if ($name === '') {
            return null;
        }

        // Local declaration first: a class in this very module always wins.
        if (isset($localNames[$dotted][$name])) {
            return $localNames[$dotted][$name];
        }

        // Then a local module-level symbol qualified through `self.Name`.
        if (isset($imports[$dotted][$name])) {
            $import = $imports[$dotted][$name];
            $module = (string) ($import['module'] ?? '');

            if ($import['name'] !== null && $import['name'] !== '*') {
                $candidate = $module.'.'.$import['name'];

                if (isset($symbols['types'][$candidate])) {
                    return $symbols['types'][$candidate];
                }
            }

            if (isset($symbols['modules'][$module])) {
                return $symbols['modules'][$module];
            }
        }

        // A dotted path that names a class or module directly.
        $segments = explode('.', str_replace('/', '.', $name));
        $base = (string) end($segments);

        if (isset($symbols['types'][$name])) {
            return $symbols['types'][$name];
        }

        foreach ($symbols['types_by_name'][$base] ?? [] as $qualified) {
            return $symbols['types'][$qualified];
        }

        if (isset($symbols['modules'][$name])) {
            return $symbols['modules'][$name];
        }

        return null;
    }

    /** @param array<string, array<string,string>> $localNames */
    private function localNames(array $localNames, array $modules): array
    {
        $out = [];

        foreach ($modules as $module) {
            $dotted = $module['module'];

            foreach ($localNames[$dotted] ?? [] as $name => $key) {
                $out[$dotted][$name] = $key;
            }
        }

        return $out;
    }

    /** `app.bookmarks.models` inside `app/bookmarks/models.py`. */
    private function directoryKey(string $path): ?string
    {
        $directory = dirname(str_replace('\\', '/', $path));

        return $directory === '.' || $directory === '' ? null : 'dir:'.$directory;
    }

    private function parentModule(string $dotted): ?string
    {
        return str_contains($dotted, '.') ? substr($dotted, 0, (int) strrpos($dotted, '.')) : null;
    }

    /** The cluster a node belongs to: the first segment of its module path. */
    private function moduleBucket(string $dotted): string
    {
        $first = explode('.', $dotted)[0];

        return $first !== '' ? $first : 'Project';
    }

    private function ownerQualified(array $modules, string $dotted, int $index): string
    {
        foreach ($modules as $module) {
            if ($module['module'] !== $dotted) {
                continue;
            }

            $type = $module['parsed']['types'][$index] ?? null;

            return $type !== null ? $dotted.'.'.$type['name'] : $dotted;
        }

        return $dotted;
    }

    private function memberKind(array $method): string
    {
        $name = (string) ($method['name'] ?? '');

        if (str_starts_with($name, '__') && str_ends_with($name, '__')) {
            return 'dunder';
        }

        if (str_starts_with($name, '_')) {
            return 'private';
        }

        if (in_array('property', array_map('strtolower', $method['decorators'] ?? []), true)) {
            return 'property';
        }

        return 'method';
    }
}
