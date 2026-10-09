<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\Language;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Cxx\DeclarationParser;
use App\Services\Scan\Languages\Cxx\Naming;
use App\Services\Scan\Languages\Cxx\SymbolClassifier;
use App\Services\Scan\Languages\LanguageProfile;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 3 of the C-family pipeline — every file is lexed and parsed into the
 * symbols that become graph nodes: namespaces, types, free functions.
 *
 * Three things happen here that the whole atlas then leans on:
 *
 *  1. **Nodes.** Types and free functions become the visible furniture of the
 *     graph, classified into layers by `SymbolClassifier`, so a C++ or C#
 *     project gets the same readable decks a Laravel one does.
 *  2. **Placeholders.** Base classes and interfaces that live outside the
 *     project (ControllerBase, std::vector…) become "external" nodes, because
 *     knowing what a project builds *on* is part of understanding it.
 *  3. **Inheritance and routes.** `extends`/`implements` edges are emitted here,
 *     and C# HTTP attributes become real Route nodes with the same shape the
 *     Laravel route stage produces — which is what makes journey tracing work
 *     on a C# project too.
 */
class DeclarationStage implements Stage
{
    /** Files above this size are skipped: they are generated or bundled. */
    private const MAX_BYTES = 2_500_000;

    private const HTTP_VERBS = [
        'httpget' => 'GET',
        'httppost' => 'POST',
        'httpput' => 'PUT',
        'httpdelete' => 'DELETE',
        'httppatch' => 'PATCH',
        'httphead' => 'HEAD',
    ];

    public function __construct(
        private readonly LanguageProfile $profile,
        private readonly DeclarationParser $parser,
        private readonly SymbolClassifier $classifier,
    ) {}

    public function name(): ScanStage
    {
        return ScanStage::Declarations;
    }

