<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python\Stages;

use App\Enums\EdgeKind;
use App\Enums\ScanStage;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 6 of the Python pipeline — who calls whom.
 *
 * Python calls carry less type information than C-family ones, so this stage
 * resolves what can be resolved and refuses to guess the rest: `self.save()`
 * belongs to the class the method is written in, `Bookmark.objects.all()`
 * belongs to the class named `Bookmark`, a bare `helper()` is the function of
 * that name in the same module or in a module this file imported, and anything
 * else counts as unresolved.
 *
 * Calls made inside an entry script (`manage.py`, a `__main__` guard) are drawn
 * from the entry node itself, which is what makes "trace from the entry point"
 * work in Python the same way it does in C++ and C#.
 */
class CallStage implements Stage
{
    /** Method names that exist on every object and therefore mean nothing. */
    private const NOISE = [
        'append', 'extend', 'get', 'set', 'items', 'keys', 'values', 'join', 'split', 'strip',
        'format', 'copy', 'update', 'pop', 'insert', 'remove', 'replace', 'lower', 'upper',
        'encode', 'decode', 'read', 'write', 'close', 'open', 'print', 'len', 'range', 'list',
        'dict', 'set', 'tuple', 'int', 'str', 'float', 'bool', 'sum', 'min', 'max', 'sorted',
        'enumerate', 'zip', 'map', 'filter', 'isinstance', 'super', 'type', 'getattr', 'setattr',
        'hasattr', 'join', 'title', 'startswith', 'endswith', 'ljust', 'rjust', 'empty',
    ];

