<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Filesystem helpers that refuse to leave the sandbox.
 */
class Path
{
    /** Directory names we never descend into when scanning a Laravel project. */
    public const SKIP_DIRS = [
        'vendor', 'node_modules', '.git', '.svn', '.hg', 'storage', '.idea', '.vscode',
        '.atlas', 'bower_components', '.next', '.nuxt', '.cache', '.github', 'dist',
        'coverage', '.phpunit.cache', '.phpunit.result.cache', '.ddev', '.vagrant',
        '__pycache__', '.sass-cache', 'build',
    ];

    /** Path fragments that are safe to descend into even though their name is skipped. */
    public const KEEP_IF_UNDER = [
        'app/', 'routes/', 'database/', 'resources/', 'config/', 'tests/', 'public/',
        'bootstrap/', 'lang/', 'packages/', 'src/', 'modules/', 'domain/',
    ];

    public static function join(string ...$parts): string
    {
        $out = array_shift($parts) ?? '';

        foreach ($parts as $part) {
            $out = rtrim($out, '/').'/'.ltrim($part, '/');
        }

        return $out;
    }

    /** Normalise a relative path to forward slashes and strip leading ./ */
    public static function normalize(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $path = preg_replace('#^\./#', '', $path) ?? $path;

        return trim($path);
    }

    /** True when $path is inside $root (or equal to it). */
    public static function isInside(string $path, string $root): bool
    {
        $path = rtrim(str_replace('\\', '/', $path), '/');
        $root = rtrim(str_replace('\\', '/', $root), '/');

        if (str_contains($path, '..'.DIRECTORY_SEPARATOR) || str_contains($path, '../')) {
            return false;
        }

        return $path === $root || str_starts_with($path, $root.'/');
    }

    public static function shouldSkipDirectory(string $relative, string $name): bool
    {
        if (str_starts_with($name, '.') && ! in_array($name, ['.env.example'], true)) {
            // Hidden folders are skipped unless they hold app code we look for.
            if (! in_array($name, ['.', '..'], true)) {
                return true;
            }
        }

        if (! in_array($name, self::SKIP_DIRS, true)) {
            return false;
        }

        foreach (self::KEEP_IF_UNDER as $keep) {
            if (str_starts_with($relative.'/', $keep) && ! str_starts_with($relative.'/', 'storage/')) {
                return false;
            }
        }

        return true;
    }

    public static function ensureDirectory(string $path): string
    {
        if (! is_dir($path)) {
            mkdir($path, 0o775, true);
        }

        return $path;
    }

    public static function deleteDirectory(string $path): void
    {
        if (! is_dir($path)) {
            return;
        }

        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($items as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }

        @rmdir($path);
    }

    public static function humanBytes(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB'];
        $power = $bytes > 0 ? (int) min(floor(log($bytes, 1024)), 3) : 0;

        return round($bytes / (1024 ** $power), $power > 1 ? 1 : 0).' '.$units[$power];
    }

    /**
     * Extract a zip archive with zip-slip protection and a hard size ceiling.
     *
     * @return array{root:string,entries:int,bytes:int}
     */
    /**
     * @param  int  $maxBytes  Ceiling for the total *uncompressed* size of the
     *                         archive's contents — a zip-bomb guard, not a
     *                         limit on the archive itself.
     */
    public static function extractZip(string $archive, string $destination, int $maxBytes = 2_147_483_648): array
    {
        $zip = new \ZipArchive;

        if ($zip->open($archive) !== true) {
            throw new \RuntimeException('The uploaded archive could not be opened. Is it a valid .zip file?');
        }

        if (! is_dir($destination)) {
            mkdir($destination, 0o775, true);
        }

        $realDestination = realpath($destination) ?: $destination;
        $entries = 0;
        $bytes = 0;

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            $name = $stat['name'] ?? '';

            if ($name === '' || str_ends_with($name, '/')) {
                continue;
            }

            // Reject absolute paths and traversal attempts outright.
            $clean = str_replace('\\', '/', $name);
            if (str_starts_with($clean, '/') || preg_match('#(^|/)\.\.(/|$)#', $clean)) {
                continue;
            }

            $bytes += (int) ($stat['size'] ?? 0);
            if ($bytes > $maxBytes) {
                $zip->close();

                throw new \RuntimeException(
                    'That archive expands to more than '.self::humanBytes($maxBytes).' of source, which is past '.
                    'what AtlasScope will unpack. Zip the project without vendor/ and node_modules/ and try again.'
                );
            }

            $target = $realDestination.'/'.$clean;

            if (! self::isInside(dirname($target), $realDestination) && ! self::isInside($target, $realDestination)) {
                continue;
            }

            self::ensureDirectory(dirname($target));

            $stream = $zip->getStream($name);
            if ($stream === false) {
                continue;
            }

            $out = @fopen($target, 'wb');
            if ($out !== false) {
                stream_copy_to_stream($stream, $out);
                fclose($out);
                $entries++;
            }

            fclose($stream);
        }

        $zip->close();

        if ($entries === 0) {
            throw new \RuntimeException('The archive did not contain any readable files.');
        }

        return ['root' => $realDestination, 'entries' => $entries, 'bytes' => $bytes];
    }

    /**
     * GitHub/GitLab zips wrap everything in a single top-level folder — find it.
     */
    public static function detectProjectRoot(string $directory): string
    {
        $markers = ['artisan', 'composer.json', 'bootstrap/app.php', 'src/composer.json'];

        $hasMarker = function (string $dir) use ($markers): bool {
            foreach ($markers as $marker) {
                if (file_exists(self::join($dir, $marker))) {
                    return true;
                }
            }

            return false;
        };

        if ($hasMarker($directory)) {
            return $directory;
        }

        $children = array_values(array_filter(
            scandir($directory) ?: [],
            fn (string $entry) => ! in_array($entry, ['.', '..'], true)
                && is_dir(self::join($directory, $entry))
                && ! str_starts_with($entry, '__MACOSX')
        ));

        if (count($children) === 1) {
            $candidate = self::join($directory, $children[0]);
            if ($hasMarker($candidate)) {
                return $candidate;
            }

            // One level deeper (e.g. project-1.0/app)
            foreach (scandir($candidate) ?: [] as $entry) {
                if (in_array($entry, ['.', '..'], true)) {
                    continue;
                }
                if ($hasMarker(self::join($candidate, $entry))) {
                    return self::join($candidate, $entry);
                }
            }
        }

        return $directory;
    }

    /** Quick recursive size + file count that honours our skip list. */
    public static function measure(string $root): array
    {
        $files = 0;
        $bytes = 0;

        $walk = function (string $dir, string $relative = '') use (&$walk, &$files, &$bytes): void {
            $entries = @scandir($dir) ?: [];

            foreach ($entries as $entry) {
                if (in_array($entry, ['.', '..'], true)) {
                    continue;
                }

                $path = $dir.'/'.$entry;
                $rel = $relative === '' ? $entry : $relative.'/'.$entry;

                if (is_dir($path)) {
                    if (self::shouldSkipDirectory($rel, $entry)) {
                        continue;
                    }
                    $walk($path, $rel);

                    continue;
                }

                $files++;
                $bytes += (int) (@filesize($path) ?: 0);
            }
        };

        $walk($root);

        return ['files' => $files, 'bytes' => $bytes];
    }
}
