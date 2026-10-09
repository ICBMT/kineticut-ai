<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx;

/**
 * A tolerant lexer for C-family source (C++ and C#).
 *
 * It is not a compiler front end and does not try to be: it runs one pass over
 * a file and emits flat tokens — identifiers, punctuation, literals, includes,
 * usings and doc comments — which the declaration parser then reads. Anything
 * it does not understand (a macro body, an unfamiliar literal prefix) is
 * consumed as a token rather than throwing, because a scanner that dies on one
 * strange file is worse than a scanner that ignores it.
 *
 * Tokens are emitted as `[kind, text, line]`:
 *   i = identifier/keyword   p = punctuation   n = number
 *   s = string literal       c = char literal
 *   h = #include target      d = doc comment   u = using directive
 *   # = any other preprocessor directive (kept so the parser can skip it)
 */
final class Lexer
{
    /** Written to before every file so a fresh lexer is never needed. */
    private array $tokens = [];

    private int $length = 0;

    private int $position = 0;

    private int $line = 1;

    private string $source = '';

    /** @return array<int, array{0:string,1:string,2:int}> */
    public function tokenize(string $source, bool $csharp = false): array
    {
        $this->source = $source;
        $this->tokens = [];
        $this->length = strlen($source);
        $this->position = 0;
        $this->line = 1;

        // A UTF-8 BOM would otherwise become part of the first identifier.
        if (str_starts_with($source, "\xEF\xBB\xBF")) {
            $this->position = 3;
        }

        while ($this->position < $this->length) {
            $char = $source[$this->position];

            if ($char === "\n") {
                $this->line++;
                $this->position++;

                continue;
            }

            if ($char === ' ' || $char === "\t" || $char === "\r" || $char === "\v" || $char === "\f") {
                $this->position++;

                continue;
            }

            if ($char === '/' && $this->peek(1) === '/') {
                $this->consumeLineComment($source);

                continue;
            }

            if ($char === '/' && $this->peek(1) === '*') {
                $this->consumeBlockComment($source);

                continue;
            }

            if ($char === '"') {
                $this->consumeString($source, $csharp, '');

                continue;
            }

            if ($char === '@' && $csharp) {
                // @"verbatim" and @"$interpolated" forms.
                $next = $this->peek(1);
                $after = $this->peek(2);

                if ($next === '"') {
                    $this->position++;
                    $this->consumeString($source, true, '@');

                    continue;
                }

                if (($next === '$' && $after === '"')) {
                    $this->position += 2;
                    $this->consumeString($source, true, '@$');

                    continue;
                }
            }

            if ($char === '$' && $csharp && $this->peek(1) === '"') {
                $this->position++;
                $this->consumeString($source, true, '$');

                continue;
            }

            if ($char === '$' && $csharp && $this->peek(1) === '@' && $this->peek(2) === '"') {
                $this->position += 2;
                $this->consumeString($source, true, '$@');

                continue;
            }

            // C++ raw string: R"delim( ... )delim"
            if (($char === 'R') && $this->peek(1) === '"' && ! $csharp) {
                $this->consumeRawString($source);

                continue;
            }

            if ($char === "'") {
                $this->consumeCharLiteral($source);

                continue;
            }

            if ($char === '#' && $this->atLineStart($source)) {
                $this->consumeDirective($source, $csharp);

                continue;
            }

            if ($this->isIdentifierStart($char)) {
                $this->consumeIdentifier($source);

                continue;
            }

            if (ctype_digit($char) || ($char === '.' && ctype_digit((string) $this->peek(1)))) {
                $this->consumeNumber($source);

                continue;
            }

            $this->tokens[] = ['p', $char, $this->line];
            $this->position++;
        }

        return $this->tokens;
    }

    private function consumeLineComment(string $source): void
    {
        $start = $this->position;
        $end = strpos($source, "\n", $start);
        $end = $end === false ? $this->length : $end;
        $text = substr($source, $start, $end - $start);

        // `///` is a documentation comment in both languages.
        if (str_starts_with($text, '///') && ! str_starts_with($text, '////')) {
            $this->tokens[] = ['d', trim(substr($text, 3)), $this->line];
        }

        $this->position = $end;
    }

    private function consumeBlockComment(string $source): void
    {
        $start = $this->position;
        $end = strpos($source, '*/', $start + 2);
        $end = $end === false ? $this->length : $end + 2;
        $text = substr($source, $start, $end - $start);

        $this->line += substr_count($text, "\n");

        // `/** ... */` is a doc comment; `/* ... */` is ordinary noise.
        if (str_starts_with($text, '/**') && ! str_starts_with($text, '/***')) {
            $clean = preg_replace('/^\/\*\*|\*\/$/', '', $text) ?? $text;
            $lines = preg_split('/\R/ms', $clean) ?: [];
            $summary = [];

            foreach ($lines as $line) {
                $line = trim(preg_replace('/^\s*\*\s?/', '', $line) ?? '');

                if ($line !== '' && ! str_starts_with($line, '@') && ! str_starts_with($line, '<')) {
                    $summary[] = $line;
                }

                if (count($summary) >= 3) {
                    break;
                }
            }

            if ($summary !== []) {
                $this->tokens[] = ['d', implode(' ', $summary), $this->line];
            }
        }

        $this->position = $end;
    }

