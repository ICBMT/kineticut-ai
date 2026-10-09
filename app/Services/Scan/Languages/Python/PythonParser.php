<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python;

/**
 * Python, read the way Python is written.
 *
 * There is no brace to count and no header to include, so this parser is built
 * on the one thing Python actually uses to say who belongs to whom: indentation.
 * It walks the file line by line, keeps a stack of open `class`/`def` blocks keyed
 * by indent width, and attributes every function, method and call to the block
 * it sits inside. That single idea is enough to produce modules, classes,
 * functions, decorators, annotations, imports and call sites — the furniture the
 * rest of the pipeline turns into a graph.
 *
 * Two decisions worth stating, because they are the ones that keep this honest:
 *
 *  - **Nothing throws.** The input is somebody else's codebase, and a scan must
 *    finish. Unterminated strings, stray decorators, tabs where spaces were
 *    promised: every one of them degrades to "less was understood", never to a
 *    failed stage.
 *  - **Docstrings are read, guesses are not.** A string literal immediately
 *    after a class/def header is documentation and is captured as such. String
 *    literals *inside* calls are only reported when a caller asks for them
 *    (route paths, template names) — which is how the graph gets real file
 *    paths and URL patterns without pattern-matching prose.
 */
class PythonParser
{
    /** Nesting deeper than this is machine-generated; stop tracking scopes. */
    private const MAX_DEPTH = 24;

