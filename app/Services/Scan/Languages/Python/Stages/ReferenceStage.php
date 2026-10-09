<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python\Stages;

use App\Enums\EdgeKind;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Python\PythonIndex;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 5 of the Python pipeline — imports, and the strings that name things.
 *
 * `import` is Python's one structural statement, so it is the backbone of the
 * map: `from app.models import Bookmark` becomes a real edge from the module
 * that imports to the module that declares, and a third-party import lands on
 * the package node the build stage already created. When a target is neither in
 * the project nor in the manifest it is counted honestly as unresolved rather
 * than drawn as an invented edge.
 *
 * The second half is strings that name classes — `ForeignKey('Bookmark')`,
 * `get_model('shop.Bookmark')`, a type hint in a signature. Those are the joins
 * a reader cannot see from the syntax alone, so they are drawn as `uses`.
 */
class ReferenceStage implements Stage
{
    public function __construct(private readonly PythonIndex $index) {}

    public function name(): ScanStage
    {
        return ScanStage::References;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $raw = $context->readArtifact('references')['references'] ?? [];
        $modules = $this->index->modules($context);

        $moduleKeys = $symbols['modules'] ?? [];
        $typeKeys = $symbols['types'] ?? [];
        $typesByName = $symbols['types_by_name'] ?? [];

        $packageKeys = [];

        foreach ($graph->nodes() as $key => $node) {
            if (($node['type'] ?? null) === NodeType::Package->value) {
                $packageKeys[strtolower($node['label'])] = $key;
            }
        }

        $counts = ['imports' => 0, 'resolved' => 0, 'internal' => 0, 'external' => 0, 'literals' => 0, 'unresolved' => 0];
        $seen = [];

        // ---- imports ---------------------------------------------------------
        foreach ($raw as $reference) {
            if (! in_array($reference['kind'], ['import', 'from'], true)) {
                continue;
            }

            $from = $moduleKeys[$reference['module']] ?? null;

            if ($from === null) {
                continue;
            }

            $counts['imports']++;
            $target = (string) ($reference['target'] ?? '');
            $name = $reference['name'] ?? null;
            $resolved = null;

            // `from . import views` and `from .models import Bookmark`: a
            // relative import is always inside the project, so resolve it by
            // walking up the package path.
            if (($reference['relative'] ?? 0) > 0) {
                $base = $this->relativeModule((string) $reference['module'], (int) $reference['relative'], $target);
                $resolved = $this->lookup($base, $name, $moduleKeys, $typeKeys);

                if ($resolved === null && $name !== null) {
                    $resolved = $this->lookup($base.'.'.$name, null, $moduleKeys, $typeKeys);
                }
            } else {
                $resolved = $this->lookup($target, $name, $moduleKeys, $typeKeys);

                // A local module imported by its short name (`import models`).
                if ($resolved === null) {
                    $sibling = $this->sibling((string) $reference['module'], $target);
                    $resolved = $this->lookup($sibling, $name, $moduleKeys, $typeKeys);
                }
            }

            if ($resolved === null) {
                // Not in the project — but a declared dependency is still a real
                // answer, and the package node is already on the map.
                $head = strtolower(explode('.', $target)[0]);

                if (isset($packageKeys[$head])) {
                    $resolved = $packageKeys[$head];
                }
            }

            if ($resolved === null) {
                $counts['unresolved']++;

                continue;
            }

            $counts['resolved']++;
            $counts[str_starts_with($resolved, 'pkg:') ? 'external' : 'internal']++;

            $hash = $from.'|'.$resolved;

            if (isset($seen[$hash])) {
                continue;
            }

            $seen[$hash] = true;

            $graph->edge($from, $resolved, EdgeKind::Imports, [
                'label' => $name !== null ? $target.'.'.$name : $target,
            ]);
        }

        // ---- strings and annotations that name a class -------------------------
        foreach ($raw as $reference) {
            if (($reference['kind'] ?? '') !== 'literal') {
                continue;
            }

            $from = $moduleKeys[$reference['module']] ?? null;
            $value = trim((string) ($reference['target'] ?? ''));

            if ($from === null || $value === '') {
                continue;
            }

            $counts['literals']++;
            $target = $this->literalTarget($value, $reference['module'], $typesByName, $typeKeys);

            if ($target === null || $target === $from) {
                continue;
            }

            $hash = 'lit|'.$from.'|'.$target;

            if (isset($seen[$hash])) {
                continue;
            }

            $seen[$hash] = true;

            $graph->edge($from, $target, EdgeKind::Uses, ['label' => $value]);
        }

        // ---- type hints --------------------------------------------------------
        foreach ($modules as $module) {
            $from = $moduleKeys[$module['module']] ?? null;

            if ($from === null) {
                continue;
            }

            $parsed = $module['parsed'];

            foreach ($parsed['types'] ?? [] as $type) {
                foreach ($type['fields'] ?? [] as $field) {
                    $this->hint($graph, $from, (string) ($field['type'] ?? ''), $typesByName, $typeKeys, $symbols);
                }

                foreach ($type['bases'] ?? [] as $base) {
                    $this->hint($graph, $from, (string) ($base['name'] ?? ''), $typesByName, $typeKeys, $symbols);
                }
            }

            foreach ($parsed['functions'] ?? [] as $function) {
                foreach ($function['args'] ?? [] as $argument) {
                    $this->hint($graph, $from, (string) (is_array($argument) ? ($argument['annotation'] ?? '') : ''), $typesByName, $typeKeys, $symbols);
                }

                $returns = $function['returns'] ?? null;

                if (is_string($returns)) {
                    $this->hint($graph, $from, $returns, $typesByName, $typeKeys, $symbols);
                }
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('reference_index', [
            'imports' => $counts['imports'],
            'resolved' => $counts['resolved'],
        ]);

        $context->log(sprintf(
            'imports: %d resolved (%d in project, %d packages) · %d unresolved',
            $counts['resolved'],
            $counts['internal'],
            $counts['external'],
            $counts['unresolved'],
        ));

        return [
            'summary' => sprintf('%d imports resolved · %d by name', $counts['resolved'], $counts['literals']),
            'metrics' => $counts,
        ];
    }

    /** A type hint becomes a `uses` edge when it names something in the project. */
    private function hint(GraphBuilder $graph, string $from, string $hint, array $typesByName, array $typeKeys, array $symbols): void
    {
        $hint = trim($hint);

        if ($hint === '' || in_array(strtolower($hint), ['int', 'str', 'bool', 'float', 'bytes', 'none', 'list', 'dict', 'set', 'tuple', 'any', 'optional', 'callable', 'self'], true)) {
            return;
        }

        $target = $this->literalTarget($hint, '', $typesByName, $typeKeys);

        if ($target === null || $target === $from) {
            return;
        }

        $graph->edge($from, $target, EdgeKind::Uses, ['label' => $hint]);
    }

    /**
     * `app.models.Bookmark`, `Bookmark`, `'Bookmark'` and `'shop.Bookmark'`
     * all point at the same class.
     */
    private function literalTarget(string $value, string $currentModule, array $typesByName, array $typeKeys): ?string
    {
        $value = trim($value, "'\" ");

        if ($value === '' || str_contains($value, '/') || str_contains($value, ' ')) {
            return null;
        }

        if (isset($typeKeys[$value])) {
            return $typeKeys[$value];
        }

        if ($currentModule !== '' && isset($typeKeys[$currentModule.'.'.$value])) {
            return $typeKeys[$currentModule.'.'.$value];
        }

        // `Optional[Bookmark]`, `dict[str, Bookmark]`, `app.models.Bookmark` and
        // `Bookmark` all end at the same name, so every dotted token is tried.
        preg_match_all('/[A-Za-z_][A-Za-z0-9_.]*/', $value, $tokens);

        foreach ($tokens[0] as $token) {
            $token = trim($token, '.');

            if ($token === '' || in_array(strtolower($token), ['list', 'dict', 'set', 'tuple', 'optional', 'union', 'any', 'sequence', 'iterable', 'type', 'classvar', 'final', 'annotated', 'literal'], true)) {
                continue;
            }

            if (isset($typeKeys[$token])) {
                return $typeKeys[$token];
            }

            $segments = explode('.', $token);
            $base = (string) end($segments);

            if ($currentModule !== '' && isset($typeKeys[$currentModule.'.'.$token])) {
                return $typeKeys[$currentModule.'.'.$token];
            }

            foreach ($typesByName[$base] ?? [] as $qualified) {
                return $typeKeys[$qualified];
            }
        }

        return null;
    }

    /** `app.bookmarks.views` + 1 dot → `app.bookmarks`. */
    private function relativeModule(string $module, int $dots, string $target): string
    {
        $segments = explode('.', $module);
        // `from .models import X` in `app.bookmarks.views` means the package
        // `app.bookmarks`; each extra dot climbs one package higher.
        $keep = max(0, count($segments) - 1 - max(0, $dots - 1));

        $base = implode('.', array_slice($segments, 0, $keep));

        if ($target !== '') {
            $base = trim($base.'.'.$target, '.');
        }

        return $base;
    }

    private function sibling(string $module, string $target): string
    {
        $parent = str_contains($module, '.') ? substr($module, 0, (int) strrpos($module, '.')) : '';

        return $parent === '' ? $target : $parent.'.'.$target;
    }

    /** Try a dotted module, then a class inside it. */
    private function lookup(string $module, ?string $name, array $moduleKeys, array $typeKeys): ?string
    {
        $module = trim($module, '.');

        if ($module === '') {
            return null;
        }

        if ($name !== null && $name !== '*' && isset($typeKeys[$module.'.'.$name])) {
            return $typeKeys[$module.'.'.$name];
        }

        if (isset($moduleKeys[$module])) {
            return $moduleKeys[$module];
        }

        if (isset($typeKeys[$module])) {
            return $typeKeys[$module];
        }

        // `from app import models` where models is a package.
        if ($name !== null && isset($moduleKeys[$module.'.'.$name])) {
            return $moduleKeys[$module.'.'.$name];
        }

        return null;
    }
}
