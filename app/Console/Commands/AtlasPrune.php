<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Project;
use App\Support\Path;
use Illuminate\Console\Command;

/**
 * Delete project workspaces that no longer belong to anything.
 *
 * A scan that dies part-way, or a project row removed by hand, can leave a
 * directory under `storage/app/atlas` with no project behind it — invisible in
 * the interface, but they add up. Deleting a project properly already removes
 * its workspace (see ProjectManager::destroy); this is the broom for the ones
 * that got away.
 *
 *      php artisan atlas:prune
 *      php artisan atlas:prune --dry-run
 *      php artisan atlas:prune --uploads=24     # discard chunks older than 24h
 */
class AtlasPrune extends Command
{
    protected $signature = 'atlas:prune
                    {--dry-run : List what would be removed without removing it}
                    {--force : Remove without the confirmation prompt, and without the empty-database guard}
                    {--uploads=48 : Age in hours after which abandoned upload chunks are discarded}';

    protected $description = 'Remove project workspaces and upload chunks that no longer belong to a project';

    public function handle(): int
    {
        $base = storage_path('app/atlas');
        $live = Project::pluck('uuid')->flip();
        $dry = (bool) $this->option('dry-run');
        $force = (bool) $this->option('force');

        $candidates = [];

        foreach (glob($base.'/*', GLOB_ONLYDIR) ?: [] as $directory) {
            $name = basename($directory);

            if ($name !== '_uploads' && ! isset($live[$name])) {
                $candidates[$directory] = $this->countFiles($directory);
            }
        }

        /*
         * The guard that matters. If the database is empty, *every* workspace
         * looks orphaned — and running this against a fresh database with an
         * old storage directory would delete projects that are perfectly fine,
         * just not recorded yet. A wrongly-scoped prune once did exactly that
         * here, so the command now refuses rather than being clever.
         */
        if ($candidates !== [] && Project::count() === 0 && ! $force) {
            $this->error(sprintf(
                'Refusing to prune: %d workspace%s on disk, but the database has no projects at all.',
                count($candidates),
                count($candidates) === 1 ? '' : 's',
            ));
            $this->line('  Every workspace would look orphaned. If the database really is the one you want,');
            $this->line('  re-run with --force.');

            return self::FAILURE;
        }

        if (! $dry && $candidates !== [] && ! $force
            && ! $this->confirm(sprintf('Delete %d orphaned workspace%s?', count($candidates), count($candidates) === 1 ? '' : 's'))) {
            $this->info('Nothing removed.');

            return self::SUCCESS;
        }

        $workspaces = 0;
        $files = 0;

        foreach ($candidates as $directory => $count) {
            $files += $count;
            $workspaces++;

            if ($dry) {
                $this->line('  would remove workspace '.basename($directory));
            } else {
                $this->line('  removing '.basename($directory));
                Path::deleteDirectory($directory);
            }
        }

        $chunks = $this->pruneUploads($base.'/_uploads', (int) $this->option('uploads'), $dry);
        $this->info(sprintf(
            '%s %d orphaned workspace%s (%d files) and %d abandoned upload chunk folder%s.',
            $dry ? 'Would remove' : 'Removed',
            $workspaces,
            $workspaces === 1 ? '' : 's',
            $files,
            $chunks,
            $chunks === 1 ? '' : 's',
        ));

        return self::SUCCESS;
    }

    /** Abandoned chunked uploads: a browser that closed mid-upload. */
    private function pruneUploads(string $path, int $hours, bool $dry): int
    {
        if (! is_dir($path)) {
            return 0;
        }

        $cutoff = now()->subHours(max(1, $hours))->getTimestamp();
        $removed = 0;

        foreach (glob($path.'/*', GLOB_ONLYDIR) ?: [] as $directory) {
            if (filemtime($directory) > $cutoff) {
                continue;
            }

            $removed++;

            if ($dry) {
                $this->line('  would remove upload chunks '.basename($directory));
            } else {
                Path::deleteDirectory($directory);
            }
        }

        return $removed;
    }

    private function countFiles(string $directory): int
    {
        $count = 0;

        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS)) as $file) {
            $count++;
        }

        return $count;
    }
}