    /**
     * Read one file.
     *
     * @return array{
     *     doc: ?string,
     *     functions: array<int, array<string, mixed>>,
     *     types: array<int, array<string, mixed>>,
     *     imports: array<int, array<string, mixed>>,
     *     calls: array<int, array<string, mixed>>,
     *     variables: array<int, array<string, mixed>>,
     *     decorators: array<int, array<string, mixed>>,
     *     literals: array<int, array<string, mixed>>,
     *     entry: bool
     * }
     */
    public function parse(string $source): array
    {
        $result = [
            'doc' => null,
            'entry_line' => null,
            'functions' => [],
            'types' => [],
            'imports' => [],
            'calls' => [],
            'variables' => [],
            'decorators' => [],
            'literals' => [],
            'entry' => false,
        ];

        $lines = $this->logicalLines($source);

        /** @var array<int, array{indent:int, kind:string, index:int}> $scopes */
        $scopes = [];

        /** @var array<int, string> $pendingDecorators */
        $pendingDecorators = [];
        $pendingRecords = [];

        $docTarget = null;

        foreach ($lines as $line) {
            $indent = $line['indent'];
            $text = $line['text'];

            if ($text === '') {
                continue;
            }

            // Close any block this line has dedented out of.
            while ($scopes !== [] && $indent <= end($scopes)['indent']) {
                $closed = array_pop($scopes);

                if ($closed['kind'] === 'class') {
                    $result['types'][$closed['index']]['end_line'] = $line['line'] - 1;
                } else {
                    $result['functions'][$closed['index']]['end_line'] = $line['line'] - 1;
                }
            }

            if ($docTarget !== null && ! $this->isDocstring($text)) {
                $docTarget = null;
            }

            // ---- decorators --------------------------------------------------
            if (str_starts_with($text, '@')) {
                $decorator = $this->decorator($text, $line['line']);

                if ($decorator !== null) {
                    $pendingDecorators[] = $decorator['name'];
                    $pendingRecords[] = $decorator;
                    $result['decorators'][] = $decorator;
                }

                $this->collectCalls($result, $text, $line['line'], $this->currentContext($scopes, $result), true);

                continue;
            }

            // ---- docstring of the previous declaration -----------------------
            if ($this->isDocstring($text)) {
                if ($docTarget !== null) {
                    $this->attachDoc($result, $docTarget, $this->docstringContent($text));
                    $docTarget = null;
                }

                continue;
            }

            // ---- class -------------------------------------------------------
            if (preg_match('/^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?\s*:/', $text, $match)) {
                $name = $match[1];
                $parent = $this->enclosingType($scopes, $result);
                $bases = $this->bases($match[3] ?? '');

                $index = count($result['types']);
                $result['types'][] = [
                    'name' => $name,
                    'nested_in' => $parent['name'] ?? null,
                    'kind' => $this->classKind($bases),
                    'bases' => $bases,
                    'decorators' => $pendingDecorators,
                    'decorator_records' => $pendingRecords,
                    'line' => $line['line'],
                    'end_line' => $line['line'],
                    'members' => [],
                    'doc' => null,
                ];

                $pendingDecorators = [];
                $pendingRecords = [];
                $docTarget = ['kind' => 'type', 'index' => $index];

                if (count($scopes) < self::MAX_DEPTH) {
                    $scopes[] = ['indent' => $indent, 'kind' => 'class', 'index' => $index];
                }

                continue;
            }

            // ---- function / method -------------------------------------------
            if (preg_match('/^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/', $text, $match)) {
                $name = $match[2];
                $isAsync = trim($match[1] ?? '') === 'async';
                $owner = $this->enclosingType($scopes, $result);

                $index = count($result['functions']);
                $function = [
                    'name' => $name,
                    'owner' => $owner['name'] ?? null,
                    'owner_index' => $owner['index'] ?? null,
                    'kind' => $owner !== null ? 'method' : 'function',
                    'signature' => $this->signature($text),
                    'args' => $this->arguments($text),
                    'returns' => $this->returnType($text),
                    'decorators' => $pendingDecorators,
                    'decorator_records' => $pendingRecords,
                    'line' => $line['line'],
                    'end_line' => $line['line'],
                    'async' => $isAsync,
                    'doc' => null,
                ];

                $result['functions'][] = $function;
                $pendingDecorators = [];
                $pendingRecords = [];
                $docTarget = ['kind' => 'function', 'index' => $index];

                if (count($scopes) < self::MAX_DEPTH) {
                    $scopes[] = ['indent' => $indent, 'kind' => 'function', 'index' => $index];
                }

                // A method is part of its class, so the class can list it later.
                if ($owner['index'] !== null) {
                    $result['types'][$owner['index']]['members'][] = [
                        'name' => $name,
                        'kind' => $this->memberKind($name, $function['decorators']),
                        'line' => $line['line'],
                        'signature' => $function['signature'],
                        'static' => in_array('staticmethod', $function['decorators'], true)
                            || in_array('classmethod', $function['decorators'], true),
                        'async' => $isAsync,
                        'doc' => null,
                    ];
                }

                $this->collectCalls($result, $text, $line['line'], $this->currentContext($scopes, $result));

                continue;
            }

            // ---- imports ------------------------------------------------------
            if ($this->import($text, $line['line'], $result)) {
                continue;
            }

            // ---- `if __name__ == "__main__":` ---------------------------------
            if (preg_match('/^if\s+__name__\s*==\s*[\'"]__main__[\'"]/', $text) === 1) {
                $result['entry'] = true;
                $result['entry_line'] = $line['line'];

                continue;
            }

            // ---- module-level names -------------------------------------------
            if ($scopes === [] && preg_match('/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/', $text, $match)) {
                $value = trim($match[3]);
                $call = null;

                if (preg_match('/^([A-Za-z_][A-Za-z0-9_\.]*)\s*\(/', $value, $called)) {
                    $call = $called[1];
                }

                $result['variables'][] = [
                    'name' => $match[1],
                    'annotation' => isset($match[2]) ? trim($match[2]) : null,
                    'call' => $call,
                    'line' => $line['line'],
                ];
            } elseif ($scopes !== [] && end($scopes)['kind'] === 'function'
                && preg_match('/^(self\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/', $text, $match)) {
                // A local name is how Python says "this thing has this type":
                // `bookmark = Bookmark(...)`, `service = BookmarkService()`.
                // Recording it is what lets a later `service.create(...)` be
                // traced to the class that defines `create`.
                $value = trim($match[4]);
                $call = null;

                if (preg_match('/^([A-Za-z_][A-Za-z0-9_\.]*)\s*\(/', $value, $called)) {
                    $call = $called[1];
                }

                $context = $this->currentContext($scopes, $result);

                $result['variables'][] = [
                    'name' => $match[2],
                    'annotation' => isset($match[3]) ? trim($match[3]) : null,
                    'call' => $call,
                    'owner' => $context['type'] ?? null,
                    'function' => $context['function'] ?? null,
                    'attribute' => ($match[1] ?? '') === 'self.',
                    'line' => $line['line'],
                ];

                // `self.repository = ...` in `__init__` declares a field on the
                // class, so a method using it resolves to the same type.
                if (($match[1] ?? '') === 'self.' && ($context['type'] ?? null) !== null) {
                    $owner = $this->enclosingType($scopes, $result);

                    if ($owner['index'] !== null && $call !== null) {
                        $result['types'][$owner['index']]['fields'][] = [
                            'name' => $match[2],
                            'type' => $call,
                            'value' => $value,
                            'line' => $line['line'],
                            'implicit' => true,
                        ];
                    }
                }
            } elseif ($scopes !== [] && end($scopes)['kind'] === 'class'
                && preg_match('/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/', $text, $match)) {
                // Class-level annotation (`title = models.CharField(...)`) is how
                // Django and SQLAlchemy declare their columns.
                $owner = $this->enclosingType($scopes, $result);

                if ($owner['index'] !== null) {
                    $result['types'][$owner['index']]['fields'][] = [
                        'name' => $match[1],
                        'type' => isset($match[2]) ? trim($match[2]) : null,
                        'value' => trim($match[3]),
                        'line' => $line['line'],
                    ];
                }
            }

            $this->collectLiterals($result, $text, $line['line']);
            $this->collectCalls($result, $text, $line['line'], $this->currentContext($scopes, $result));
        }

        // Anything still open at EOF ends at the last line seen.
        $lastLine = $lines === [] ? 1 : end($lines)['line'];

        foreach ($scopes as $scope) {
            if ($scope['kind'] === 'class') {
                $result['types'][$scope['index']]['end_line'] ??= $lastLine;
            } else {
                $result['functions'][$scope['index']]['end_line'] ??= $lastLine;
            }
        }

        return $result;
    }

