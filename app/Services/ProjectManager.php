<?php

declare(strict_types=1);

namespace App\Services;

use App\Enums\ScanStatus;
use App\Jobs\RunScan;
use App\Models\Project;
use App\Models\Scan;
use App\Support\Path;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;

/**
 * Everything that creates, seeds or destroys a project on disk.
 *
 * Uploads are always unpacked into `storage/app/atlas/{uuid}/source`, never
 * executed, and every extracted path is validated against traversal.
 */
class ProjectManager
{
    public function __construct(private readonly DemoProjectBuilder $demo) {}

    /** Store an uploaded .zip archive and kick off the first scan. */
    public function storeUpload(UploadedFile $file, ?string $name = null): Project
    {
        $uuid = (string) Str::uuid();
        $target = storage_path('app/atlas/'.$uuid);
        Path::ensureDirectory($target);

        $archivePath = $target.'/upload.zip';
        $file->move($target, 'upload.zip');

        return $this->adoptArchive($archivePath, $file->getClientOriginalName(), $name, $uuid, $target);
    }

    /**
     * Turn an archive that is already on disk into a scanned project.
     *
     * Shared by the normal multipart upload and the chunked uploader, which
     * assembles its pieces first and then arrives here — one code path for
     * unpacking, sandboxing, measuring and queueing the scan.
     */
    public function adoptArchive(
        string $archivePath,
        string $originalName,
        ?string $name = null,
        ?string $uuid = null,
        ?string $target = null,
    ): Project {
        $uuid ??= (string) Str::uuid();
        $target ??= storage_path('app/atlas/'.$uuid);

        Path::ensureDirectory($target);

        // The chunked uploader assembles elsewhere; move it into the workspace.
        if (realpath($archivePath) !== realpath($target.'/upload.zip')) {
            if (! @rename($archivePath, $target.'/upload.zip')) {
                copy($archivePath, $target.'/upload.zip');
                @unlink($archivePath);
            }

            $archivePath = $target.'/upload.zip';
        }

        $extractTo = $target.'/source';
        $result = Path::extractZip(
            $archivePath,
            $extractTo,
            (int) config('atlas.max_extracted_bytes', 2_147_483_648),
        );

        $root = Path::detectProjectRoot($extractTo);
        $measure = Path::measure($root);

        $project = Project::create([
            'uuid' => $uuid,
            'name' => $name ?: $this->guessName($originalName, $root),
            'source_type' => 'upload',
            'source_ref' => $originalName,
            'root_path' => $root,
            'archive_size' => $result['bytes'] ?: $measure['bytes'],
            'file_count' => $measure['files'],
            'meta' => [
                'original_name' => $originalName,
                'extracted_entries' => $result['entries'],
                'uploaded_at' => now()->toIso8601String(),
            ],
        ]);

        @unlink($archivePath);

        $this->startScan($project);

        return $project;
    }

    /** Register a project that already exists on this machine (used by the CLI + demo). */
    public function adopt(string $root, string $name, string $sourceType = 'path', ?string $sourceRef = null): Project
    {
        $root = rtrim($root, '/');
        $measure = Path::measure($root);

        $project = Project::create([
            'uuid' => (string) Str::uuid(),
            'name' => $name,
            'source_type' => $sourceType,
            'source_ref' => $sourceRef ?? $root,
            'root_path' => $root,
            'archive_size' => $measure['bytes'],
            'file_count' => $measure['files'],
            'meta' => ['adopted_at' => now()->toIso8601String()],
        ]);

        $this->startScan($project);

        return $project;
    }

    /** Materialise the bundled sample application and register it. */
    public function createDemo(?string $name = 'TaskFlow'): Project
    {
        $uuid = (string) Str::uuid();
        $root = $this->demo->materialize($uuid);

        $measure = Path::measure($root);

        $project = Project::create([
            'uuid' => $uuid,
            'name' => $name ?? 'TaskFlow',
            'source_type' => 'demo',
            'source_ref' => 'Built-in sample: a task management API + dashboard',
            'root_path' => $root,
            'archive_size' => $measure['bytes'],
            'file_count' => $measure['files'],
            'meta' => [
                'demo' => true,
                'description' => 'A realistic Laravel 13 application used to demonstrate AtlasScope.',
            ],
        ]);

        $this->startScan($project);

        return $project;
    }

    public function startScan(Project $project): Scan
    {
        /** @var Scan $scan */
        $scan = $project->scans()->create([
            'status' => ScanStatus::Queued->value,
            'stage' => 'extract',
            'progress' => 0,
        ]);

        if (config('atlas.sync_scans', false)) {
            RunScan::dispatchSync($scan->id, (bool) config('atlas.verbose_scans', false));
        } else {
            RunScan::dispatch($scan->id, (bool) config('atlas.verbose_scans', false));
        }

        return $scan->refresh();
    }

    public function destroy(Project $project): void
    {
        $path = storage_path('app/atlas/'.$project->uuid);

        $project->delete();

        if (is_dir($path) && Path::isInside($path, storage_path('app/atlas'))) {
            Path::deleteDirectory($path);
        }
    }

    private function guessName(string $originalName, string $root): string
    {
        $base = preg_replace('/\.zip$/i', '', $originalName) ?? $originalName;
        $base = trim((string) preg_replace('/[^A-Za-z0-9 _\-\.]/', '', $base));

        if ($base !== '' && ! in_array(strtolower($base), ['source', 'project', 'code', 'archive'], true)) {
            return Str::headline(str_replace(['_', '-'], ' ', $base));
        }

        return basename($root);
    }
}
