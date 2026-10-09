<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx;

use App\Enums\Language;

/**
 * One place for the naming rules the C-family stages share.
 *
 * C++ and C# namespaces are both stored with a backslash separator internally —
 * that keeps keys stable and identical in shape to the Laravel ones
 * (`class:App\Models\User`) — while the UI shows C# with dots, which is how a
 * .NET developer writes them.
 */
class Naming
{
    public static function fqn(string $namespace, string $name): string
    {
        return $namespace === '' ? $name : $namespace.'\\'.$name;
    }

    /** How a namespace or type is printed for a human. */
    public static function display(string $fqn, Language $language): string
    {
        return $language === Language::CSharp ? str_replace('\\', '.', $fqn) : $fqn;
    }

    /** The last segment: `acme\render\Renderer` → `Renderer`. */
    public static function base(string $fqn): string
    {
        $parts = explode('\\', trim($fqn, '\\'));

        return (string) end($parts);
    }

    /** Strip template arguments and leading keywords from a base-class entry. */
    public static function cleanBase(string $base): string
    {
        $base = trim($base);

        if (($position = strpos($base, '<')) !== false) {
            $base = substr($base, 0, $position);
        }

        $words = preg_split('/\s+/', $base) ?: [];
        $words = array_values(array_filter($words, fn (string $word) => ! in_array(strtolower($word), [
            'public', 'private', 'protected', 'virtual', 'struct', 'class', 'typename', 'const',
        ], true)));

        return trim((string) end($words), '\\');
    }

    /**
     * Does `$reference` (as written in the source) name `$known` (a fully
     * qualified symbol we have seen)? C++ resolves by namespace lookup, so a
     * suffix match on whole segments is the honest approximation.
     */
    public static function refersTo(string $reference, string $known): bool
    {
        $reference = trim($reference, '\\');
        $known = trim($known, '\\');

        if ($reference === '' || $known === '') {
            return false;
        }

        if (strcasecmp($reference, $known) === 0) {
            return true;
        }

        foreach (['\\', '.', '::'] as $separator) {
            if (str_ends_with(strtolower($known), strtolower($separator.$reference))) {
                return true;
            }
        }

        return false;
    }

    /** `Acme.Web.Controllers` → `Web` — the module a namespace groups under. */
    public static function namespaceModule(string $namespace): string
    {
        $parts = preg_split('/[\\\\\.]/', trim($namespace, '\\')) ?: [];

        if (count($parts) >= 2 && self::looksLikeCompanyPrefix($parts[0])) {
            return $parts[1];
        }

        return $parts[0] ?? 'Core';
    }

    private static function looksLikeCompanyPrefix(string $segment): bool
    {
        return $segment !== '' && strtolower($segment) !== $segment;
    }

    /** The directory key a file belongs under, used for hierarchy edges. */
    public static function directoryKey(string $file): ?string
    {
        $directory = dirname($file);

        return $directory === '.' || $directory === '' ? null : 'dir:'.$directory;
    }
}