    public function name(): ScanStage
    {
        return ScanStage::Calls;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $callSites = $context->readArtifact('call_sites')['call_sites'] ?? [];
        $variables = $context->readArtifact('call_sites')['variables'] ?? [];

        $moduleKeys = $symbols['modules'] ?? [];
        $typeKeys = $symbols['types'] ?? [];
        $functionKeys = $symbols['functions'] ?? [];
        $typesByName = $symbols['types_by_name'] ?? [];
        $functionsByName = $symbols['functions_by_name'] ?? [];

        $imports = $this->imports($context);
        $hints = $this->variableHints($variables);

        $counts = ['calls' => 0, 'resolved' => 0, 'unresolved' => 0, 'self' => 0, 'constructors' => 0, 'entry' => 0];
        $seen = [];
        $hot = [];

        foreach ($callSites as $site) {
            $module = (string) ($site['module'] ?? '');
            $name = (string) ($site['name'] ?? '');

            if ($name === '' || in_array(strtolower($name), self::NOISE, true)) {
                continue;
            }

            $counts['calls']++;

            $from = $this->caller($module, $site, $symbols, $moduleKeys);

            if ($from === null) {
                continue;
            }

            $target = $this->resolve($site, $module, $imports, $hints, $moduleKeys, $typeKeys, $functionKeys, $typesByName, $functionsByName);

            if ($target === null) {
                $counts['unresolved']++;

                continue;
            }

            [$targetKey, $how] = $target;

            // Constructors are worth counting separately: `Bookmark(...)` is a
            // dependency, and the graph shows it as one.
            if ($how === 'constructor') {
                $counts['constructors']++;
            }

            if ($targetKey === $from) {
                $counts['self']++;

                continue;
            }

            $hash = $from.'|'.$targetKey;

            if (isset($seen[$hash])) {
                $hot[$hash]['hits']++;

                continue;
            }

            $seen[$hash] = true;
            $hot[$hash] = ['hits' => 1, 'label' => $name.'()', 'how' => $how];

            $counts['resolved']++;

            if (str_starts_with($from, 'entry:')) {
                $counts['entry']++;
            }
        }

        // The busiest calls are drawn last so their weight lands on the edge.
        uasort($hot, fn (array $a, array $b) => $a['hits'] <=> $b['hits']);

        foreach ($hot as $hash => $call) {
            [$from, $targetKey] = explode('|', $hash, 2);

            $graph->edge($from, $targetKey, EdgeKind::Calls, [
                'label' => $call['label'],
                'meta' => ['calls' => $call['hits'], 'via' => $call['how']],
            ]);
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('call_index', [
            'calls' => $counts['calls'],
            'resolved' => $counts['resolved'],
            'edges' => count($hot),
        ]);

        $context->log(sprintf(
            'calls: %d resolved of %d · %d entries from entry points · %d unresolved',
            $counts['resolved'],
            $counts['calls'],
            $counts['entry'],
            $counts['unresolved'],
        ));

        return [
            'summary' => sprintf('%d calls resolved · %d edges', $counts['resolved'], count($hot)),
            'metrics' => $counts + ['edges' => count($hot)],
        ];
    }

    /** The node a call is written inside: an entry script, a function, or a module. */
    private function caller(string $module, array $site, array $symbols, array $moduleKeys): ?string
    {
        $function = $site['function'] ?? null;

        if (is_string($function) && $function !== '' && isset($symbols['functions'][$module.'.'.$function])) {
            return $symbols['functions'][$module.'.'.$function];
        }

        return $moduleKeys[$module] ?? null;
    }

    /**
     * @return array{0:string, 1:string}|null  node key, and how it was resolved
     */
    private function resolve(
        array $site,
        string $module,
        array $imports,
        array $hints,
        array $moduleKeys,
        array $typeKeys,
        array $functionKeys,
        array $typesByName,
        array $functionsByName,
    ): ?array {
        $name = (string) $site['name'];
        $receiver = $site['receiver'] ?? null;
        $owner = $site['owner'] ?? null;

        // ---- a local name whose type this file wrote down -------------------
        // `service = BookmarkService()` … `service.create(...)`. Python types
        // variables at runtime, so the assignment is the only place the link
        // exists — and it is enough to draw it.
        $variable = $this->variableOwner($site, $receiver, $module, $hints, $imports, $typeKeys, $typesByName);

        if ($variable !== null) {
            return [$variable, 'variable'];
        }

        // ---- self.method() and cls.method() --------------------------------
        if (in_array(strtolower((string) $receiver), ['self', 'cls'], true)) {
            if (is_string($owner) && $owner !== '' && isset($typeKeys[$module.'.'.$owner])) {
                return [$typeKeys[$module.'.'.$owner], 'self'];
            }

            return null;
        }

        // ---- Class.method() — a class in this file or an imported one ------
        if (is_string($receiver) && $receiver !== '' && $receiver[0] === strtoupper($receiver[0])) {
            $classKey = $this->classKey($receiver, $module, $imports, $typeKeys, $typesByName);

            if ($classKey !== null) {
                return [$classKey, 'class'];
            }
        }

        // ---- a name imported from elsewhere --------------------------------
        if (isset($imports[$module][$name])) {
            $import = $imports[$module][$name];

            if (($import['name'] ?? null) !== null && isset($functionKeys[$import['module'].'.'.$import['name']])) {
                return [$functionKeys[$import['module'].'.'.$import['name']], 'import'];
            }

            if (isset($moduleKeys[$import['module']])) {
                return [$moduleKeys[$import['module']], 'import'];
            }

            if (isset($typeKeys[$import['module'].'.'.$name])) {
                return [$typeKeys[$import['module'].'.'.$name], 'import'];
            }
        }

        // ---- a function in this very module --------------------------------
        if (isset($functionKeys[$module.'.'.$name])) {
            return [$functionKeys[$module.'.'.$name], 'local'];
        }

        // ---- a module-level call such as `views.index(request)` ------------
        if (is_string($receiver) && $receiver !== '') {
            $candidate = $imports[$module][$receiver]['module'] ?? $receiver;

            if (isset($functionKeys[$candidate.'.'.$name])) {
                return [$functionKeys[$candidate.'.'.$name], 'module'];
            }

            if (isset($moduleKeys[$candidate])) {
                return [$moduleKeys[$candidate], 'module'];
            }
        }

        // ---- a constructor of a class that shares the name ------------------
        if (isset($typeKeys[$module.'.'.$name])) {
            return [$typeKeys[$module.'.'.$name], 'constructor'];
        }

        foreach ($typesByName[$name] ?? [] as $qualified) {
            return [$typeKeys[$qualified], 'constructor'];
        }

        foreach ($functionsByName[$name] ?? [] as $qualified) {
            return [$functionKeys[$qualified], 'unique-name'];
        }

        return null;
    }

    private function classKey(string $receiver, string $module, array $imports, array $typeKeys, array $typesByName): ?string
    {
        if (isset($typeKeys[$module.'.'.$receiver])) {
            return $typeKeys[$module.'.'.$receiver];
        }

        if (isset($imports[$module][$receiver])) {
            $import = $imports[$module][$receiver];

            if (isset($typeKeys[$import['module'].'.'.($import['name'] ?? $receiver)])) {
                return $typeKeys[$import['module'].'.'.($import['name'] ?? $receiver)];
            }
        }

        // `models.Model`-style receivers: the class is the last segment.
        foreach (explode('.', $receiver) as $segment) {
            foreach ($typesByName[$segment] ?? [] as $qualified) {
                return $typeKeys[$qualified];
            }
        }

        return null;
    }

    /**
     * The class a receiver holds, looking at the name written before the dot
     * and — for `bookmark.tags.add(...)` and `Bookmark.objects.all()` — the root
     * of the chain.
     */
    private function variableOwner(array $site, mixed $receiver, string $module, array $hints, array $imports, array $typeKeys, array $typesByName): ?string
    {
        $candidates = [];

        if (is_string($receiver) && $receiver !== '') {
            $candidates[] = $receiver;
        }

        $chain = (string) ($site['chain'] ?? '');
        $root = explode('.', $chain)[0] ?? '';

        if ($root !== '' && ! in_array($root, $candidates, true)) {
            $candidates[] = $root;
        }

        foreach ($candidates as $candidate) {
            // `Bookmark.objects.all()` — the root of the chain is the class
            // itself, which is how Django and much of the standard library is
            // written, so the capital letter is the whole signal.
            if ($candidate[0] === strtoupper($candidate[0])) {
                $key = $this->classKey($candidate, $module, $imports, $typeKeys, $typesByName);

                if ($key !== null) {
                    return $key;
                }
            }

            $owner = $hints[$module][$candidate] ?? null;

            if ($owner === null) {
                continue;
            }

            // The class may be declared here, imported, or two files away — the
            // same resolution a `ClassName.method()` receiver gets.
            $key = $this->classKey($owner, $module, $imports, $typeKeys, $typesByName);

            if ($key !== null) {
                return $key;
            }
        }

        return null;
    }

    /**
     * Module → local variable → the class it was built from.
     *
     * Both spellings count: a module-level `service = BookmarkService()`, a
     * local one inside a function, and `self.repository = Repo()` in `__init__`
     * (which the parser also stores as a field of the class).
     *
     * @return array<string, array<string, string>>
     */
    private function variableHints(array $variables): array
    {
        $hints = [];

        foreach ($variables as $variable) {
            $module = (string) ($variable['module'] ?? '');
            $name = (string) ($variable['name'] ?? '');
            $type = $this->typeName($variable);

            if ($module === '' || $name === '' || $type === null) {
                continue;
            }

            // The first sighting wins: a name reused for a different type later
            // in the same file is not worth guessing about.
            $hints[$module][$name] ??= $type;
        }

        return $hints;
    }

    /** `Bookmark(...)` and `repo: BookmarkRepo` both mean `Bookmark`/`BookmarkRepo`. */
    private function typeName(array $variable): ?string
    {
        $call = $variable['call'] ?? null;
        $annotation = $variable['annotation'] ?? null;

        foreach ([$call, $annotation] as $candidate) {
            if (! is_string($candidate) || trim($candidate) === '') {
                continue;
            }

            $candidate = trim($candidate);
            $segments = explode('.', $candidate);
            $name = (string) end($segments);

            // Generics and unions are not a single type: `Optional[Bookmark]`.
            if (preg_match('/^([A-Za-z_][A-Za-z0-9_]*)/', $name, $match) === 1) {
                return $match[1];
            }
        }

        return null;
    }

    /** Module → local name → what it points at, derived from the reference artefact. */
    private function imports(ScanContext $context): array
    {
        $references = $context->readArtifact('references')['references'] ?? [];
        $map = [];

        foreach ($references as $reference) {
            if (($reference['kind'] ?? '') !== 'import' && ($reference['kind'] ?? '') !== 'from') {
                continue;
            }

            $module = (string) ($reference['module'] ?? '');
            $target = (string) ($reference['target'] ?? '');
            $name = $reference['name'] ?? null;
            $alias = $reference['alias'] ?? null;

            if ($name !== null && $name !== '*') {
                $local = is_string($alias) && $alias !== '' ? $alias : $name;
                $map[$module][$local] = ['module' => $target, 'name' => $name];

                continue;
            }

            // `import app.models` — the local name is the alias or the last part.
            $segments = array_values(array_filter(explode('.', $target)));
            $local = is_string($alias) && $alias !== '' ? $alias : (string) end($segments);

            if ($local !== '') {
                $map[$module][$local] = ['module' => $target, 'name' => null];
            }
        }

        return $map;
    }
}
