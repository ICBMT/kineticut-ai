<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages;

use App\Enums\Language;
use App\Enums\ScanStage;
use App\Services\Scan\ClassClassifier;

/**
 * Laravel / PHP — the original pipeline, unchanged.
 */
class LaravelProfile extends LanguageProfile
{
    public function __construct(private readonly ClassClassifier $classifier) {}

    public function language(): Language
    {
        return Language::Php;
    }

    public function detect(string $root): int
    {
        $score = 0;

        if (file_exists($root.'/artisan')) {
            $score += 45;
        }

        if (file_exists($root.'/composer.json')) {
            $score += 25;
        }

        if (file_exists($root.'/bootstrap/app.php')) {
            $score += 25;
        }

        foreach (['app/Http', 'routes', 'config', 'resources/views'] as $dir) {
            if (is_dir($root.'/'.$dir)) {
                $score += 8;
            }
        }

        // A composer.json that requires the framework is decisive on its own.
        $composer = $root.'/composer.json';

        if (is_file($composer)) {
            $contents = (string) @file_get_contents($composer);

            if (str_contains($contents, 'laravel/framework')) {
                $score += 30;
            }
        }

        return min(100, $score);
    }

    public function plan(): array
    {
        return [
            ScanStage::Manifest,
            ScanStage::Files,
            ScanStage::Classes,
            ScanStage::Routes,
            ScanStage::Models,
            ScanStage::Schema,
            ScanStage::Views,
            ScanStage::Links,
            ScanStage::Insights,
            ScanStage::Layout,
        ];
    }

    public function moduleFor(string $relativePath): string
    {
        return $this->classifier->moduleFor($relativePath);
    }

    public function fileLanguage(string $path): ?string
    {
        return str_ends_with($path, '.blade.php') ? 'blade' : null;
    }
}