    public function run(ScanContext $context): array
    {
        $language = $context->language;
        $graph = $context->loadGraph();
        $index = $context->readArtifact('files')['files'] ?? [];

        $symbols = [
            'types' => [],
            'types_by_name' => [],
            'functions' => [],
            'functions_by_name' => [],
            'methods' => [],
            'files' => [],
        ];

        $callSites = [];
        $references = [];
        $outOfLine = [];
        $namespaceNodes = [];
        $inheritance = [];
        $counts = ['types' => 0, 'functions' => 0, 'members' => 0, 'namespaces' => 0, 'files' => 0, 'skipped' => []];
        $byType = [];
        $docCandidates = [];

        foreach ($index as $file) {
            if (! in_array($file['language'] ?? '', ['cpp', 'cpp-header', 'csharp'], true)) {
                continue;
            }

            if (($file['size'] ?? 0) > self::MAX_BYTES) {
                $counts['skipped'][] = $file['path'];

                continue;
            }

            $source = @file_get_contents($context->root.'/'.$file['path']);

            if ($source === false || trim($source) === '') {
                continue;
            }

            $csharp = $language === Language::CSharp;
            $parsed = $this->parser->parse($source, $csharp);

            $counts['files']++;
            $namespace = (string) ($parsed['namespace'] ?? '');
            $fileTypes = [];

            // ---- namespaces --------------------------------------------------
            foreach ($parsed['namespaces_declared'] ?? [] as $declared) {
                if (! isset($namespaceNodes[$declared])) {
                    $key = 'ns:'.$declared;
                    $namespaceNodes[$declared] = $key;
                    $counts['namespaces']++;

                    $graph->node($key, NodeType::Namespace, Naming::display($declared, $language), [
                        'module' => Naming::namespaceModule($declared),
                        'layer' => Layer::Structure->value,
                        'weight' => NodeType::Namespace->importance(),
                        'meta' => ['namespace' => $declared, 'language' => $language->value],
                    ]);
                }
            }

            // ---- types -------------------------------------------------------
            foreach ($parsed['types'] ?? [] as $type) {
                $key = $this->typeKey($type);
                $verdict = $this->classifier->classify($language, $type, $file['path']);
                $members = $this->normaliseMembers($type['members'] ?? []);

                $graph->node($key, $verdict['type'], $type['name'], [
                    'fqcn' => $type['qualified'],
                    'file' => $file['path'],
                    'line' => $type['line'] ?? null,
                    'module' => $file['module'] ?? $this->profile->moduleFor($file['path']),
                    'parent' => Naming::directoryKey($file['path']),
                    'loc' => max(1, (int) ($type['end_line'] ?? $type['line']) - (int) $type['line'] + 1),
                    'layer' => $verdict['layer']->value,
                    'weight' => $verdict['type']->importance(),
                    'meta' => [
                        'kind' => $type['kind'],
                        'namespace' => $type['namespace'] !== '' ? Naming::display($type['namespace'], $language) : null,
                        'bases' => array_values(array_filter(array_map(
                            fn (array $base) => Naming::cleanBase((string) ($base['name'] ?? '')),
                            $type['bases'] ?? [],
                        ))),
                        'abstract' => (bool) ($type['is_abstract'] ?? false),
                        'nested_in' => $type['nested_in'] ?? null,
                        'attributes' => array_map(fn (array $a) => $a['name'], $type['attributes'] ?? []),
                        'members' => $members,
                        'member_count' => count($members),
                        'language' => $language->value,
                        'rule' => $verdict['rule'],
                        'doc' => $type['doc'] ?? null,
                    ],
                ]);

                $symbols['types'][$type['qualified']] = $key;
                $symbols['types_by_name'][$type['name']][] = $type['qualified'];
                $symbols['files'][$file['path']]['keys'][] = $key;
                $symbols['files'][$file['path']]['primary'] ??= $key;
                $symbols['files'][$file['path']]['namespace'] = $type['namespace'];
                $fileTypes[] = $key;
                $counts['types']++;
                // The project report's Composition card, same key as Laravel's.
                $byType[$verdict['type']->value] = ($byType[$verdict['type']->value] ?? 0) + 1;
                $counts['members'] += count($members);

                foreach ($type['members'] as $member) {
                    $symbols['methods'][$type['qualified'].'::'.$member['name']] = $key;
                }

                if (($type['doc'] ?? null) !== null) {
                    $docCandidates[] = $key;
                }

                // Nested types hang off their parent instead of the directory.
                if (! empty($type['nested_in'])) {
                    $parentKey = $this->resolveType((string) $type['nested_in'], $symbols);

                    if ($parentKey !== null && $parentKey !== $key) {
                        $graph->edge($parentKey, $key, EdgeKind::Groups, ['label' => 'nested']);
                    }
                }

                // Namespace containment.
                if ($type['namespace'] !== '' && isset($namespaceNodes[$type['namespace']])) {
                    $graph->edge($namespaceNodes[$type['namespace']], $key, EdgeKind::Groups);
                }

                foreach ($type['bases'] ?? [] as $base) {
                    $base = Naming::cleanBase((string) ($base['name'] ?? ''));

                    if ($base !== '') {
                        $inheritance[] = [$key, $base, $type['kind'] === 'interface'];
                    }
                }

                if ($language === Language::CSharp) {
                    $this->registerRoutes($graph, $context, $type, $key, $file);
                }
            }

            // ---- free functions ---------------------------------------------
            foreach ($parsed['functions'] ?? [] as $function) {
                $key = 'func:'.$function['qualified'];
                $verdict = $this->classifier->classify($language, $function, $file['path']);

                $graph->node($key, NodeType::Function, $function['name'], [
                    'fqcn' => $function['qualified'],
                    'file' => $file['path'],
                    'line' => $function['line'] ?? null,
                    'module' => $file['module'] ?? 'Core',
                    'parent' => Naming::directoryKey($file['path']),
                    'loc' => max(1, (int) ($function['end_line'] ?? $function['line']) - (int) $function['line'] + 1),
                    'layer' => $verdict['layer']->value,
                    'weight' => NodeType::Function->importance(),
                    'meta' => [
                        'kind' => 'function',
                        'signature' => $function['signature'] ?? null,
                        'namespace' => $function['namespace'] !== '' ? Naming::display($function['namespace'], $language) : null,
                        'language' => $language->value,
                        'rule' => $verdict['rule'],
                        'doc' => $function['doc'] ?? null,
                    ],
                ]);

                $isNew = ! isset($symbols['functions'][$function['qualified']]);

                $symbols['functions'][$function['qualified']] = $key;
                $symbols['functions_by_name'][$function['name']][] = $function['qualified'];
                $symbols['files'][$file['path']]['keys'][] = $key;
                $symbols['files'][$file['path']]['primary'] ??= $key;

                // A declaration in a header and its definition in a .cpp are one
                // symbol, so only the first sighting is counted.
                if ($isNew) {
                    $counts['functions']++;
                }

                if ($function['namespace'] !== '' && isset($namespaceNodes[$function['namespace']])) {
                    $graph->edge($namespaceNodes[$function['namespace']], $key, EdgeKind::Groups);
                }
            }

            // ---- top-level statements ---------------------------------------
            // A C# Program.cs with top-level statements declares no type, yet
            // it is where the application starts and where minimal-API routes
            // are registered. It gets a node of its own so the graph has an
            // origin and those routes have somewhere to point.
            if ($language === Language::CSharp
                && ! isset($symbols['files'][$file['path']]['primary'])
                && ($parsed['calls'] ?? []) !== []) {
                $label = pathinfo($file['path'], PATHINFO_FILENAME);
                $key = 'type:'.($namespace !== '' ? $namespace.'\\' : '').$label;

                $graph->node($key, NodeType::Executable, $label, [
                    'fqcn' => $namespace !== '' ? $namespace.'\\'.$label : $label,
                    'file' => $file['path'],
                    'line' => $parsed['calls'][0]['line'] ?? null,
                    'module' => $file['module'] ?? 'Entry',
                    'parent' => Naming::directoryKey($file['path']),
                    'layer' => Layer::Entry->value,
                    'weight' => NodeType::Executable->importance(),
                    'meta' => [
                        'kind' => 'entry-point',
                        'top_level' => true,
                        'namespace' => $namespace !== '' ? Naming::display($namespace, $language) : null,
                        'language' => $language->value,
                        'rule' => 'top-level-statements',
                        'members' => [],
                        'member_count' => 0,
                    ],
                ]);

                $symbols['types'][$namespace !== '' ? $namespace.'\\'.$label : $label] = $key;
                $symbols['types_by_name'][$label][] = $namespace.'\\'.$label;
                $symbols['files'][$file['path']]['keys'][] = $key;
                $symbols['files'][$file['path']]['primary'] = $key;
                $counts['types']++;
            }

            // ---- call sites and out-of-line definitions ---------------------
            foreach ($parsed['calls'] ?? [] as $call) {
                $callSites[] = $call + [
                    'file' => $file['path'],
                    'namespace' => $namespace,
                    'primary' => $symbols['files'][$file['path']]['primary'] ?? null,
                ];
            }

            foreach ($parsed['includes'] ?? [] as $include) {
                $references[] = $include + ['file' => $file['path'], 'kind' => 'include'];
            }

            foreach ($parsed['usings'] ?? [] as $using) {
                $references[] = $using + ['file' => $file['path'], 'kind' => 'using'];
            }

            foreach ($parsed['out_of_line'] ?? [] as $definition) {
                $outOfLine[] = $definition + [
                    'file' => $file['path'],
                    'namespace' => $namespace,
                ];
            }
        }

        // ---- out-of-line definitions fill in members of types declared elsewhere
        $merged = $this->mergeOutOfLine($graph, $outOfLine, $symbols, $language);

        // ---- inheritance ------------------------------------------------
        $external = $this->linkInheritance($graph, $inheritance, $symbols, $language);

        $context->writeArtifact('symbols', $symbols);
        $context->writeArtifact('call_sites', $callSites);
        $context->writeArtifact('references', $references);
        $context->writeArtifact('declarations', [
            'types' => $counts['types'],
            'functions' => $counts['functions'],
            'members' => $counts['members'],
            'namespaces' => $counts['namespaces'],
        ]);

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->scan->refresh()->update(['metrics' => array_merge($context->scan->metrics ?? [], [
            'declarations' => [
                'types' => $counts['types'],
                'functions' => $counts['functions'],
                'members' => $counts['members'],
                'namespaces' => $counts['namespaces'],
                'external_bases' => $external,
            ],
        ])]);

        arsort($byType);

        $context->log(sprintf(
            'Parsed %s files — %d types, %d functions, %d members, %d namespaces (%d external bases linked)',
            number_format($counts['files']),
            $counts['types'],
            $counts['functions'],
            $counts['members'],
            $counts['namespaces'],
            $external,
        ));

        return [
            'summary' => sprintf('%d types · %d functions · %d members', $counts['types'], $counts['functions'], $counts['members']),
            'metrics' => [
                'types' => $counts['types'],
                'class_types' => $byType,
                'functions' => $counts['functions'],
                'members' => $counts['members'],
                'namespaces' => $counts['namespaces'],
                'files_parsed' => $counts['files'],
                'out_of_line_merged' => $merged,
                'external_bases' => $external,
            ],
        ];
    }

