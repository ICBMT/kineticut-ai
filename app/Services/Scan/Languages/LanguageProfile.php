<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages;

use App\Enums\Language;
use App\Enums\ScanStage;

/**
 * Everything a scan needs to know about *one* kind of codebase.
 *
 * A profile answers three questions and nothing else: does this directory look
 * like my language, which stages do I need, and how do I turn a file path into
 * a module name. The graph, the layouts, the focus engine and the insights are
 * shared by every language — that is the whole point of keeping the profile
 * this small.
 */
abstract class LanguageProfile
{
    abstract public function language(): Language;

    /**
     * Confidence that a directory holds this kind of project, 0–100.
     * The registry picks the highest score, so signals are additive: a stub
     * header file is worth a few points, a CMakeLists.txt is worth a lot.
     */
    abstract public function detect(string $root): int;

    /** @return array<ScanStage> ordered stages, excluding the shared Extract stage */
    abstract public function plan(): array;

    /** The module a file belongs to, before namespaces refine it. */
    abstract public function moduleFor(string $relativePath): string;

    /** Directory names this language should never descend into. */
    public function skipDirectories(): array
    {
        return [];
    }

    /** Extensions the file index should count lines for, beyond the shared list. */
    public function extraSourceExtensions(): array
    {
        return [];
    }

    /** Language label used by the file index, e.g. "csharp" for a .cs file. */
    public function fileLanguage(string $path): ?string
    {
        return null;
    }

    /** Strip the container folders every project of this language has. */
    protected function stripContainers(string $path, array $containers): string
    {
        $segments = array_values(array_filter(explode('/', str_replace('\\', '/', $path))));

        while ($segments !== [] && in_array(strtolower($segments[0]), $containers, true)) {
            array_shift($segments);
        }

        return implode('/', $segments);
    }

    /** Count files matching a suffix, cheaply, up to a cap. */
    protected function countFiles(string $root, array $suffixes, int $cap = 40): int
    {
        $found = 0;

        $walk = function (string $dir, int $depth) use (&$walk, &$found, $suffixes, $cap): void {
            if ($found >= $cap || $depth > 4) {
                return;
            }

            foreach (@scandir($dir) ?: [] as $entry) {
                if ($found >= $cap || $entry === '.' || $entry === '..' || $entry[0] === '.') {
                    continue;
                }

                $path = $dir.'/'.$entry;

                if (is_dir($path)) {
                    if (in_array($entry, ['node_modules', 'vendor', '.git', 'build', 'dist', 'bin', 'obj'], true)) {
                        continue;
                    }

                    $walk($path, $depth + 1);

                    continue;
                }

                foreach ($suffixes as $suffix) {
                    if (str_ends_with(strtolower($entry), $suffix)) {
                        $found++;

                        break;
                    }
                }
            }
        };

        $walk($root, 0);

        return $found;
    }

    protected function has(string $root, string ...$names): bool
    {
        foreach ($names as $name) {
            if (str_contains($name, '*')) {
                $matches = glob($root.'/'.$name);

                if ($matches !== false && $matches !== []) {
                    return true;
                }

                continue;
            }

            if (file_exists($root.'/'.$name)) {
                return true;
            }
        }

        return false;
    }
}
