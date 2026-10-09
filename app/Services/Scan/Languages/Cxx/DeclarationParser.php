<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx;

/**
 * Reads the token stream of one C++ or C# file and reports what it declares.
 *
 * It is a tolerant single-pass parser: it tracks brace and paren depth, keeps a
 * namespace/class stack, and recognises the handful of constructs that make a
 * codebase legible —
 *
 *   - namespaces          `namespace A::B {}` (C++), `namespace A.B;` (C#)
 *   - types               class / struct / interface / record / enum / union
 *   - inheritance         `class A : public B, private C` and `class A : B, IFoo`
 *   - members             methods, constructors, fields, properties, events
 *   - free functions      `int main()`, `void render(Scene&)`, `A::B::run()`
 *   - includes / usings   `#include "x.h"`, `using Acme.Services;`
 *   - call sites          `foo(...)`, `obj.Method(...)`, `new Widget(...)`
 *
 * Everything else — template bodies, macro guards, lambda syntax — is skipped
 * by depth tracking. It never throws: an unparsable file yields fewer symbols,
 * never a failed scan.
 */
final class DeclarationParser
{
    private const TYPE_KEYWORDS = ['class', 'struct', 'interface', 'record', 'enum', 'union', 'delegate'];

    /**
     * Words that describe a member rather than its type. They are recorded in
     * the member's own fields (`visibility`, `static`…) and stripped from the
     * type expression, so a reader sees `void Create(...)`, not
     * `public static void Create(...)`.
     */
    private const TYPE_SPECIFIERS = [
        'public', 'private', 'protected', 'internal', 'static', 'virtual', 'override',
        'abstract', 'sealed', 'partial', 'readonly', 'inline', 'explicit', 'friend',
        'final', 'extern', 'mutable', 'volatile', 'async', 'unsafe', 'new', 'export',
        'lateinit', 'required', 'file', 'scoped', 'init', 'data', 'constraint',
        'register', 'thread_local', 'operator',
    ];

    private const MODIFIERS = [
        'public', 'private', 'protected', 'internal', 'static', 'virtual', 'override', 'abstract',
        'sealed', 'partial', 'readonly', 'const', 'constexpr', 'inline', 'explicit', 'friend',
        'final', 'extern', 'mutable', 'volatile', 'async', 'unsafe', 'new', 'ref', 'out', 'in',
        'signed', 'unsigned', 'register', 'thread_local', 'noexcept', 'constinit', 'consteval',
        'typename', 'export', 'lateinit', 'required', 'file', 'scoped', 'atomic', 'init',
    ];

    /** Statements that look like `name(` but are not calls. */
    private const CALL_STOPWORDS = [
        'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'decltype',
        'new', 'delete', 'throw', 'using', 'namespace', 'case', 'do', 'else', 'typeof',
        'nameof', 'sizeof', 'default', 'checked', 'unchecked', 'lock', 'fixed', 'foreach',
        'assert', 'static_assert', 'requires', 'co_await', 'co_return', 'co_yield', 'not',
        'and', 'or', 'when', 'where', 'select', 'yield', 'await', 'stackalloc', 'define',
    ];