    /* ------------------------------------------------------------ reading -- */

    /**
     * Physical lines → logical lines.
     *
     * Three jobs in one pass, because they all depend on the same state:
     *  - comments are removed (a `#` inside a string is not a comment),
     *  - a statement continued inside brackets is folded onto its first line
     *    (`def view(\n  request,\n):` is one declaration),
     *  - each line's indent width is measured, which is the grouping signal the
     *    rest of the parser runs on.
     *
     * @return array<int, array{line:int, indent:int, text:string}>
     */
    private function logicalLines(string $source): array
    {
        $source = str_replace(["\r\n", "\r"], "\n", $source);
        $physical = explode("\n", $source);

        $lines = [];
        $buffer = '';
        $bufferLine = 1;
        $bufferIndent = 0;
        $depth = 0;
        $triple = null;

        foreach ($physical as $number => $raw) {
            $lineNumber = $number + 1;
            $indent = $this->indentWidth($raw);
            $text = $buffer === '' ? ltrim($raw) : trim($raw);

            [$text, $depth, $triple] = $this->stripComments($text, $depth, $triple);

            if ($text === '' && $depth === 0) {
                continue;
            }

            if ($buffer === '') {
                $bufferLine = $lineNumber;
                $bufferIndent = $indent;
                $buffer = $text;
            } else {
                $buffer .= ' '.$text;
            }

            if ($depth <= 0) {
                $lines[] = [
                    'line' => $bufferLine,
                    'indent' => $bufferIndent,
                    'text' => trim($buffer),
                ];
                $buffer = '';
                $depth = 0;
            }
        }

        if (trim($buffer) !== '') {
            $lines[] = ['line' => $bufferLine, 'indent' => $bufferIndent, 'text' => trim($buffer)];
        }

        return $lines;
    }

