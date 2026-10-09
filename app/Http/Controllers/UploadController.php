<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Services\ProjectManager;
use App\Support\Ini;
use App\Support\Path;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Chunked uploads — the reason AtlasScope works on a stock PHP install.
 *
 * PHP's `upload_max_filesize` and `post_max_size` only govern *multipart form*
 * uploads. A raw request body (a `PUT` with `application/octet-stream`) is not
 * parsed as form data, so neither limit applies to it: a 12 MB body arrives
 * intact on a server configured for 2 MB. The browser therefore slices a large
 * archive into ~1 MB pieces and streams them here, which also survives proxy
 * body limits and gives the user a real progress bar.
 *
 * The pieces are assembled on disk and then handed to ProjectManager exactly
 * like a normal upload, so scanning, sandboxing and workspaces are unchanged.
 */
class UploadController extends Controller
{
    /** Sessions older than this are swept whenever a new one starts. */
    private const SESSION_TTL_HOURS = 6;

    /** A generous ceiling on pieces: 1 MB pieces means 150 GB of archive. */
    private const MAX_CHUNKS = 100_000;

    /** Start a session and tell the browser how finely to slice the file. */
    public function start(Request $request): JsonResponse
    {
        $capacity = Ini::capacity();

        $validated = $request->validate([
            'bytes' => ['required', 'integer', 'min:1', 'max:'.$capacity['app_max_bytes']],
            'name' => ['nullable', 'string', 'max:180'],
        ], [
            'bytes.max' => 'That archive is larger than AtlasScope\'s ceiling of '.$capacity['app_max_human']
                .'. Raise ATLAS_MAX_ARCHIVE_BYTES if that is intentional.',
        ]);

        $this->sweep();

        $token = Str::random(40);
        $directory = $this->directory($token);

        Path::ensureDirectory($directory);

        $this->writeMeta($directory, [
            'token' => $token,
            'bytes' => (int) $validated['bytes'],
            'received' => 0,
            'chunks' => 0,
            'name' => $validated['name'] ?? null,
            'created_at' => now()->toIso8601String(),
        ]);

        return response()->json([
            'token' => $token,
            'chunk_size' => $this->chunkSize(),
        ]);
    }

    /** Accept one piece. The body is the piece; nothing is parsed or buffered. */
    public function chunk(Request $request, string $token): JsonResponse
    {
        $directory = $this->existingDirectory($token);

        $index = (int) $request->header('X-Atlas-Index', -1);
        $total = (int) $request->header('X-Atlas-Total', 0);

        if ($index < 0 || $index >= self::MAX_CHUNKS) {
            return response()->json(['error' => 'Invalid chunk index.'], 422);
        }

        $meta = $this->readMeta($directory);

        // An out-of-order or repeated piece would silently corrupt the archive.
        if ($index !== (int) $meta['chunks']) {
            return response()->json([
                'error' => 'Out-of-order chunk.',
                'expected' => (int) $meta['chunks'],
            ], 409);
        }

        $written = $this->streamToFile($directory.'/'.$index.'.part', $request);

        if ($written === 0) {
            return response()->json(['error' => 'Empty chunk.'], 422);
        }

        $meta['chunks'] = $index + 1;
        $meta['received'] = (int) $meta['received'] + $written;
        $meta['total_chunks'] = $total;
        $this->writeMeta($directory, $meta);

        return response()->json([
            'index' => $index,
            'received' => $meta['received'],
            'expected' => (int) $meta['bytes'],
        ]);
    }

