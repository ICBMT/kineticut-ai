<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Enums\Language;
use App\Enums\ScanStatus;
use App\Models\Scan;
use App\Services\Scan\Languages\ProfileRegistry;
use App\Services\Scan\ScanContext;
use App\Services\Scan\ScanPipelineFactory;
use App\Support\Path;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Throwable;

/**
 * Runs the whole scanning pipeline for one project.
 *
 * The scan itself is chunked and idempotent: progress is written to the scan
 * row after every stage, so the browser can watch it live, and a failure leaves
 * enough breadcrumbs to see exactly which stage broke.
 */
class RunScan implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 1800;

    public int $tries = 1;

    public function __construct(
        public readonly int $scanId,
        public readonly bool $verbose = false,
    ) {
        $this->onQueue('atlas');
    }

    public function handle(ScanPipelineFactory $factory, ProfileRegistry $registry): void
    {
        $scan = Scan::with('project')->find($this->scanId);

        if ($scan === null) {
            return;
        }

        $project = $scan->project;
        $language = $this->detectLanguage($project, $registry);

        $context = new ScanContext(
            scan: $scan,
            project: $project,
            root: $project->sourcePath(),
            verbose: $this->verbose,
            language: $language,
        );

        $factory->for($language)->run($context);
    }

    /**
     * Works out which language the project is written in, and records it.
     *
     * Detection runs before the extract stage normalises the root, so an
     * uploaded zip — which wraps everything in a single folder — is unwrapped
     * first; otherwise every project would look like a folder of one folder.
     * Anything unrecognised is scanned as PHP, which is the historical
     * behaviour and still produces a usable (if shallow) graph.
     */
    private function detectLanguage(\App\Models\Project $project, ProfileRegistry $registry): Language
    {
        $root = $project->sourcePath();

        if (! is_dir($root)) {
            return $project->language();
        }

        // `detectWithin` also looks inside wrapper folders, which is how a
        // zipped C++ or C# project actually arrives.
        $detection = $registry->detectWithin($root);

        if ($detection === null) {
            return $project->language();
        }

        // The wrapper folder is not part of the project: if the real root is a
        // level down, scan from there so file paths and modules read naturally.
        $detectedRoot = $detection['directory'] ?? $root;

        if ($detectedRoot !== $root && is_dir($detectedRoot)) {
            $project->update(['root_path' => $detectedRoot]);
        }

        $language = $detection['profile']->language();
        $meta = $project->meta ?? [];
        $meta['language_detection'] = [
            'language' => $language->value,
            'confidence' => $detection['confidence'],
            'scores' => $detection['scores'],
        ];

        $project->update(['language' => $language->value, 'meta' => $meta]);

        return $language;
    }

    public function failed(Throwable $exception): void
    {
        Scan::where('id', $this->scanId)->update([
            'status' => ScanStatus::Failed->value,
            'error' => $exception->getMessage(),
            'finished_at' => now(),
        ]);
    }
}