    /** Tabs count as four columns, which is what all three majors assume. */
    private function indentWidth(string $raw): int
    {
        $width = 0;

        foreach (str_split($raw) as $character) {
            if ($character === ' ') {
                $width++;
            } elseif ($character === "\t") {
                $width += 4;
            } else {
                break;
            }
        }

        return $width;
    }

    /**
     * Remove the comment on a line, tracking bracket depth and block strings so
     * neither a `#` inside a string nor a bracket inside a docstring can confuse
     * the reader.
     *
     * @return array{0:string, 1:int, 2:?string} text, bracket depth, open triple quote
     */
    private function stripComments(string $text, int $depth, ?string $triple): array
    {
        $out = '';
        $length = strlen($text);

        for ($i = 0; $i < $length; $i++) {
            $character = $text[$i];

            // Still inside a block string from an earlier line: copy until it closes.
            if ($triple !== null) {
                $end = strpos($text, $triple, $i);

                if ($end === false) {
                    $out .= substr($text, $i);

                    break;
                }

                $out .= substr($text, $i, $end + 3 - $i);
                $i = $end + 2;
                $triple = null;

                continue;
            }

            if ($character === '"' || $character === "'") {
                $candidate = substr($text, $i, 3);

                // A block string — docstring or multi-line literal. Its content
                // is text, so it is copied without being read for syntax.
                if ($candidate === '"""' || $candidate === "'''") {
                    $end = strpos($text, $candidate, $i + 3);

                    if ($end === false) {
                        $out .= substr($text, $i);
                        $triple = $candidate;

                        break;
                    }

                    $out .= substr($text, $i, $end + 3 - $i);
                    $i = $end + 2;

                    continue;
                }

                // An ordinary literal: consumed whole, escapes and all.
                $quote = $character;
                $out .= $character;
                $i++;

                while ($i < $length) {
                    $inner = $text[$i];
                    $out .= $inner;

                    if ($inner === '\\') {
                        $i++;
                        $out .= $text[$i] ?? '';
                    } elseif ($inner === $quote) {
                        break;
                    }

                    $i++;
                }

                continue;
            }

            if ($character === '#') {
                break;
            }

            if ($character === '(' || $character === '[' || $character === '{') {
                $depth++;
            } elseif ($character === ')' || $character === ']' || $character === '}') {
                $depth--;
            }

            $out .= $character;
        }

        return [$out, max(0, $depth), $triple];
    }

    private function isDocstring(string $text): bool
    {
        return (str_starts_with($text, '"""') || str_starts_with($text, "'''")) && strlen($text) > 6;
    }

    private function docstringContent(string $text): ?string
    {
        $quote = substr($text, 0, 3);
        $body = trim($text, "\"' \t");

        // Keep the first line only: a brief's line budget is not a place for
        // somebody's three-paragraph module essay.
        $first = trim(strtok($body, "\n") ?: '');

        return $first === '' ? null : mb_substr($first, 0, 220);
    }

    /* ------------------------------------------------------- declarations -- */

    /** `class Note(models.Model):` → `['models.Model']`; keywords are dropped. */
    /** @return array<int, array{name:string, generic:?string}> */
    private function bases(string $inside): array
    {
        if (trim($inside) === '') {
            return [];
        }

        $bases = [];

        foreach ($this->commas($inside) as $base) {
            $base = trim($base);

            if ($base === '') {
                continue;
            }

            // Keyword arguments (`metaclass=ABCMeta`) are not base classes.
            if (str_contains($base, '=')) {
                continue;
            }

            // `Base[int]` is a generic parameter, not a different base.
            $generic = null;

            if (preg_match('/^([^\[\(]+)\[([^\]]+)\]/', $base, $match) === 1) {
                $generic = trim($match[2]);
                $base = trim($match[1]);
            }

            $base = trim(preg_split('/[\[\(]/', $base)[0] ?? $base);

            if ($base !== '') {
                $bases[] = ['name' => $base, 'generic' => $generic];
            }
        }

        return $bases;
    }