    /** Glue the pieces together and run the normal upload pipeline. */
    public function complete(Request $request, string $token, ProjectManager $manager): JsonResponse
    {
        $directory = $this->existingDirectory($token);

        $meta = $this->readMeta($directory);
        $capacity = Ini::capacity();

        $validated = $request->validate([
            'name' => ['nullable', 'string', 'max:120'],
        ]);

        $chunks = (int) $meta['chunks'];

        if ($chunks === 0) {
            return response()->json(['error' => 'Nothing was uploaded.'], 422);
        }

        $archive = storage_path('app/atlas/_uploads/'.$token.'.zip');
        $out = @fopen($archive, 'wb');

        if ($out === false) {
            return response()->json(['error' => 'Could not assemble the archive.'], 500);
        }

        for ($i = 0; $i < $chunks; $i++) {
            $piece = $directory.'/'.$i.'.part';

            if (! is_file($piece)) {
                fclose($out);
                @unlink($archive);

                return response()->json(['error' => 'A piece of the archive is missing. Please try again.'], 422);
            }

            $in = fopen($piece, 'rb');
            stream_copy_to_stream($in, $out);
            fclose($in);
        }

        fclose($out);

        $size = (int) filesize($archive);

        if ($size > $capacity['app_max_bytes']) {
            @unlink($archive);

            return response()->json([
                'error' => 'That archive is '.Ini::forHumans($size).' — AtlasScope accepts up to '
                    .$capacity['app_max_human'].' per archive.',
            ], 422);
        }

        try {
            $project = $manager->adoptArchive(
                $archive,
                (string) ($meta['name'] ?: 'project.zip'),
                $validated['name'] ?? null,
            );
        } catch (\Throwable $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        } finally {
            Path::deleteDirectory($directory);
        }

        return response()->json([
            'project' => $project->uuid,
            'redirect' => route('projects.atlas', $project),
        ]);
    }

    /** The user changed their mind. */
    public function abort(string $token): JsonResponse
    {
        $directory = $this->directory($token);

        if (is_dir($directory) && Path::isInside($directory, storage_path('app/atlas/_uploads'))) {
            Path::deleteDirectory($directory);
        }

        return response()->json(['aborted' => true]);
    }

    /* ------------------------------------------------------------------ bits -- */

    /**
     * 1 MB pieces: comfortably under any PHP limit, any proxy limit, and most
     * per-request timeouts, while still being few enough to feel immediate.
     */
    private function chunkSize(): int
    {
        $ceiling = Ini::uploadCeiling();
        $half = (int) max(131_072, intdiv($ceiling, 2));

        return min(1_048_576, $half);
    }

    private function directory(string $token): string
    {
        if (preg_match('/^[A-Za-z0-9]{40}$/', $token) !== 1) {
            abort(404);
        }

        return storage_path('app/atlas/_uploads/'.$token);
    }

    private function existingDirectory(string $token): string
    {
        $directory = $this->directory($token);

        if (! is_file($directory.'/meta.json')) {
            abort(404, 'That upload session has expired.');
        }

        return $directory;
    }

    /**
     * Copy the raw request body to disk, a piece at a time.
     *
     * `php://input` is the streaming source for a real request and keeps memory
     * flat regardless of piece size. Framework test kernels (and a few SAPIs)
     * do not populate it, so the body the framework already holds is the
     * fallback — without it this endpoint would be untestable.
     */
    private function streamToFile(string $path, Request $request): int
    {
        $out = @fopen($path, 'wb');

        if ($out === false) {
            return 0;
        }

        $in = @fopen('php://input', 'rb');
        $written = 0;

        if ($in !== false) {
            $written = (int) stream_copy_to_stream($in, $out);
            fclose($in);
        }

        if ($written === 0) {
            $content = $request->getContent();
            $written = strlen($content);

            if ($written > 0) {
                fwrite($out, $content);
            }
        }

        fclose($out);

        return $written;
    }

    private function writeMeta(string $directory, array $meta): void
    {
        file_put_contents($directory.'/meta.json', json_encode($meta, JSON_THROW_ON_ERROR));
    }

    private function readMeta(string $directory): array
    {
        $raw = file_get_contents($directory.'/meta.json');

        return is_string($raw) ? (json_decode($raw, true) ?: []) : [];
    }

    /** Drop abandoned sessions so the disk does not fill with orphans. */
    private function sweep(): void
    {
        $root = storage_path('app/atlas/_uploads');

        if (! is_dir($root)) {
            return;
        }

        $cutoff = now()->subHours(self::SESSION_TTL_HOURS)->getTimestamp();

        foreach (glob($root.'/*', GLOB_ONLYDIR) ?: [] as $directory) {
            if (filemtime($directory) < $cutoff) {
                Path::deleteDirectory($directory);
            }
        }

        foreach (glob($root.'/*.zip') ?: [] as $archive) {
            if (filemtime($archive) < $cutoff) {
                @unlink($archive);
            }
        }
    }
}