    private const CONTROL_KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'foreach', 'lock', 'using', 'fixed'];

    private array $tokens = [];

    private int $count = 0;

    private int $index = 0;

    /** @var array<int, string> namespace segments, outermost first */
    private array $namespaces = [];

    /** Set when the language is C#: it changes member and attribute syntax. */
    private bool $csharp = false;

    public function __construct(private readonly Lexer $lexer = new Lexer) {}

    /**
     * @return array{
     *   namespace: string,
     *   namespaces: array<int, string>,
     *   types: array<int, array>,
     *   functions: array<int, array>,
     *   includes: array<int, array>,
     *   usings: array<int, array>,
     *   using_namespaces: array<int, string>,
     *   calls: array<int, array>
     * }
     */
    public function parse(string $source, bool $csharp = false): array
    {
        $this->csharp = $csharp;
        $this->tokens = $this->lexer->tokenize($source, $csharp);
        $this->count = count($this->tokens);
        $this->index = 0;
        $this->namespaces = [];

        $result = [
            'namespace' => '',
            'namespaces' => [],
            'types' => [],
            'functions' => [],
            'includes' => [],
            'usings' => [],
            'using_namespaces' => [],
            'calls' => [],
            'namespaces_declared' => [],
        ];

        $this->walk($result, '');

        // After the walk the stack is unwound again, so the file's namespace is
        // whatever it declared first (or the last one still on the stack for a
        // file-scoped namespace).
        $result['namespace'] = implode('\\', $this->namespaces) ?: ($result['namespaces_declared'][0] ?? '');
        $result['namespaces'] = $this->namespaces;

        return $result;
    }

    /**
     * The main loop: consume anything that opens a scope, and record what the
     * current scope declares.
     *
     * @param  int  $depth  brace depth this invocation owns (−1 = file scope)
     */
    private function walk(array &$result, string $currentType): void
    {
        $pendingDoc = null;
        $pendingAttributes = [];

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];
            [$kind, $text] = $token;

            if ($kind === 'd') {
                $pendingDoc = $text;
                $this->index++;

                continue;
            }

            if ($kind === 'h') {
                $result['includes'][] = ['path' => $text, 'system' => ! str_contains($text, '.'), 'line' => $token[2]];
                $this->index++;

                continue;
            }

            if ($kind === '#') {
                $this->index++;

                continue;
            }

            if ($kind === 'p') {
                if ($text === '{') {
                    // An unclaimed block: skip it wholesale.
                    $this->skipBlock();

                    continue;
                }

                if ($text === '}') {
                    return;
                }

                if ($text === ';') {
                    $pendingAttributes = [];
                    $pendingDoc = null;
                    $this->index++;

                    continue;
                }

                if ($text === '[' && ($this->csharp || $this->peekText(1) === '[')) {
                    $pendingAttributes = array_merge($pendingAttributes, $this->readAttributes());
                    $pendingDoc = null;

                    continue;
                }

                if ($text === ':') {
                    // C++ access specifier inside a class body.
                    $this->index++;

                    continue;
                }

                $this->index++;

                continue;
            }

            if ($kind !== 'i') {
                $this->index++;

                continue;
            }

            // ---- namespace --------------------------------------------------
            if ($text === 'namespace') {
                $this->readNamespace($result, $currentType);
                $pendingDoc = null;

                continue;
            }

            if ($text === 'using' && $this->csharp) {
                $this->readCSharpUsing($result);
                $pendingDoc = null;

                continue;
            }

            if ($text === 'using' && ! $this->csharp) {
                $this->readCppUsing($result);
                $pendingDoc = null;

                continue;
            }

            if ($text === 'typedef') {
                $this->skipToSemicolon();
                $pendingDoc = null;

                continue;
            }

            // ---- a declaration behind its modifiers ---------------------------
            // `public sealed class Foo` starts with `public`, so the keyword is
            // not the first token. Peek past the modifiers and try again.
            if (! in_array($text, self::TYPE_KEYWORDS, true) && in_array(strtolower($text), self::MODIFIERS, true)) {
                $keyword = $this->typeKeywordAhead();

                if ($keyword !== null) {
                    $this->index += $keyword;
                    $declaration = $this->readType($result, $this->peekText(0), $pendingAttributes, $pendingDoc, $currentType);

                    $pendingDoc = null;
                    $pendingAttributes = [];

                    if ($declaration) {
                        continue;
                    }
                }
            }

            // ---- type declaration -------------------------------------------
            if (in_array($text, self::TYPE_KEYWORDS, true)) {
                $declaration = $this->readType($result, $text, $pendingAttributes, $pendingDoc, $currentType);

                $pendingDoc = null;
                $pendingAttributes = [];

                if ($declaration) {
                    continue;
                }

                continue;
            }

            // ---- template / macro noise -------------------------------------
            if ($text === 'template') {
                $this->skipTemplateHeader();
                $pendingDoc = null;

                continue;
            }

            if (in_array($text, ['#define', '#ifdef', '#ifndef', '#pragma', '#region', '#if', '#else', '#endif'], true)) {
                $this->index++;

                continue;
            }

            // ---- everything else: a member, a function, a variable or a call --
            $this->readStatement($result, $pendingAttributes, $pendingDoc, $currentType);
            $pendingDoc = null;
            $pendingAttributes = [];
        }
    }

    /**
     * `namespace A::B { … }` (C++), `namespace A.B { … }` and the C# 10
     * file-scoped `namespace A.B;` which owns the rest of the file.
     */
    private function readNamespace(array &$result, string $currentType): void
    {
        $this->index++;

        $name = [];

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'i') {
                $name[] = $token[1];
                $this->index++;

                continue;
            }

            // `.` separates C# namespace segments; `::` (two tokens) does the
            // same job in C++.
            if ($token[0] === 'p' && $token[1] === '.' && ! $this->isScopeSeparator(0)) {
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $this->isScopeSeparator(0)) {
                $this->index += 2;

                continue;
            }

            break;
        }

        $qualified = implode('\\', $name);

        if ($qualified === '') {
            return;
        }

        if (! in_array($qualified, $result['namespaces_declared'], true)) {
            $result['namespaces_declared'][] = $qualified;
        }

        $this->namespaces[] = $qualified;

        // The cursor is now on `{`, `;` or something unexpected.
        if ($this->peekText(0) === '{') {
            $this->index++;
            // Everything until the matching brace belongs to this namespace.
            $this->walk($result, $currentType);
            array_pop($this->namespaces);

            if ($this->peekText(0) === '}') {
                $this->index++;
            }

            return;
        }

        if ($this->peekText(0) === ';') {
            // File-scoped namespace: stay inside it for the rest of the file.
            $this->index++;
        }
    }

    /** `using Acme.Services;`, `using Alias = Acme.Thing;`, `using static X;` */
    private function readCSharpUsing(array &$result): void
    {
        $this->index++;
        $line = $this->tokens[$this->index - 1][2] ?? 0;
        $static = false;
        $alias = null;
        $target = [];

        if ($this->peekText(0) === 'static') {
            $static = true;
            $this->index++;
        }

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'i') {
                $target[] = $token[1];
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $token[1] === '.') {
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $token[1] === '=') {
                $alias = implode('.', $target);
                $target = [];
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $token[1] === ';') {
                $this->index++;

                break;
            }

            // anything unexpected ends the directive
            if ($token[0] !== 'p' || $token[1] !== ';') {
                break;
            }
        }

        $qualified = implode('.', $target);

        if ($qualified !== '') {
            $result['usings'][] = ['target' => $qualified, 'alias' => $alias, 'static' => $static, 'line' => $line];

            // An import is not a declaration: `using Acme.Web;` says nothing
            // about the namespaces this file owns, so it goes on its own list.
            if (! in_array($qualified, $result['using_namespaces'], true)) {
                $result['using_namespaces'][] = $qualified;
            }

            $root = explode('.', $qualified)[0];

            if (! in_array($root, $result['using_namespaces'], true)) {
                $result['using_namespaces'][] = $root;
            }
        }
    }

    /** C++ `using namespace X;` and `using X = Y;` */
    private function readCppUsing(array &$result): void
    {
        $this->index++;
        $parts = [];

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'i') {
                $parts[] = $token[1];
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && in_array($token[1], ['::', '.'], true)) {
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $token[1] === ';') {
                $this->index++;
                $joined = implode('\\', $parts);

                if ($parts !== [] && $parts[0] !== 'namespace') {
                    $result['using_namespaces'][] = $joined;
                } elseif (count($parts) > 1 && $parts[0] === 'namespace') {
                    $result['using_namespaces'][] = implode('\\', array_slice($parts, 1));
                }

                break;
            }

            break;
        }
    }

    /**
     * A type declaration: `class Foo : public Bar { … };`
     *
     * @return bool whether a type was recorded
     */
    private function readType(array &$result, string $keyword, array $attributes, ?string $doc, string $currentType): bool
    {
        $line = $this->tokens[$this->index][2];
        $this->index++;

        // `enum class X` / `enum struct X` are scoped enums in C++.
        if ($keyword === 'enum' && in_array($this->peekText(0), ['class', 'struct'], true)) {
            $this->index++;
        }

        // `record class X` / `record struct X`
        if ($keyword === 'record' && in_array($this->peekText(0), ['class', 'struct'], true)) {
            $this->index++;
        }

        if ($this->peekKind(0) !== 'i') {
            return false;
        }

        $name = $this->tokens[$this->index][1];
        $this->index++;

        // Skip generic/template parameter lists: `<T, U>`.
        if ($this->peekText(0) === '<') {
            $this->skipAngles();
        }

        // A C# record or class primary constructor: `record User(string Name);`
        // The parameters are captured rather than skipped: for a record they
        // become the properties the rest of the codebase sees.
        $primaryParameters = null;

        if ($this->peekText(0) === '(') {
            $primaryParameters = $this->captureBalanced('(', ')');
        }

        // ---- base list -------------------------------------------------------
        $bases = [];

        while ($this->index < $this->count) {
            $text = $this->peekText(0);

            if ($text === ':' || ($this->csharp && $text === '=')) {
                $this->index++;
                $bases = $this->readBaseList();

                continue;
            }

            break;
        }

        $qualified = $this->qualify($name);

        $type = [
            'kind' => $this->typeKind($keyword, $bases),
            'name' => $name,
            'qualified' => $qualified,
            'namespace' => implode('\\', $this->namespaces),
            'nested_in' => $currentType !== '' ? $currentType : null,
            'file' => null,
            'line' => $line,
            'end_line' => $line,
            'bases' => $bases,
            'members' => [],
            'attributes' => $attributes,
            'doc' => $doc,
            'is_abstract' => false,
        ];

        if ($this->peekText(0) === ';' && $primaryParameters === null) {
            // Forward declaration — no body, nothing to walk.
            $this->index++;

            return false;
        }

        // A positional record — `public record TaskDto(int Id, string Title);` —
        // has no body braces, but its parameter list *is* its property list, and
        // those properties are what the rest of the codebase sees.
        // `record TaskDto(int Id, string Title);` — the parameter list is the
        // whole declaration, and each parameter is a public property. A record
        // *with* a body falls through to the normal body walk below.
        if ($this->csharp && $keyword === 'record' && $primaryParameters !== null && $this->peekText(0) === ';') {
            foreach ($this->splitParameters($primaryParameters) as $parameter) {
                $property = $this->positionalProperty($parameter, $line);

                if ($property !== null) {
                    $type['members'][] = $property;
                }
            }

            $type['end_line'] = $line;

            if ($this->peekText(0) === ';') {
                $this->index++;
            }

            $result['types'][] = $type;

            return true;
        }

        if ($this->peekText(0) !== '{') {
            return false;
        }

        $this->index++; // consume `{`

        $this->walkTypeBody($result, $type);
        $type['end_line'] = $this->tokens[max(0, $this->index - 1)][2] ?? $line;

        if ($this->peekText(0) === '}') {
            $this->index++;
        }

        if ($this->peekText(0) === ';') {
            $this->index++;
        }

        // Nested types are appended to `$result['types']` by the recursion, so
        // `$type['members']` stays a flat list of methods and fields.
        $result['types'][] = $type;

        return true;
    }

    /** Splits a captured parameter list on top-level commas. */
    private function splitParameters(array $tokens): array
    {
        $groups = [];
        $current = [];
        $depth = 0;

        foreach ($tokens as $token) {
            if ($token[0] === 'p') {
                if (in_array($token[1], ['(', '<', '[', '{'], true)) {
                    $depth++;
                } elseif (in_array($token[1], [')', '>', ']', '}'], true)) {
                    $depth--;
                } elseif ($token[1] === ',' && $depth === 0) {
                    $groups[] = $current;
                    $current = [];

                    continue;
                }
            }

            $current[] = $token;
        }

        if ($current !== []) {
            $groups[] = $current;
        }

        return $groups;
    }

    /**
     * The type expression left after the words that are not part of it:
     * `['public', 'static', 'void']` → `void`.
     *
     * @param  array<int, string>  $words
     */
    private function typeExpression(array $words): ?string
    {
        while ($words !== [] && in_array(strtolower($words[0]), self::TYPE_SPECIFIERS, true)) {
            array_shift($words);
        }

        return $words === [] ? null : implode(' ', $words);
    }

    /** `int Id` / `string Title` → a property member record. */
    private function positionalProperty(array $tokens, int $line): ?array
    {
        $words = [];

        foreach ($tokens as $token) {
            if ($token[0] === 'i') {
                $words[] = $token[1];
            }
        }

        if ($words === []) {
            return null;
        }

        $name = array_pop($words);
        $typeName = $this->typeExpression($words);

        return [
            'kind' => 'property',
            'name' => $name,
            'line' => $line,
            'end_line' => $line,
            'visibility' => 'public',
            'static' => false,
            'abstract' => false,
            'type' => $typeName,
            'attributes' => [],
            'doc' => null,
            'positional' => true,
        ];
    }

    /** Walks the inside of a class body, collecting members and nested types. */
    private function walkTypeBody(array &$result, array &$type): void
    {
        $pendingDoc = null;
        $pendingAttributes = [];
        $visibility = $this->csharp ? 'private' : 'private';
        $depth = 0;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];
            [$kind, $text] = $token;

            if ($kind === 'p') {
                if ($text === '{') {
                    $depth++;
                    $this->index++;

                    continue;
                }

                if ($text === '}') {
                    if ($depth === 0) {
                        return;
                    }

                    $depth--;
                    $this->index++;

                    continue;
                }

                if ($text === ';' && $depth === 0) {
                    $pendingAttributes = [];
                    $this->index++;

                    continue;
                }


                if ($depth === 0 && $text === '[' && $this->csharp) {
                    $pendingAttributes = array_merge($pendingAttributes, $this->readAttributes());

                    continue;
                }

                if ($text === '~') {
                    // A destructor starts with punctuation but is a member.
                    if ($this->readMember($result, $type, $pendingAttributes, $pendingDoc, $visibility) !== null) {
                        $pendingDoc = null;

                        continue;
                    }
                }

                $this->index++;

                continue;
            }

            if ($kind === 'd') {
                $pendingDoc = $text;
                $this->index++;

                continue;
            }

            if ($kind === 'h' || $kind === '#') {
                $this->index++;

                continue;
            }

            if ($kind !== 'i') {
                $this->index++;

                continue;
            }

            // `public:` / `private:` / `protected:` — the label comes first, the
            // colon after it, so it has to be caught before `readMember` sees
            // the word as a member name.
            if (! $this->csharp
                && $this->peekText(1) === ':'
                && ! $this->isScopeSeparator(1)
                && in_array(strtolower($text), ['public', 'private', 'protected'], true)) {
                $visibility = strtolower($text);
                $this->index += 2;
                $pendingAttributes = [];

                continue;
            }

            // A nested type: `class`, `struct`, `enum`, `record` … followed by
            // a name. Anything else (`class Foo* p;`) is a member declaration
            // and is left to `readMember`.
            if (in_array($text, self::TYPE_KEYWORDS, true) && $this->peekKind(1) === 'i') {
                $this->readType($result, $text, $pendingAttributes, null, $type['qualified']);

                continue;
            }

            if ($text === 'template') {
                $this->skipTemplateHeader();

                continue;
            }

            $statementStart = $this->index;
            $member = $this->readMember($result, $type, $pendingAttributes, $pendingDoc, $visibility);

            if ($member !== null) {
                $pendingDoc = null;
                $pendingAttributes = [];

                continue;
            }

            if ($this->index === $statementStart) {
                $this->index++;
            }
        }
    }

    /**
     * The scope chain that precedes a name: for `void A::B::run(` and the
     * cursor on `run`, this returns "A::B::".
     */
    private function qualifierBefore(int $nameToken): string
    {
        $chain = [];
        $cursor = $nameToken - 1;

        // `Mesh::~Mesh()`: the tilde is part of the name, so it must not stop
        // the walk before the qualifier.
        if ($cursor >= 0 && isset($this->tokens[$cursor]) && $this->tokens[$cursor][0] === 'p' && $this->tokens[$cursor][1] === '~') {
            $cursor--;
        }

        while ($cursor >= 2) {
            $isColon = $this->tokens[$cursor][1] === ':' && $this->tokens[$cursor][0] === 'p';
            $isPreviousColon = $this->tokens[$cursor - 1][1] === ':' && $this->tokens[$cursor - 1][0] === 'p';
            $isName = $this->tokens[$cursor - 2][0] === 'i';

            if (! ($isColon && $isPreviousColon && $isName)) {
                break;
            }

            array_unshift($chain, $this->tokens[$cursor - 2][1]);
            $cursor -= 3;
        }

        return $chain === [] ? '' : implode('::', $chain).'::';
    }

    /**
     * Offset of a type keyword that follows the current token, when the run
     * starts with modifiers: `public sealed class Foo` → 2.
     */
    private function typeKeywordAhead(int $limit = 5): ?int
    {
        for ($offset = 1; $offset <= $limit; $offset++) {
            $kind = $this->peekKind($offset);
            $text = $this->peekText($offset);

            if ($kind !== 'i') {
                return null;
            }

            if (in_array($text, self::TYPE_KEYWORDS, true)) {
                return $offset;
            }

            if (! in_array(strtolower($text), self::MODIFIERS, true)) {
                return null;
            }
        }

        return null;
    }

    /** True when the token at $offset starts a `::` pair of colons. */
    private function isScopeSeparator(int $offset): bool
    {
        return $this->peekText($offset) === ':' && $this->peekText($offset + 1) === ':';
    }

    /** Pull an access modifier out of the leading words of a member. */
    private function visibilityFrom(array $words, string $fallback): string
    {
        foreach ($words as $word) {
            $lower = strtolower($word);

            if (in_array($lower, ['public', 'private', 'protected', 'internal'], true)) {
                return $lower;
            }
        }

        return $fallback;
    }

    /**
     * Reads one member declaration — method, property, field or event.
     *
     * The shape is always "tokens … name … ( or ; or =", so the parser collects
     * leading specifiers and type words, then decides from what follows the
     * name whether this is a method, a property or a field.
     */
    private function readMember(array &$result, array &$type, array $attributes, ?string $doc, string $visibility): ?array
    {
        $start = $this->index;
        $line = $this->tokens[$this->index][2];
        $words = [];
        $static = false;
        $abstract = false;
        $operator = false;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];
            [$kind, $text] = $token;

            if ($kind === 'p') {
                if ($text === '(') {
                    // A callable-looking construct: method, ctor, dtor, operator.
                    $name = $words === [] ? null : array_pop($words);

                    if ($name === null) {
                        return null;
                    }

                    // The lexer emits `~` as punctuation, so it never reaches
                    // `$words`: `~Renderer(` arrives as name `Renderer` preceded
                    // by a tilde token, and only that token tells a destructor
                    // from a constructor.
                    $tilde = isset($this->tokens[$this->index - 2])
                        && $this->tokens[$this->index - 2][0] === 'p'
                        && $this->tokens[$this->index - 2][1] === '~';

                    if (str_starts_with($name, '~') || $tilde) {
                        $kindName = 'destructor';
                        $name = '~'.ltrim($name, '~');
                    } elseif ($name === $type['name']) {
                        $kindName = 'constructor';
                    } elseif ($operator) {
                        $kindName = 'operator';
                    } else {
                        $kindName = 'method';
                    }

                    // Everything left in `$words` is the return type plus any
                    // specifiers; the specifiers are dropped when recording.
                    $returnType = $this->typeExpression($words);

                    $parameterTokens = $this->captureBalanced('(', ')');

                    // Skip trailing specifiers up to the body or the semicolon.
                    $endLine = $line;

                    while ($this->index < $this->count) {
                        $next = $this->tokens[$this->index];
                        $endLine = $next[2];

                        if ($next[0] === 'p' && $next[1] === '{') {
                            // The body is where the calls live: capture it so the
                            // call scanner sees them, then drop the tokens.
                            $body = $this->captureBalanced('{', '}');
                            $endLine = $this->tokens[max(0, $this->index - 1)][2] ?? $endLine;

                            $this->scanCalls(
                                array_merge($parameterTokens, $body),
                                $result,
                                $type['qualified'].'::'.$name,
                            );

                            break;
                        }

                        if ($next[0] === 'p' && $next[1] === ';') {
                            $this->index++;

                            break;
                        }

                        if ($next[0] === 'p' && $next[1] === '=') {
                            // `= default;` / `= delete;`
                            while ($this->index < $this->count && ! ($this->tokens[$this->index][0] === 'p' && $this->tokens[$this->index][1] === ';')) {
                                $this->index++;
                            }

                            if ($this->peekText(0) === ';') {
                                $this->index++;
                            }

                            break;
                        }

                        // A C++ constructor initialiser list or trailing attributes.
                        if ($next[0] === 'p' && $next[1] === ':' && $kindName === 'constructor') {
                            $this->skipToBodyOrSemicolon();

                            break;
                        }

                        $this->index++;
                    }

                    $type['members'][] = [
                        'kind' => $kindName,
                        // Destructors keep their tilde here, so the inspector and
                        // the out-of-line merge agree on the name.
                        'name' => $name,
                        'line' => $line,
                        'end_line' => $endLine,
                        'visibility' => $this->visibilityFrom($words, $visibility),
                        'static' => $static,
                        'abstract' => $abstract,
                        'return_type' => $kindName === 'method' ? $returnType : null,
                        'attributes' => $attributes,
                        'doc' => $doc,
                    ];

                    return end($type['members']);
                }

                if ($text === '{') {
                    // A property with a body: `public int Total { get; set; }`
                    $name = $words === [] ? null : array_pop($words);

                    if ($name === null) {
                        return null;
                    }

                    $typeName = array_pop($words);
                    $this->skipBlock();

                    $semicolon = $this->peekText(0) === ';';

                    if ($semicolon) {
                        $this->index++;
                    }

                    $type['members'][] = [
                        'kind' => 'property',
                        'name' => $name,
                        'line' => $line,
                        'end_line' => $line,
                        'visibility' => $visibility,
                        'static' => $static,
                        'type' => $typeName,
                        'attributes' => $attributes,
                        'doc' => $doc,
                    ];

                    return end($type['members']);
                }

                if ($text === ';') {
                    // `int Count;` — a field.
                    $name = $words === [] ? null : array_pop($words);

                    if ($name === null) {
                        return null;
                    }

                    $typeName = $this->typeExpression($words);
                    $this->index++;

                    $type['members'][] = [
                        'kind' => 'field',
                        'name' => $name,
                        'line' => $line,
                        'end_line' => $line,
                        'visibility' => $visibility,
                        'static' => $static,
                        'type' => $typeName,
                        'attributes' => $attributes,
                        'doc' => $doc,
                    ];

                    return end($type['members']);
                }

                if ($text === '=') {
                    $name = $words === [] ? null : array_pop($words);

                    if ($name === null) {
                        return null;
                    }

                    $typeName = $this->typeExpression($words);

                    // `public int Total => Count();` is an expression-bodied member.
                    $this->skipToSemicolon();

                    $type['members'][] = [
                        'kind' => 'property',
                        'name' => $name,
                        'line' => $line,
                        'end_line' => $line,
                        'visibility' => $visibility,
                        'static' => $static,
                        'type' => $typeName,
                        'attributes' => $attributes,
                        'doc' => $doc,
                    ];

                    return end($type['members']);
                }

                if ($text === '<') {
                    // A generic type in a member declaration —
                    // `Task<ActionResult<TaskDto>> Get(…)`, `std::vector<Mesh> meshes_`.
                    // Dropping the arguments keeps the declaration readable and
                    // the type name still lands in the return/field type.
                    $this->skipAngles();

                    continue;
                }

                if ($this->isScopeSeparator(0)) {
                    // `std::string name` — the qualifier belongs to the type.
                    $words[] = '::';
                    $this->index += 2;

                    continue;
                }

                if ($text === '~') {
                    // Destructor: the tilde belongs to the name.
                    $words[] = '~';
                    $this->index++;

                    continue;
                }

                if (in_array($text, [',', '&', '*', '?'], true)) {
                    $words[] = $text;
                    $this->index++;

                    continue;
                }

                if ($text === '[') {
                    // Array declarator or attribute: consume and keep going.
                    if ($this->csharp) {
                        $attributes = array_merge($attributes, $this->readAttributes());

                        continue;
                    }

                    $this->skipBalanced('[', ']');

                    continue;
                }

                if ($text === '}') {
                    return null;
                }

                // `{` handled above; anything else means "not a member" — bail
                // out rather than consuming the rest of the class body.
                return null;
            }

            if ($kind === 'i') {
                $lower = strtolower($text);

                if ($lower === 'static') {
                    $static = true;
                }

                if ($lower === 'abstract' || $lower === 'virtual') {
                    $abstract = true;
                }

                if ($lower === 'operator') {
                    $operator = true;
                }

                $words[] = $text;
                $this->index++;

                // `void Foo() const noexcept { }` — stop collecting after a
                // reasonable number of words to bound pathological input.
                if (count($words) > 12) {
                    return null;
                }

                continue;
            }

            if ($kind === 'c') {
                // Operator overloads use char literals: `operator+`.
                $words[] = trim($text, "'");
                $this->index++;

                continue;
            }

            if ($kind === '#' || $kind === 'h') {
                $this->index++;

                continue;
            }

            if ($kind === 'd') {
                $doc = $text;
                $this->index++;

                continue;
            }

            $this->index++;
        }

        // Nothing conclusive was found; rewind so the caller can recover.
        $this->index = $start;

        return null;
    }

    /** Reads `: base1, public base2, IFoo` after a type name. */
    private function readBaseList(): array
    {
        $bases = [];
        $visibility = null;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];
            [$kind, $text] = $token;

            if ($kind === 'i') {
                if (in_array(strtolower($text), ['public', 'private', 'protected', 'virtual'], true)) {
                    $visibility = strtolower($text);
                    $this->index++;

                    continue;
                }

                $name = $this->readQualifiedName();

                if ($name === '') {
                    break;
                }

                // Template arguments after the base name.
                if ($this->peekText(0) === '<') {
                    $this->skipAngles();
                }

                $bases[] = ['name' => $name, 'visibility' => $visibility];
                $visibility = null;

                continue;
            }

            if ($kind === 'p' && $text === ',') {
                $this->index++;

                continue;
            }

            break;
        }

        return $bases;
    }

    /** `A::B::C`, `A.B.C` or `A<T>` → the dotted segment path. */
    private function readQualifiedName(): string
    {
        $parts = [];

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'i') {
                $parts[] = $token[1];
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && in_array($token[1], ['.', '::'], true)) {
                if ($this->peekText(1) === ':') {
                    // `::` is lexed as two colons.
                    $this->index += 2;

                    continue;
                }

                $this->index++;

                continue;
            }

            break;
        }

        return implode('\\', $parts);
    }

    /**
     * Anything at namespace or class scope that is not a type: free functions,
     * global variables, out-of-line member definitions, and the call sites
     * inside function bodies.
     */
    private function readStatement(array &$result, array $attributes, ?string $doc, string $currentType): void
    {
        // A statement reader must never assume there is a token left: records,
        // expression bodies and unbalanced braces all end up here occasionally,
        // and the parser's contract is that it never throws.
        if ($this->index >= $this->count) {
            return;
        }

        $start = $this->index;
        $line = $this->tokens[$this->index][2];

        // Collect the declaration head: identifiers, qualifiers and symbols.
        $head = [];

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];
            [$kind, $text] = $token;

            if ($kind === 'i') {
                $head[] = $text;
                $this->index++;

                if (count($head) > 16) {
                    break;
                }

                continue;
            }

            if ($kind === 'p' && $this->isScopeSeparator(0)) {
                // Keep the separator so `Foo::bar` stays distinguishable from a
                // plain `bar`.
                $head[] = ':';
                $head[] = ':';
                $this->index += 2;

                continue;
            }

            if ($kind === 'p' && in_array($text, ['.', '~', '<', '>', '*', '&', ',', '?', '['], true)) {
                if ($text === '<') {
                    $this->skipAngles();

                    continue;
                }

                if ($text === '[') {
                    $this->skipBalanced('[', ']');

                    continue;
                }

                $head[] = $text;
                $this->index++;

                continue;
            }

            break;
        }

        if ($head === []) {
            return;
        }

        $text = $this->peekText(0);

        // ---- `name(` → a function definition or a call -----------------------
        if ($text === '(') {
            $nameIndex = $this->lastIdentifierIndex($head);
            $name = $head[$nameIndex] ?? '';

            // The qualifier is read back from the token stream rather than the
            // collected words, so `void Renderer::draw(` yields "Renderer::"
            // instead of gluing the return type onto the class name.
            $qualifier = $this->qualifierBefore($this->index - 1);

            if ($name !== '' && ! in_array(strtolower($name), self::CONTROL_KEYWORDS, true)) {
                // The parameters may themselves contain calls, so scan them.
                $parameterTokens = $this->captureBalanced('(', ')');

                // Trailing member specifiers sit between the parameter list and
                // the body, and they are everywhere in real C++:
                // `void draw() const {`, `void run() noexcept {`, `int f() override;`.
                $this->skipTrailingSpecifiers();

                // What follows decides: `{` or `;` means a definition,
                // anything else means we were actually inside an expression.
                $after = $this->peekText(0);

                /*
                 * Telling a definition from a call.
                 *
                 * `void draw(...)` and `Renderer::draw(...)` are definitions;
                 * `builder.Services.AddControllers();` is not, even though it
                 * ends in a semicolon and looks the same from a distance. Two
                 * rules separate them: a definition has a return type (or a
                 * `::` qualifier) before the name, and it never has a `.` in
                 * the qualification.
                 */
                $wordsBeforeName = $nameIndex;
                $qualifiedByScope = str_contains($qualifier, '::');
                $memberAccess = str_contains(implode('', array_slice($head, 0, max(0, $nameIndex))), '.');

                $looksLikeDefinition = $wordsBeforeName > 0 || $qualifiedByScope;
                $endsDeclaration = in_array($after, ['{', ';'], true)
                    || ($this->csharp && $after === '=')
                    || ($after === ':' && ! $memberAccess);

                $isDefinition = $looksLikeDefinition && $endsDeclaration && ! $memberAccess;

                if ($isDefinition) {
                    $qualified = $qualifier === '' ? $this->qualify($name) : $qualifier.$name;

                    // `Class::method` is a member defined out of line or inside
                    // the class body; otherwise it is a free function.
                    if (str_contains($qualifier, '::') || ($currentType !== '' && $name === $currentType)) {
                        $owner = trim($qualifier, ':\\');
                        $owner = $owner !== '' ? $owner : $currentType;

                        // `Mesh::~Mesh()` — the tilde tells a destructor from a
                        // constructor, and the two are otherwise identical here.
                        $tilde = isset($this->tokens[$this->index - 2])
                            && $this->tokens[$this->index - 2][0] === 'p'
                            && $this->tokens[$this->index - 2][1] === '~';

                        $this->recordOutOfLineMember($result, $owner, $tilde ? '~'.$name : $name, $line, $head);
                    } elseif ($currentType === '') {
                        $result['functions'][] = [
                            'kind' => 'function',
                            'name' => $name,
                            'qualified' => $this->qualify($name),
                            'namespace' => implode('\\', $this->namespaces),
                            'line' => $line,
                            'end_line' => $line,
                            'signature' => implode(' ', array_slice($head, 0, max(0, $nameIndex))),
                            'attributes' => $attributes,
                            'doc' => $doc,
                        ];
                    }

                    // Body or signature tail.
                    $bodyTokens = $this->captureUntilBodyEnd();

                    $this->scanCalls(array_merge($parameterTokens, $bodyTokens), $result, $qualified !== '' ? $qualified : $name);

                    if ($this->peekText(0) === ';') {
                        $this->index++;
                    }

                    return;
                }
            }

            // Not a definition: fall through and treat the head as a statement.
            $this->captureUntilSemicolon();

            // The statement is scanned from its *original* tokens — the same run
            // the parser read, argument list included — rather than from a
            // reassembled copy. That is what keeps `app.MapGet("/api/health", …)`
            // a call with a receiver and a route literal instead of a bare name.
            $this->scanCalls($this->statementSlice($start), $result, $currentType);

            return;
        }

        // A variable or expression: keep any calls found on the line.
        $this->captureUntilSemicolon();
        $this->scanCalls($this->statementSlice($start), $result, $currentType);

        $this->index = max($this->index, $start + 1);
    }

    /** `void render();` inside a class body but defined elsewhere. */
    private function recordOutOfLineMember(array &$result, string $owner, string $name, int $line, array $head): void
    {
        $result['out_of_line'][] = [
            'owner' => $owner,
            'name' => $name,
            'line' => $line,
            'signature' => implode(' ', $head),
        ];
    }

    /**
     * The raw tokens of the statement the parser just walked. Using the source
     * run — rather than tokens collected while classifying it — keeps receiver,
     * arguments and string literals intact.
     *
     * @return array<int, array{0:string,1:string,2:int}>
     */
    private function statementSlice(int $start): array
    {
        $length = max(1, $this->index - $start);

        return array_slice($this->tokens, $start, $length);
    }

    /**
     * Finds `ident(` sequences in a token run and records them as call sites.
     * The references stage decides which of them resolve to a real symbol — an
     * unresolved name simply produces no edge.
     */
    private function scanCalls(array $tokens, array &$result, string $context): void
    {
        $count = count($tokens);

        for ($i = 0; $i < $count - 1; $i++) {
            if ($tokens[$i][0] !== 'i') {
                continue;
            }

            if ($tokens[$i + 1][0] !== 'p' || $tokens[$i + 1][1] !== '(') {
                continue;
            }

            $name = $tokens[$i][1];

            if (in_array(strtolower($name), self::CALL_STOPWORDS, true)) {
                continue;
            }

            // `new Widget(...)` is a construction, not a method call.
            $isNew = $i > 0 && $tokens[$i - 1][0] === 'i' && strtolower($tokens[$i - 1][1]) === 'new';

            // A qualified call `Foo::bar(` / `obj.Method(` keeps its receiver.
            $receiver = null;

            for ($j = $i - 1; $j >= max(0, $i - 3); $j--) {
                if ($tokens[$j][0] === 'p' && in_array($tokens[$j][1], ['::', '.'], true)) {
                    $receiver = $this->lastIdentifierBefore($tokens, $j);
                }
            }

            $line = $tokens[$i][2];
            $fingerprint = strtolower($name).'|'.strtolower((string) $receiver).'|'.$line.'|'.$context;

            // The same statement can be scanned from more than one angle while
            // the parser decides what it is; a call site is recorded once.
            if (isset($result['_call_keys'][$fingerprint])) {
                continue;
            }

            $result['_call_keys'][$fingerprint] = true;

            $result['calls'][] = [
                'name' => $name,
                'receiver' => $receiver,
                'context' => $context,
                'line' => $line,
                'is_new' => $isNew,
                'literal' => $this->firstStringArgument($tokens, $i, $count),
            ];
        }
    }

    /**
     * The first string literal inside a call's argument list.
     *
     * `app.MapGet("/api/tasks", handler)` is a route in a minimal-API project,
     * and the path is the only thing that makes it readable — so the parser
     * keeps it rather than leaving the call as an opaque name.
     */
    private function firstStringArgument(array $tokens, int $openIndex, int $count): ?string
    {
        // `$openIndex` is the *name*; its `(` is at +1 and is skipped, otherwise
        // the first argument would already look nested.
        if (($tokens[$openIndex + 1][1] ?? '') !== '(') {
            return null;
        }

        $depth = 0;

        for ($i = $openIndex + 2; $i < $count && $i < $openIndex + 26; $i++) {
            $token = $tokens[$i];

            if ($token[0] === 'p' && $token[1] === '(') {
                $depth++;
            } elseif ($token[0] === 'p' && $token[1] === ')') {
                if ($depth === 0) {
                    return null;
                }

                $depth--;
            } elseif ($token[0] === 's' && $depth === 0) {
                return trim($token[1], '"$@');
            }
        }

        return null;
    }

    private function lastIdentifierBefore(array $tokens, int $index): ?string
    {
        for ($i = $index - 1; $i >= 0; $i--) {
            if ($tokens[$i][0] === 'i') {
                return $tokens[$i][1];
            }
        }

        return null;
    }

    /**
     * Consumes `const`, `noexcept`, `override`, reference qualifiers and a
     * trailing `-> ReturnType` after a parameter list so the definition check
     * sees the body that actually follows them.
     */
    private function skipTrailingSpecifiers(): void
    {
        for ($guard = 0; $guard < 16; $guard++) {
            $text = $this->peekText(0);

            if (in_array($text, ['const', 'constexpr', 'consteval', 'noexcept', 'override', 'final', 'volatile', 'mutable', 'sealed'], true)) {
                $this->index++;

                continue;
            }

            if ($text === '&') {
                $this->index++;

                if ($this->peekText(0) === '&') {
                    $this->index++;
                }

                continue;
            }

            // C++ trailing return type: `auto draw() -> void {`.
            if ($text === '-' && $this->peekText(1) === '>') {
                $this->index += 2;

                while ($this->index < $this->count && ! in_array($this->peekText(0), ['{', ';', '='], true)) {
                    $this->index++;
                }

                continue;
            }

            return;
        }
    }

    private function lastIdentifierIndex(array $head): int
    {
        for ($i = count($head) - 1; $i >= 0; $i--) {
            if (! in_array($head[$i], [':', '.', '~', '<', '>', '*', '&', ',', '?', '[', ']'], true)) {
                return $i;
            }
        }

        return -1;
    }

    /** @return array<int, array{0:string,1:string,2:int}> */
    private function captureBalanced(string $open, string $close): array
    {
        if ($this->peekText(0) !== $open) {
            return [];
        }

        $captured = [];
        $depth = 0;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'p' && $token[1] === $open) {
                $depth++;
            } elseif ($token[0] === 'p' && $token[1] === $close) {
                $depth--;

                if ($depth === 0) {
                    $this->index++;

                    break;
                }
            }

            if ($depth > 0) {
                $captured[] = $token;
            }

            $this->index++;
        }

        return $captured;
    }

    /** Consumes a signature tail and a body, returning the body's tokens. */
    private function captureUntilBodyEnd(): array
    {
        $captured = [];
        $depth = 0;
        $started = false;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'p' && $token[1] === '{') {
                $depth++;
                $started = true;
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $token[1] === '}') {
                $depth--;

                if ($started && $depth <= 0) {
                    $this->index++;

                    break;
                }
            }

            if ($started) {
                $captured[] = $token;
                $this->index++;

                continue;
            }

            if ($token[0] === 'p' && $token[1] === ';') {
                $this->index++;

                break;
            }

            // Initialiser lists (`: x_(1), y_(2)`) and `=> expression;`.
            $captured[] = $token;
            $this->index++;
        }

        return $captured;
    }

    private function captureUntilSemicolon(): array
    {
        $captured = [];
        $depth = 0;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'p' && in_array($token[1], ['(', '[', '{'], true)) {
                $depth++;
            }

            if ($token[0] === 'p' && in_array($token[1], [')', ']', '}'], true)) {
                $depth--;

                if ($depth < 0) {
                    break;
                }
            }

            if ($token[0] === 'p' && $token[1] === ';' && $depth === 0) {
                $this->index++;

                break;
            }

            $captured[] = $token;
            $this->index++;
        }

        return $captured;
    }

    /** @return array<int, array{0:string,1:string,2:int}> */
    private function headToTokens(array $head, int $line): array
    {
        return array_map(fn (string $text) => ['i', $text, $line], $head);
    }

    private function skipBlock(): void
    {
        if ($this->peekText(0) !== '{') {
            return;
        }

        $depth = 0;

        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'p' && $token[1] === '{') {
                $depth++;
            } elseif ($token[0] === 'p' && $token[1] === '}') {
                $depth--;

                if ($depth === 0) {
                    $this->index++;

                    return;
                }
            }

            $this->index++;
        }
    }

    private function skipBalanced(string $open, string $close): void
    {
        $this->captureBalanced($open, $close);
    }

    private function skipAngles(): void
    {
        if ($this->peekText(0) !== '<') {
            return;
        }

        $depth = 0;

        while ($this->index < $this->count) {
            $text = $this->peekText(0);

            if ($text === '<') {
                $depth++;
            } elseif ($text === '>') {
                $depth--;

                if ($depth === 0) {
                    $this->index++;

                    return;
                }
            } elseif ($text === ';' || $text === '{') {
                // Not a template argument list after all.
                return;
            }

            $this->index++;
        }
    }

    private function skipTemplateHeader(): void
    {
        $this->index++;

        if ($this->peekText(0) === '<') {
            $this->skipAngles();
        }

        // `requires` clauses and `typename` lists.
        while (in_array($this->peekText(0), ['requires', 'typename', 'class'], true)) {
            $word = $this->peekText(0);
            $this->index++;

            if ($word === 'requires' && $this->peekText(0) === '(') {
                $this->skipBalanced('(', ')');
            }
        }
    }

    private function skipToSemicolon(): void
    {
        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'p' && $token[1] === ';') {
                $this->index++;

                return;
            }

            if ($token[0] === 'p' && $token[1] === '{') {
                $this->skipBlock();

                continue;
            }

            $this->index++;
        }
    }

    private function skipToBodyOrSemicolon(): void
    {
        while ($this->index < $this->count) {
            $token = $this->tokens[$this->index];

            if ($token[0] === 'p' && $token[1] === '{') {
                $this->skipBlock();

                return;
            }

            if ($token[0] === 'p' && $token[1] === ';') {
                $this->index++;

                return;
            }

            $this->index++;
        }
    }

    /** Reads `[Attr("x"), Other]` (C#) or `[[attr]]` (C++). */
    private function readAttributes(): array
    {
        $attributes = [];
        $open = $this->peekText(0);

        if ($open !== '[') {
            return [];
        }

        // C++ attributes are doubled: `[[nodiscard]]`.
        $doubled = $this->peekText(1) === '[';

        if ($doubled) {
            $this->skipBalanced('[', ']');
            $this->skipBalanced('[', ']');

            return [];
        }

        $inner = $this->captureBalanced('[', ']');

        $name = null;
        $arguments = [];

        foreach ($inner as $token) {
            if ($token[0] === 'i') {
                if ($name === null) {
                    $name = $token[1];
                } elseif ($name !== null && $token[1] !== $name) {
                    $arguments[] = $token[1];
                }

                continue;
            }

            if ($token[0] === 's') {
                $arguments[] = trim($token[1], '"');
            }

            if ($token[0] === 'p' && $token[1] === ',') {
                break;
            }
        }

        if ($name !== null) {
            $attributes[] = ['name' => $name, 'arguments' => $arguments];
        }

        return $attributes;
    }

    private function qualify(string $name): string
    {
        $namespace = implode('\\', $this->namespaces);

        return $namespace === '' ? $name : $namespace.'\\'.$name;
    }

    private function typeKind(string $keyword, array $bases): string
    {
        return match ($keyword) {
            'struct' => 'struct',
            'interface' => 'interface',
            'record' => 'record',
            'enum' => 'enum',
            'union' => 'union',
            'delegate' => 'delegate',
            default => 'class',
        };
    }

    private function peekText(int $offset): string
    {
        $token = $this->tokens[$this->index + $offset] ?? null;

        return $token[1] ?? '';
    }

    private function peekKind(int $offset): string
    {
        $token = $this->tokens[$this->index + $offset] ?? null;

        return $token[0] ?? '';
    }
}