    private function classKind(array $bases): string
    {
        // Bases arrive as records; the kind only cares about the names.
        $lower = array_map(
            fn ($base) => strtolower(is_array($base) ? (string) ($base['name'] ?? '') : (string) $base),
            $bases,
        );

        foreach (['enum', 'intenum', 'strenum', 'flag'] as $enum) {
            if (in_array($enum, $lower, true) || in_array('enum.'.$enum, $lower, true)) {
                return 'enum';
            }
        }

        foreach (['protocol'] as $protocol) {
            if (in_array($protocol, $lower, true) || in_array('typing.'.$protocol, $lower, true)) {
                return 'protocol';
            }
        }

        foreach (['abc', 'abstractmethod'] as $abstract) {
            if (in_array($abstract, $lower, true)) {
                return 'abstract';
            }
        }

        return 'class';
    }

    private function memberKind(string $name, array $decorators): string
    {
        if (in_array('property', $decorators, true) || in_array('cached_property', $decorators, true)) {
            return 'property';
        }

        if ($name === '__init__') {
            return 'constructor';
        }

        if (in_array('staticmethod', $decorators, true)) {
            return 'staticmethod';
        }

        if (in_array('classmethod', $decorators, true)) {
            return 'classmethod';
        }

        return 'method';
    }

    /** `def view(request, pk: int) -> HttpResponse:` → the whole header text. */
    private function signature(string $text): string
    {
        return mb_substr(rtrim(trim($text), ':'), 0, 240);
    }

    /**
     * @return array<int, array{name:string, annotation:?string, default:?string, variadic:bool}>
     */
    private function arguments(string $text): array
    {
        if (! preg_match('/\((.*)\)/s', $text, $match)) {
            return [];
        }

        $args = [];

        foreach ($this->commas($match[1]) as $argument) {
            $argument = trim($argument);

            if ($argument === '' || $argument === '/' || $argument === '*') {
                continue;
            }

            $variadic = str_starts_with($argument, '*');
            $argument = ltrim($argument, '*');
            $default = null;

            // `name: type = default` — the default is everything after the first
            // top-level `=`, the annotation everything between `:` and it.
            $parts = $this->splitOn($argument, '=');

            if (count($parts) > 1) {
                $argument = array_shift($parts);
                $default = trim(implode('=', $parts));
            }

            $parts = $this->splitOn($argument, ':');
            $name = trim(array_shift($parts) ?? '');
            $annotation = $parts !== [] ? trim(implode(':', $parts)) : null;

            if ($name === '') {
                continue;
            }

            $args[] = [
                'name' => $name,
                'annotation' => $annotation !== '' ? $annotation : null,
                'default' => $default !== '' && $default !== null ? $default : null,
                'variadic' => $variadic,
            ];
        }

        return $args;
    }

    /** Split on a separator, but never inside brackets or quotes. */
    private function splitOn(string $text, string $separator): array
    {
        $parts = [];
        $buffer = '';
        $depth = 0;
        $quote = null;
        $length = strlen($text);

        for ($i = 0; $i < $length; $i++) {
            $character = $text[$i];

            if ($quote !== null) {
                $buffer .= $character;

                if ($character === $quote && ($i === 0 || $text[$i - 1] !== '\\')) {
                    $quote = null;
                }

                continue;
            }

            if ($character === '"' || $character === "'") {
                $quote = $character;
                $buffer .= $character;

                continue;
            }

            if ($character === '(' || $character === '[' || $character === '{') {
                $depth++;
            } elseif ($character === ')' || $character === ']' || $character === '}') {
                $depth--;
            }

            if ($character === $separator && $depth === 0) {
                $parts[] = $buffer;
                $buffer = '';

                continue;
            }

            $buffer .= $character;
        }

        $parts[] = $buffer;

        return $parts;
    }

