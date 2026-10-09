<?php

declare(strict_types=1);

namespace App\Services;

use App\Support\Path;
use Illuminate\Support\Facades\File;

/**
 * Ships a realistic Laravel application inside AtlasScope so a brand new user
 * can see the whole experience — a full route table, Eloquent relationships,
 * queued jobs, events, policies, migrations and Blade views — without having to
 * find an archive first.
 *
 * The sources live in `resources/demo/taskflow` and are copied into the
 * project's private workspace on demand.
 */
class DemoProjectBuilder
{
    public function sourcePath(): string
    {
        return resource_path('demo/taskflow');
    }

    /** Copy the bundled sample into `storage/app/atlas/{uuid}/source`. */
    public function materialize(string $uuid): string
    {
        $source = $this->sourcePath();

        if (! is_dir($source)) {
            throw new \RuntimeException('The bundled demo project is missing from resources/demo/taskflow.');
        }

        $target = storage_path('app/atlas/'.$uuid.'/source');
        Path::ensureDirectory($target);
        File::copyDirectory($source, $target);

        return $target;
    }

    public function exists(): bool
    {
        return is_dir($this->sourcePath());
    }

    /** Approximate file count, used on the welcome screen. */
    public function fileCount(): int
    {
        if (! $this->exists()) {
            return 0;
        }

        return count(File::allFiles($this->sourcePath()));
    }
}
