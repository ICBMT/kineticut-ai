<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\Language;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Cxx\Naming;
use App\Services\Scan\Languages\LanguageProfile;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 4 of the C-family pipeline — the edges that are not calls.
 *
 * Three kinds of relationship are resolved here, in this order of confidence:
 *
 *  - **Includes / usings.** An `#include "render/renderer.hpp"` is a hard,
 *    textual dependency; a `using Acme.Web.Models;` is a namespace import.
 *    Both are followed to the code they actually name.
 *  - **Inheritance help.** Base classes that could not be resolved while
 *    parsing (declared later, or in another namespace) are matched now that the
 *    whole symbol table exists.
 *  - **Type usage.** A field, property or return type of `Mesh` is a real
 *    dependency on `Mesh`, so those names become `uses` edges. This is what
 *    gives a C++ or C# atlas a spine when the language has no route table.
 */
class ReferenceStage implements Stage
{
    /** Namespaces that belong to the platform, not to the project. */
    private const FRAMEWORK_ROOTS = [
        'system', 'microsoft', 'windows', 'swashbuckle', 'newtonsoft', 'xunit',
        'nunit', 'moq', 'fluentassertions', 'autofixture', 'serilog', 'nlog',
        'std', 'boost', 'qt', 'sfml', 'sdl', 'glfw', 'glew', 'glm', 'eigen',
        'catch2', 'gtest', 'gmock', 'benchmark', 'absl', 'folly', 'fmt',
    ];

    private const PRIMITIVES = [
        'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'byte', 'sbyte',
        'uint', 'ulong', 'ushort', 'decimal', 'string', 'object', 'var', 'auto', 'size_t',
        'ssize_t', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'unsigned', 'signed',
        'const', 'constexpr', 'static', 'inline', 'virtual', 'override', 'readonly', 'string_view',
        'true', 'false', 'null', 'nullptr', 'self', 'base', 'this', 'task', 'list', 'dictionary',
        'ienumerable', 'icollection', 'ilist', 'nullable', 'action', 'func', 'tuple', 'span',
        'memory', 'vector', 'map', 'set', 'pair', 'optional', 'unique_ptr', 'shared_ptr', 'weak_ptr',
        'array', 'queue', 'stack', 'deque', 'unordered_map', 'unordered_set', 'stringbuilder',
    ];

    public function __construct(private readonly LanguageProfile $profile) {}

    public function name(): ScanStage
    {
        return ScanStage::References;
    }

    public function run(ScanContext $context): array
    {
        $language = $context->language;
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $references = $context->readArtifact('references');

        $metrics = $this->linkReferences($graph, $context, $references, $symbols, $language);
        $metrics['type_uses'] = $this->linkTypeUsage($graph, $symbols, $language);
        $metrics['external_namespaces'] = $this->linkForeignNamespaces($graph, $references, $language);

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->log(sprintf(
            'Resolved %d includes/usings (%d unresolved), %d type usages',
            $metrics['resolved'],
            $metrics['unresolved'],
            $metrics['type_uses'],
        ));

        return [
            'summary' => sprintf('%d resolved · %d unresolved · %d type uses', $metrics['resolved'], $metrics['unresolved'], $metrics['type_uses']),
            'metrics' => $metrics,
        ];
    }