    private function typeKey(array $type): string
    {
        return 'type:'.$type['qualified'];
    }

    /** Members in the same shape the Laravel class parser produces. */
    private function normaliseMembers(array $members): array
    {
        return array_map(fn (array $member): array => [
            'name' => $member['name'] ?? '',
            'kind' => $member['kind'] ?? 'method',
            'visibility' => $member['visibility'] ?? 'public',
            'static' => (bool) ($member['static'] ?? false),
            'abstract' => (bool) ($member['abstract'] ?? false),
            'line' => $member['line'] ?? null,
            'loc' => max(1, (int) ($member['end_line'] ?? $member['line'] ?? 1) - (int) ($member['line'] ?? 1) + 1),
            'type' => $member['return_type'] ?? $member['type'] ?? null,
            'attributes' => array_map(fn (array $a) => $a['name'], $member['attributes'] ?? []),
            'doc' => $member['doc'] ?? null,
        ], $members);
    }

    private function resolveType(string $reference, array $symbols): ?string
    {
        if (isset($symbols['types'][$reference])) {
            return $symbols['types'][$reference];
        }

        $base = Naming::base($reference);

        // `Renderer::draw` style owners, then a plain name.
        foreach (array_keys($symbols['types']) as $fqn) {
            if (Naming::refersTo($base, $fqn)) {
                return $symbols['types'][$fqn];
            }
        }

        return null;
    }