    /** @return array<int, string> */
    private function commas(string $text): array
    {
        return $this->splitOn($text, ',');
    }

    private function returnType(string $text): ?string
    {
        return preg_match('/\)\s*->\s*([^:]+):/', $text, $match) === 1 ? trim($match[1]) : null;
    }

    /** @return array{name:string, args:array<int,string>}|null */
    private function decorator(string $text, int $line): ?array
    {
        if (preg_match('/^@\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*(\((.*)\))?\s*$/', $text, $match)) {
            return [
                'name' => $match[1],
                'args' => $this->literalStrings($match[3] ?? ''),
                'raw' => mb_substr(trim($match[3] ?? ''), 0, 300),
                'line' => $line,
            ];
        }

        return null;
    }

    /* ------------------------------------------------------------- imports -- */

    private function import(string $text, int $line, array &$result): bool
    {
        // from .models import Note, Tag as Label
        if (preg_match('/^from\s+([A-Za-z_\.][A-Za-z0-9_\.]*)\s+import\s+(.+)$/', $text, $match)) {
            $module = $match[1];
            $names = [];

            foreach (explode(',', trim($match[2], '() ')) as $name) {
                $name = trim($name);

                if ($name === '') {
                    continue;
                }

                $alias = null;

                if (preg_match('/^([A-Za-z_][A-Za-z0-9_]*|\*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/', $name, $aliasMatch)) {
                    $name = $aliasMatch[1];
                    $alias = $aliasMatch[2];
                }

                $names[] = ['name' => $name, 'alias' => $alias];
            }

            $result['imports'][] = [
                'kind' => 'from',
                'module' => $module,
                'relative' => strspn($module, '.'),
                'names' => $names,
                'line' => $line,
            ];

            return true;
        }

        // import os, sys as system
        if (preg_match('/^import\s+(.+)$/', $text, $match)) {
            foreach (explode(',', $match[1]) as $part) {
                $part = trim($part);

                if ($part === '') {
                    continue;
                }

                $alias = null;

                if (preg_match('/^([A-Za-z_][A-Za-z0-9_\.]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/', $part, $aliasMatch)) {
                    $part = $aliasMatch[1];
                    $alias = $aliasMatch[2];
                }

                $result['imports'][] = [
                    'kind' => 'import',
                    'module' => $part,
                    'relative' => 0,
                    'names' => [],
                    'alias' => $alias,
                    'line' => $line,
                ];
            }

            return true;
        }

        return false;
    }

    /* --------------------------------------------------------------- calls -- */