    /** @return array{resolved:int, unresolved:int, system:int, framework:int, pairs:int} */
    private function linkReferences(GraphBuilder $graph, ScanContext $context, array $references, array $symbols, Language $language): array
    {
        $files = $symbols['files'] ?? [];
        $resolved = 0;
        $unresolved = 0;
        $system = 0;
        $framework = 0;

        foreach ($references as $reference) {
            $source = $files[$reference['file']]['primary'] ?? null;

            if ($source === null) {
                continue;
            }

            if (($reference['kind'] ?? '') === 'include') {
                // The parser records an include's target as `path`; a using
                // directive uses `target`. Both spellings are accepted here.
                $path = (string) ($reference['path'] ?? $reference['target'] ?? '');

                if ($reference['system'] ?? false) {
                    // `<vector>` is the standard library, not this project.
                    $system++;

                    continue;
                }

                $entry = $this->resolveInclude($path, $reference['file'], $files);

                if ($entry === null) {
                    $unresolved++;

                    continue;
                }

                $target = $this->preferSymbol($graph, $entry, $path);

                if ($target === null) {
                    $unresolved++;

                    continue;
                }

                $graph->edge($source, $target, EdgeKind::Includes, ['label' => basename($path)]);
                $resolved++;

                continue;
            }

            // A `using` (C#) or `using namespace` (C++) target. C# writes it
            // with dots and C++ with colons; both are keyed with backslashes so
            // an import and a declaration find the same namespace node.
            $target = str_replace('.', '\\', (string) ($reference['target'] ?? ''));
            $root = strtolower(explode('\\', str_replace('.', '\\', $target))[0] ?? '');

            if (in_array($root, self::FRAMEWORK_ROOTS, true)) {
                $framework++;

                continue;
            }

            if (isset($reference['alias']) && $reference['alias'] !== null) {
                // `using Foo = Bar.Baz;` names a type, not a namespace.
                $typeKey = $this->findType($target, $symbols, $language);

                if ($typeKey !== null) {
                    $graph->edge($source, $typeKey, EdgeKind::Imports, ['label' => 'alias']);

                    continue;
                }
            }

            $namespaceKey = 'ns:'.$target;

            if (! $graph->has($namespaceKey)) {
                $graph->node($namespaceKey, NodeType::Namespace, Naming::display($target, $language), [
                    'layer' => Layer::External->value,
                    'module' => 'External',
                    'weight' => NodeType::Namespace->importance(),
                    'meta' => ['namespace' => $target, 'external' => true, 'language' => $language->value],
                ]);
            }

            $graph->edge($source, $namespaceKey, EdgeKind::Imports, ['label' => 'using']);
            $resolved++;
        }

        return ['resolved' => $resolved, 'unresolved' => $unresolved, 'system' => $system, 'framework' => $framework, 'pairs' => 0];
    }

    /**
     * `renderer.hpp` declares `IRenderer` first and `Renderer` second, and a
     * reader means the second one. The header's own name is the best hint we
     * have, so a declaration matching it wins; failing that, the first concrete
     * type beats a helper interface.
     */
    private function preferSymbol(GraphBuilder $graph, array $entry, string $path): ?string
    {
        $keys = $entry['keys'] ?? [];

        if ($keys === []) {
            return $entry['primary'] ?? null;
        }

        $stem = strtolower(pathinfo($path, PATHINFO_FILENAME));

        foreach ($keys as $key) {
            $node = $graph->nodeOrNull($key);

            if ($node !== null && strtolower((string) $node['label']) === $stem) {
                return $key;
            }
        }

        foreach ($keys as $key) {
            $node = $graph->nodeOrNull($key);

            if (($node['type'] ?? '') !== NodeType::Interface_->value) {
                return $key;
            }
        }

        return $entry['primary'] ?? $keys[0];
    }

    /** `#include "render/renderer.hpp"` → the file entry it names. */
    private function resolveInclude(string $path, string $from, array $files): ?array
    {
        $candidates = [];

        $directory = dirname($from);
        $candidates[] = $directory === '.' ? $path : $directory.'/'.$path;
        $candidates[] = $path;

        foreach (['include/', 'src/', 'inc/', 'source/', 'headers/'] as $root) {
            $candidates[] = $root.$path;
        }

        // Some projects include by base name only: `#include "renderer.hpp"`.
        $base = basename($path);

        foreach (array_keys($files) as $file) {
            if (basename($file) === $base) {
                $candidates[] = $file;
            }
        }

        foreach ($candidates as $candidate) {
            $candidate = ltrim(str_replace('\\', '/', $candidate), '/');

            if (isset($files[$candidate])) {
                return $files[$candidate];
            }
        }

        return null;
    }