    /**
     * A `.cpp` file declaring `Renderer::draw` is not a second Renderer — it is
     * the body of one declared in a header. Merging those members keeps the
     * inspector honest about what a type actually contains.
     */
    private function mergeOutOfLine(GraphBuilder $graph, array $definitions, array $symbols, Language $language): int
    {
        $merged = 0;

        foreach ($definitions as $definition) {
            $owner = (string) $definition['owner'];
            $key = $this->resolveType($owner, $symbols);

            if ($key === null) {
                continue;
            }

            // `Renderer::Renderer` is the constructor; `Mesh::~Mesh` the
            // destructor. Both are kept with the names a C++ reader expects.
            $raw = (string) $definition['name'];
            $isDestructor = str_starts_with($raw, '~');
            $bare = ltrim($raw, '~');

            if ($bare === '') {
                continue;
            }

            $isConstructor = ! $isDestructor && $bare === Naming::base($owner);

            $name = $isDestructor ? '~'.$bare : ($isConstructor ? '__construct' : $bare);

            $symbols['methods'][trim($owner, '\\').'::'.$bare] = $key;

            $existing = $graph->nodeOrNull($key);

            if ($existing === null) {
                continue;
            }

            $members = $existing['meta']['members'] ?? [];

            $known = array_map(fn (array $m) => strtolower($m['name']), $members);

            if (in_array(strtolower($name), $known, true)) {
                continue;
            }

            $members[] = [
                'name' => $name,
                'kind' => $isDestructor ? 'destructor' : ($isConstructor ? 'constructor' : 'method'),
                'visibility' => 'public',
                'static' => false,
                'abstract' => false,
                'line' => $definition['line'] ?? null,
                'loc' => 1,
                'type' => trim((string) ($definition['signature'] ?? '')) !== '' ? null : null,
                'attributes' => [],
                'doc' => null,
                'declared_in' => $definition['file'],
            ];

            $graph->node($key, NodeType::tryFrom((string) $existing['type']) ?? NodeType::PhpClass, '', [
                'meta' => [
                    'members' => $members,
                    'member_count' => count($members),
                    'out_of_line' => true,
                ],
            ]);

            $merged++;
        }

        return $merged;
    }