    /**
     * Call sites, with the receiver that makes them resolvable later:
     * `service.create(...)` → receiver `service`, name `create`.
     *
     * @param  array{type:?string, function:?string}|null  $context
     */
    private function collectCalls(array &$result, string $text, int $line, ?array $context, bool $decorator = false): void
    {
        // Skip the declaration header itself: `def view(request)` is not a call.
        if (! $decorator && preg_match('/^(async\s+)?(def|class)\s/', $text)) {
            return;
        }

        if (! preg_match_all('/(?<![A-Za-z0-9_\.])([A-Za-z_][A-Za-z0-9_]*)?(?:\.([A-Za-z_][A-Za-z0-9_]*))*\s*\(/', $text, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
            return;
        }

        foreach ($matches as $match) {
            $offset = $match[0][1];
            $full = rtrim($match[0][0], ' (');

            if (in_array($full, ['if', 'elif', 'while', 'for', 'return', 'and', 'or', 'not', 'in', 'is', 'assert', 'with', 'lambda', 'yield', 'del', 'print'], true)) {
                continue;
            }

            $parts = explode('.', $full);
            $name = array_pop($parts);
            $receiver = $parts === [] ? null : end($parts);

            $open = strpos($text, '(', $offset);

            $result['calls'][] = [
                'receiver' => $receiver,
                'name' => $name,
                'chain' => $full,
                'args' => $open === false ? '' : $this->callArguments($text, $open),
                'line' => $line,
                'owner' => $context['type'] ?? null,
                'function' => $context['function'] ?? null,
                'decorator' => $decorator,
            ];
        }
    }

    /** The text inside a call's parentheses, balanced and trimmed. */
    private function callArguments(string $text, int $open): string
    {
        $depth = 0;
        $length = strlen($text);
        $out = '';

        for ($i = $open; $i < $length; $i++) {
            $character = $text[$i];

            if ($character === '(') {
                $depth++;

                if ($depth === 1) {
                    continue;
                }
            } elseif ($character === ')') {
                $depth--;

                if ($depth === 0) {
                    break;
                }
            }

            if ($depth >= 1) {
                $out .= $character;
            }
        }

        return mb_substr(trim($out), 0, 300);
    }

    /** String literals on a line — used for template paths and URL patterns. */
    private function collectLiterals(array &$result, string $text, int $line): void
    {
        foreach ($this->literalStrings($text) as $literal) {
            if (str_contains($literal, '/') || str_contains($literal, '.')) {
                $result['literals'][] = ['value' => $literal, 'line' => $line];
            }
        }
    }

    /** @return array<int, string> */
    private function literalStrings(string $text): array
    {
        $found = [];

        if (preg_match_all('/([\'"fru]{0,2})(["\'])((?:\\\\.|(?!\2).)*)\2/', $text, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $found[] = str_replace('\\\\', '\\', $match[3]);
            }
        }

        return $found;
    }

    /**
     * The declaration a line sits inside, which is what a call needs to know to
     * be attributed to its caller.
     *
     * @return array{type:?string, function:?string}|null
     */
    private function currentContext(array $scopes, array $result): ?array
    {
        if ($scopes === []) {
            return null;
        }

        $type = null;
        $function = null;

        foreach (array_reverse($scopes) as $scope) {
            if ($scope['kind'] === 'class' && $type === null && isset($result['types'][$scope['index']])) {
                $type = $result['types'][$scope['index']]['name'];
            }

            if ($scope['kind'] === 'function' && $function === null && isset($result['functions'][$scope['index']])) {
                $function = $result['functions'][$scope['index']]['name'];
            }
        }

        return ['type' => $type, 'function' => $function];
    }

    /** @return array{name:?string, index:?int} */
    private function enclosingType(array $scopes, array $result): array
    {
        foreach (array_reverse($scopes) as $scope) {
            if ($scope['kind'] === 'class' && isset($result['types'][$scope['index']])) {
                return ['name' => $result['types'][$scope['index']]['name'], 'index' => $scope['index']];
            }
        }

        return ['name' => null, 'index' => null];
    }

    private function attachDoc(array &$result, array $target, ?string $doc): void
    {
        if ($doc === null) {
            return;
        }

        if ($target['kind'] === 'type') {
            $result['types'][$target['index']]['doc'] ??= $doc;
        } else {
            $result['functions'][$target['index']]['doc'] ??= $doc;

            // Keep the class member list in step — the Details tab shows it.
            $owner = $result['functions'][$target['index']]['owner_index'] ?? null;

            if ($owner !== null && isset($result['types'][$owner])) {
                $name = $result['functions'][$target['index']]['name'];

                foreach ($result['types'][$owner]['members'] as $position => $member) {
                    if ($member['name'] === $name && $member['doc'] === null) {
                        $result['types'][$owner]['members'][$position]['doc'] = $doc;

                        break;
                    }
                }
            }
        }
    }
}