    /**
     * Fields, properties and return types are dependencies. Reading them out of
     * the member metadata costs nothing extra — the parser already recorded the
     * type of every member — and it turns a flat list of classes into a real
     * dependency graph.
     */
    private function linkTypeUsage(GraphBuilder $graph, array $symbols, Language $language): int
    {
        $edges = 0;
        $seen = [];

        foreach ($symbols['types'] as $fqn => $key) {
            $node = $graph->nodeOrNull($key);

            if ($node === null) {
                continue;
            }

            $text = '';

            foreach ($node['meta']['members'] ?? [] as $member) {
                // Only declared types count: docblock prose would invent edges.
                $text .= ' '.($member['type'] ?? '');
            }

            foreach ($node['meta']['bases'] ?? [] as $base) {
                $text .= ' '.$base;
            }

            foreach ($this->identifiers($text) as $identifier) {
                if (in_array(strtolower($identifier), self::PRIMITIVES, true)) {
                    continue;
                }

                $target = $this->findType($identifier, $symbols, $language);

                if ($target === null || $target === $key) {
                    continue;
                }

                $hash = $key.'|'.$target;

                if (isset($seen[$hash]) || count($seen) > 6000) {
                    continue;
                }

                $seen[$hash] = true;
                $graph->edge($key, $target, EdgeKind::Uses, ['label' => 'type']);
                $edges++;
            }
        }

        return $edges;
    }

    /** Namespaces the project references but does not own. */
    private function linkForeignNamespaces(GraphBuilder $graph, array $references, Language $language): int
    {
        $created = 0;

        if ($language !== Language::CSharp) {
            return 0;
        }

        foreach ($references as $reference) {
            if (($reference['kind'] ?? '') !== 'using') {
                continue;
            }

            $target = (string) ($reference['target'] ?? '');
            $root = strtolower(explode('.', $target)[0] ?? '');

            if ($root === '' || ! in_array($root, ['system', 'microsoft'], true)) {
                continue;
            }

            $key = 'pkg:'.$root;

            if (! $graph->has($key)) {
                $graph->node($key, NodeType::Package, ucfirst($root), [
                    'layer' => Layer::External->value,
                    'module' => 'Framework',
                    'weight' => 34,
                    'meta' => ['package' => ucfirst($root), 'manager' => 'framework', 'kind' => 'platform'],
                ]);

                $created++;
            }
        }

        return $created;
    }

    /** Find a type by name or by trailing namespace segments. */
    private function findType(string $reference, array $symbols, Language $language): ?string
    {
        $reference = Naming::cleanBase($reference);

        if ($reference === '') {
            return null;
        }

        if (isset($symbols['types'][$reference])) {
            return $symbols['types'][$reference];
        }

        $candidates = $symbols['types_by_name'][$reference] ?? [];

        if ($candidates === []) {
            // Case-insensitive second pass, because C# and C++ disagree on casing.
            foreach ($symbols['types_by_name'] as $name => $keys) {
                if (strcasecmp($name, $reference) === 0) {
                    $candidates = $keys;

                    break;
                }
            }
        }

        if ($candidates === []) {
            // Last resort: match the tail of a qualified name, e.g. `Models.Task`
            // written inside a namespace that already imports `Models`.
            foreach (array_keys($symbols['types']) as $fqn) {
                if (Naming::refersTo($reference, $fqn)) {
                    $candidates[] = $fqn;
                }
            }
        }

        return $candidates === [] ? null : ($symbols['types'][$candidates[0]] ?? null);
    }

    /** @return array<int, string> identifiers found in a type expression */
    private function identifiers(string $text): array
    {
        preg_match_all('/[A-Za-z_][A-Za-z0-9_]*/', $text, $matches);

        return array_values(array_unique($matches[0] ?? []));
    }
}