    /**
     * Inheritance, with the outside world included: a base class we never
     * parsed still becomes a node, because "everything here builds on
     * ControllerBase" is exactly the kind of thing the atlas exists to show.
     */
    private function linkInheritance(GraphBuilder $graph, array $relations, array $symbols, Language $language): int
    {
        $external = 0;

        foreach ($relations as [$key, $base, $declaredAsInterface]) {
            $target = $this->resolveType($base, $symbols);

            if ($target === null) {
                $target = 'type:'.$base;
                $looksLikeInterface = $declaredAsInterface || preg_match('/^I[A-Z]/', Naming::base($base)) === 1;

                $graph->touch($target, Naming::display($base, $language), [
                    'type' => ($looksLikeInterface ? NodeType::Interface_ : NodeType::PhpClass)->value,
                    'layer' => Layer::External->value,
                    'module' => 'External',
                    'weight' => 24,
                    'meta' => [
                        'external' => true,
                        'language' => $language->value,
                        'rule' => 'unresolved-base',
                    ],
                ]);

                $external++;
            }

            if ($target === $key) {
                continue;
            }

            // An interface in the base list is implemented; a class is extended.
            $targetKind = $graph->nodeOrNull($target)['type'] ?? null;
            $kind = ($targetKind === NodeType::Interface_->value || $declaredAsInterface)
                ? EdgeKind::Implements
                : EdgeKind::Extends;

            $graph->edge($key, $target, $kind);
        }

        return $external;
    }

    /**
     * `[HttpGet("{id}")]` on a method, plus `[Route("api/[controller]")]` on the
     * class, is a route table written the C# way. Producing genuine Route nodes
     * here means journeys, search and the HTTP lens all work unchanged.
     */
    private function registerRoutes(GraphBuilder $graph, ScanContext $context, array $type, string $typeKey, array $file): void
    {
        $controller = $type['name'];
        $shortController = str_replace('Controller', '', $controller);
        $prefixes = [];
        $extraWeight = 0;

        foreach ($type['attributes'] ?? [] as $attribute) {
            if (strtolower($attribute['name']) === 'route') {
                $prefixes[] = (string) ($attribute['arguments'][0] ?? '');
            }
        }

        foreach ($type['members'] ?? [] as $member) {
            foreach ($member['attributes'] ?? [] as $attribute) {
                $verb = self::HTTP_VERBS[strtolower($attribute['name'])] ?? null;

                if ($verb === null) {
                    continue;
                }

                $template = (string) ($attribute['arguments'][0] ?? '');
                $prefix = $prefixes[0] ?? '';
                $uri = $this->buildUri($prefix, $template, $shortController, $member['name']);

                if ($uri === null) {
                    continue;
                }

                $key = 'route:'.$verb.' '.$uri;

                $graph->node($key, NodeType::Route, trim($verb.' '.$uri), [
                    'file' => $file['path'],
                    'line' => $member['line'] ?? null,
                    'module' => $file['module'] ?? 'Http',
                    'weight' => 90,
                    'meta' => [
                        'uri' => $uri,
                        'method' => $verb,
                        'name' => null,
                        'action_type' => 'controller',
                        'controller' => $type['qualified'],
                        'action' => $member['name'],
                        'middleware' => [],
                        'without_middleware' => [],
                        'domain' => null,
                        'is_api' => str_starts_with($uri, '/api'),
                        'resource' => null,
                        'fallback' => false,
                        'redirect_to' => null,
                        'deprecated' => false,
                        'framework' => 'aspnet',
                    ],
                ]);

                $graph->edge($key, $typeKey, EdgeKind::Http, ['label' => $member['name']]);
                $extraWeight++;
            }
        }

        if ($extraWeight > 0) {
            $graph->node($typeKey, NodeType::Controller, '', ['meta' => ['routes' => $extraWeight]]);
        }
    }

    private function buildUri(string $prefix, string $template, string $controller, string $action): ?string
    {
        $prefix = str_replace(['[controller]', '[Controller]'], strtolower($controller) ?: 'controller', $prefix);
        $prefix = str_replace(['[action]', '[Action]'], $action, $prefix);
        $template = str_replace(['[controller]', '[Controller]'], strtolower($controller) ?: 'controller', $template);
        $template = str_replace(['[action]', '[Action]'], $action, $template);

        $prefix = trim($prefix, '/');
        $template = trim($template, '/');

        if ($prefix === '' && $template === '') {
            return null;
        }

        $uri = '/'.trim($prefix.'/'.$template, '/');

        return preg_replace('#/+#', '/', $uri) ?: null;
    }
}
