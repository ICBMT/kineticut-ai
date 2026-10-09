<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Reads PHP's own configuration in the units humans write it in.
 *
 * `upload_max_filesize` is a string like "2M" or "512K", and a mismatch between
 * it and what a user is trying to upload is the single most common reason an
 * upload "just fails" — so AtlasScope surfaces both numbers in the UI.
 */
class Ini
{
    /**
     * The dev-server defaults from bin/limits.env — the one place the project's
     * natural limit is written down. bin/php sources the same file, so the
     * number the UI advertises is the number the dev server enforces.
     */
    public static function devLimits(): array
    {
        static $limits = null;

        if ($limits !== null) {
            return $limits;
        }

        $limits = [
            'upload_max' => '150M',
            'post_max' => '160M',
            'memory' => '1G',
            'defined' => false,
        ];

        $file = base_path('bin/limits.env');

        if (is_file($file)) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                $line = trim($line);

                if ($line === '' || str_starts_with($line, '#') || ! str_contains($line, '=')) {
                    continue;
                }

                [$key, $value] = array_map('trim', explode('=', $line, 2));

                $slot = match ($key) {
                    'ATLAS_UPLOAD_MAX_DEFAULT' => 'upload_max',
                    'ATLAS_POST_MAX_DEFAULT' => 'post_max',
                    'ATLAS_MEMORY_LIMIT_DEFAULT' => 'memory',
                    default => null,
                };

                if ($slot !== null) {
                    $limits[$slot] = trim($value, "\"'");
                    $limits['defined'] = true;
                }
            }
        }

        return $limits;
    }

    /** Bytes of one key from bin/limits.env, e.g. devBytes('upload_max'). */
    public static function devBytes(string $key): int
    {
        return self::toBytes((string) (self::devLimits()[$key] ?? ''));
    }

    public static function bytes(string $key, int $default = 0): int
    {
        $value = ini_get($key);

        if ($value === false || $value === '') {
            return $default;
        }

        return self::toBytes($value);
    }

    /** Convert a php.ini shorthand value ("8M", "512K", "1G") into bytes. */
    public static function toBytes(string $value): int
    {
        $value = trim($value);

        if ($value === '' || $value === '-1') {
            return -1; // unlimited
        }

        $number = (float) $value;

        return match (strtolower(substr($value, -1))) {
            'g' => (int) ($number * 1024 ** 3),
            'm' => (int) ($number * 1024 ** 2),
            'k' => (int) ($number * 1024),
            default => (int) $number,
        };
    }

    /**
     * Everything the UI needs to know about uploads, read fresh from the
     * process that is actually handling the request.
     *
     * The important part is `constrained_by`: when PHP is the binding limit the
     * user has to change PHP (not us), so we can hand them the exact command
     * instead of a vague "upload failed".
     */
    public static function capacity(): array
    {
        $appMax = (int) config('atlas.max_archive_bytes', self::devBytes('upload_max'));
        $dev = self::devLimits();

        $limits = array_filter([
            self::bytes('upload_max_filesize'),
            self::bytes('post_max_size'),
            $appMax,
        ], fn (int $limit) => $limit > 0);

        $ceiling = $limits === [] ? self::devBytes('upload_max') : min($limits);

        /*
         * Which limit the user has to touch to go bigger. PHP "binds" whenever
         * its limits are at or below the app ceiling — including the tie at the
         * natural 150 MB, where raising one without the other changes nothing.
         */
        $phpBinds = self::bytes('upload_max_filesize') <= $appMax
            || self::bytes('post_max_size') <= $appMax;

        return [
            'max_bytes' => $ceiling,
            'max_human' => self::forHumans($ceiling),
            'app_max_bytes' => $appMax,
            'app_max_human' => self::forHumans($appMax),
            'upload_max_filesize' => (string) (ini_get('upload_max_filesize') ?: '?'),
            'post_max_size' => (string) (ini_get('post_max_size') ?: '?'),
            'memory_limit' => (string) (ini_get('memory_limit') ?: '?'),
            'constrained_by' => $phpBinds ? 'php' : 'app',
            'constrained_by_php' => $phpBinds,
            /*
             * Ready-to-paste ways of lifting it. `php -d … artisan serve` is
             * deliberately not listed: artisan serve spawns a *child* php -S
             * process and the -d flags die with the parent, so it looks right
             * and silently does nothing. bin/serve passes PHP_BINARY instead.
             */
            'raise_command' => 'composer serve',
            'raise_env' => 'ATLAS_UPLOAD_MAX=1G composer serve',
            'raise_ini' => "upload_max_filesize = {$dev['upload_max']}\npost_max_size = {$dev['post_max']}",
            'raise_note' => 'On php-fpm/Apache, raise upload_max_filesize and post_max_size in php.ini and restart PHP.',
            // What `composer serve` gives you, straight from bin/limits.env.
            'dev_upload_max' => $dev['upload_max'],
            'dev_upload_max_human' => self::forHumans(self::toBytes($dev['upload_max'])),
            'dev_post_max' => $dev['post_max'],
            'natural_max_bytes' => self::devBytes('upload_max'),
            'natural_max_human' => self::forHumans(self::devBytes('upload_max')),
        ];
    }

    /**
     * The largest archive this server will actually accept: PHP's own limits
     * and AtlasScope's configured ceiling, whichever is smaller.
     */
    public static function uploadCeiling(): int
    {
        return (int) self::capacity()['max_bytes'];
    }

    public static function forHumans(int $bytes): string
    {
        if ($bytes < 0) {
            return 'unlimited';
        }

        if ($bytes >= 1024 ** 3) {
            return round($bytes / 1024 ** 3, 1).' GB';
        }

        if ($bytes >= 1024 ** 2) {
            return round($bytes / 1024 ** 2, 1).' MB';
        }

        return round($bytes / 1024).' KB';
    }
}
