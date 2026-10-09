<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\ScanStage;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\Path;

/**
 * Stage 0 — verifies the uploaded archive really is a Laravel project and
 * normalises the root path (GitHub zips wrap everything in one folder).
 */
class ExtractStage implements Stage
{
    public function name(): ScanStage
    {
        return ScanStage::Extract;
    }

    public function run(ScanContext $context): array
    {
        $root = $context->root;

        if (! is_dir($root)) {
            throw new \RuntimeException('The project directory no longer exists on disk.');
        }

        $projectRoot = Path::detectProjectRoot($root);

        $isLaravel = $context->isLaravel() && (
            file_exists(Path::join($projectRoot, 'artisan'))
            || is_dir(Path::join($projectRoot, 'app'))
            || file_exists(Path::join($projectRoot, 'bootstrap/app.php'))
        );

        if ($context->isLaravel() && ! $isLaravel) {
            $context->log('No artisan file or app/ directory found — the code will still be indexed, but Laravel-specific analysis may be limited.', 'warn');
        }

        $hasComposer = file_exists(Path::join($projectRoot, 'composer.json'));
        $isPackage = ! file_exists(Path::join($projectRoot, 'artisan')) && file_exists(Path::join($projectRoot, 'src/composer.json'));

        $context->project->update(['root_path' => $projectRoot]);

        // Every later stage reads the root from the shared context, so point it
        // at the detected project directory (GitHub zips add a wrapper folder).
        $context->root = $projectRoot;

        $measure = Path::measure($projectRoot);

        $context->writeArtifact('root', [
            'root' => $projectRoot,
            'language' => $context->language->value,
            'is_laravel' => $isLaravel,
            'is_package' => $isPackage,
            'has_composer' => $hasComposer,
            'files' => $measure['files'],
            'bytes' => $measure['bytes'],
        ]);

        $context->scan->refresh()->update(['file_count' => $measure['files']]);
        $context->project->update([
            'file_count' => $measure['files'],
            'source_type' => $isPackage ? 'package' : ($context->project->source_type ?: 'upload'),
        ]);

        return [
            'summary' => sprintf(
                '%s files · %s · root: %s',
                number_format($measure['files']),
                Path::humanBytes($measure['bytes']),
                basename($projectRoot)
            ),
            'metrics' => ['files_indexed' => $measure['files'], 'bytes' => $measure['bytes']],
        ];
    }
}