    private function consumeString(string $source, bool $csharp, string $prefix): void
    {
        $line = $this->line;
        $start = $this->position;
        $this->position++; // opening quote
        $escaped = ! ($csharp && str_contains($prefix, '@'));

        while ($this->position < $this->length) {
            $char = $source[$this->position];

            if ($char === "\n") {
                $this->line++;

                // A single-quoted string never spans a line: stop here rather
                // than swallowing the rest of the file.
                if ($escaped) {
                    break;
                }
            }

            if ($escaped && $char === '\\') {
                $this->position += 2;

                continue;
            }

            if ($char === '"') {
                // Verbatim strings escape a quote by doubling it.
                if (! $escaped && $this->peek(1) === '"') {
                    $this->position += 2;

                    continue;
                }

                $this->position++;

                break;
            }

            $this->position++;
        }

        $this->tokens[] = ['s', substr($source, $start, $this->position - $start), $line];
    }

    private function consumeRawString(string $source): void
    {
        $line = $this->line;
        $start = $this->position;
        $delimiterEnd = strpos($source, '(', $start + 2);

        if ($delimiterEnd === false) {
            // Not a raw string after all — treat the R as an identifier.
            $this->tokens[] = ['i', 'R', $this->line];
            $this->position++;

            return;
        }

        $delimiter = substr($source, $start + 2, $delimiterEnd - $start - 2);
        $closing = ')'.$delimiter.'"';
        $end = strpos($source, $closing, $delimiterEnd);

        $end = $end === false ? $this->length : $end + strlen($closing);
        $text = substr($source, $start, $end - $start);

        $this->line += substr_count($text, "\n");
        $this->position = $end;
        $this->tokens[] = ['s', $text, $line];
    }

    private function consumeCharLiteral(string $source): void
    {
        $line = $this->line;
        $start = $this->position;
        $this->position++;

        while ($this->position < $this->length) {
            $char = $source[$this->position];

            if ($char === '\\') {
                $this->position += 2;

                continue;
            }

            if ($char === "'" || $char === "\n") {
                $this->position++;

                break;
            }

            $this->position++;
        }

        $this->tokens[] = ['c', substr($source, $start, $this->position - $start), $line];
    }

    /**
     * A preprocessor line. `#include` becomes a first-class token because it is
     * the single most valuable edge in a C or C++ graph; everything else is
     * recorded as a directive so the parser can skip it in one step.
     */
    private function consumeDirective(string $source, bool $csharp): void
    {
        $start = $this->position;
        $end = strpos($source, "\n", $start);

        while ($end !== false && str_ends_with(rtrim(substr($source, $start, $end - $start)), '\\')) {
            $end = strpos($source, "\n", $end + 1);
        }

        $end = $end === false ? $this->length : $end;
        $raw = substr($source, $start, $end - $start);
        $line = $this->line;
        $this->line += substr_count($raw, "\n");
        $this->position = $end;

        if (preg_match('/^#\s*include\s+([<"][^>"]+[>"])/', $raw, $matches)) {
            $this->tokens[] = ['h', trim($matches[1], '<>"'), $line];

            return;
        }

        $this->tokens[] = ['#', strtok($raw, " \t") ?: '#', $line];
    }

    private function consumeIdentifier(string $source): void
    {
        $start = $this->position;

        while ($this->position < $this->length && $this->isIdentifierPart($source[$this->position])) {
            $this->position++;
        }

        $this->tokens[] = ['i', substr($source, $start, $this->position - $start), $this->line];
    }

    private function consumeNumber(string $source): void
    {
        $start = $this->position;

        while ($this->position < $this->length) {
            $char = $source[$this->position];

            // Digit separators (1'000'000) and exponent/suffix characters all
            // belong to the literal.
            if (ctype_alnum($char) || in_array($char, ['.', "'", '_', '+', '-'], true)) {
                if (($char === '+' || $char === '-') && ! in_array($source[$this->position - 1] ?? '', ['e', 'E'], true)) {
                    break;
                }

                $this->position++;

                continue;
            }

            break;
        }

        $this->tokens[] = ['n', substr($source, $start, $this->position - $start), $this->line];
    }

    private function peek(int $offset): string
    {
        return $this->source[$this->position + $offset] ?? '';
    }

    private function atLineStart(string $source): bool
    {
        for ($i = $this->position - 1; $i >= 0; $i--) {
            $char = $source[$i];

            if ($char === "\n") {
                return true;
            }

            if ($char !== ' ' && $char !== "\t" && $char !== "\r") {
                return false;
            }
        }

        return true;
    }

    private function isIdentifierStart(string $char): bool
    {
        return ctype_alpha($char) || $char === '_' || ord($char) > 127;
    }

    private function isIdentifierPart(string $char): bool
    {
        return ctype_alnum($char) || $char === '_' || ord($char) > 127;
    }
}
