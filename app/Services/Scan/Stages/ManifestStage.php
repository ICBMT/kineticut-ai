<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\ScanStage;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\Path;

/**
 * Stage 1 — reads composer.json / composer.lock, the framework version, the
 * package list and the application's configuration surface.
 */
class ManifestStage implements Stage
{
    public function name(): ScanStage
    {
        return ScanStage::Manifest;
    }

    public function run(ScanContext $context): array
    {
        $root = $context->root;
        $manifest = $this->readComposer($root);

        $frameworkVersion = $this->frameworkVersion($root, $manifest);
        $packages = $this->packages($root, $manifest);
        $env = $this->envKeys($root);
        $isPackage = ! file_exists(Path::join($root, 'artisan')) && file_exists(Path::join($root, 'src/composer.json'));

        $context->project->update([
            'name' => $context->project->name !== '' ? $context->project->name : ($manifest['name'] ?? basename($root)),
            'composer_name' => $manifest['name'] ?? null,
            'composer_description' => $manifest['description'] ?? null,
            'framework_version' => $frameworkVersion,
            'php_constraint' => $manifest['require']['php'] ?? null,
            'package_count' => count($packages),
            'meta' => array_merge($context->project->meta ?? [], [
                'is_package' => $isPackage,
                'packages' => $packages,
                'env_keys' => $env,
                'laravel_version' => $frameworkVersion,
            ]),
        ]);

        $payload = [
            'manifest' => $manifest,
            'framework_version' => $frameworkVersion,
            'packages' => $packages,
            'env_keys' => $env,
            'is_package' => $isPackage,
        ];

        $context->writeArtifact('manifest', $payload);

        $context->log(sprintf(
            'Laravel %s detected with %d direct packages',
            $frameworkVersion ?: 'unknown',
            count($packages)
        ), 'success');

        return [
            'summary' => sprintf('%s Laravel %s · %d packages', $manifest['name'] ?? 'project', $frameworkVersion ?: '?', count($packages)),
            'metrics' => [
                'framework_version' => $frameworkVersion,
                'packages' => count($packages),
                'env_keys' => count($env),
            ],
        ];
    }

    private function readComposer(string $root): array
    {
        $path = Path::join($root, 'composer.json');

        if (! is_file($path)) {
            if (is_file(Path::join($root, 'src/composer.json'))) {
                $path = Path::join($root, 'src/composer.json');
                $root = Path::join($root, 'src');
            } else {
                return [];
            }
        }

        $decoded = json_decode((string) file_get_contents($path), true);

        return is_array($decoded) ? $decoded : [];
    }

    private function frameworkVersion(string $root, array $manifest): ?string
    {
        // 1. composer.lock is authoritative when present.
        $lockPath = is_file(Path::join($root, 'composer.lock'))
            ? Path::join($root, 'composer.lock')
            : Path::join($root, 'src/composer.lock');

        if (is_file($lockPath)) {
            $lock = json_decode((string) file_get_contents($lockPath), true);

            foreach (['packages', 'packages-dev'] as $bucket) {
                foreach ($lock[$bucket] ?? [] as $package) {
                    if (($package['name'] ?? '') === 'laravel/framework') {
                        return ltrim((string) ($package['version'] ?? ''), 'v');
                    }
                }
            }
        }

        // 2. An installed vendor directory tells us the exact minor version.
        $installed = Path::join($root, 'vendor/composer/installed.json');

        if (! is_file($installed)) {
            $installed = Path::join($root, 'src/vendor/composer/installed.json');
        }

        if (is_file($installed)) {
            $data = json_decode((string) file_get_contents($installed), true);
            $packages = $data['packages'] ?? $data;

            foreach ((array) $packages as $package) {
                if (($package['name'] ?? '') === 'laravel/framework') {
                    return ltrim((string) ($package['version'] ?? ''), 'v');
                }
            }
        }

        // 3. Fall back to the constraint.
        $constraint = $manifest['require']['laravel/framework'] ?? $manifest['require']['illuminate/support'] ?? null;

        return $constraint ? preg_replace('/[^0-9.]+/', '', (string) $constraint) : null;
    }

    /** @return array<int, array{name:string,direct:bool,constraint:?string,dev:bool}> */
    private function packages(string $root, array $manifest): array
    {
        $packages = [];

        foreach (['require', 'require-dev'] as $bucket) {
            foreach ($manifest[$bucket] ?? [] as $name => $constraint) {
                if ($name === 'php' || str_starts_with($name, 'ext-') || str_starts_with($name, 'lib-')) {
                    continue;
                }

                $packages[] = [
                    'name' => $name,
                    'constraint' => (string) $constraint,
                    'dev' => $bucket === 'require-dev',
                    'direct' => true,
                    'vendor' => explode('/', $name)[0] ?? '',
                ];
            }
        }

        return $packages;
    }

    /** @return array<int, string> */
    private function envKeys(string $root): array
    {
        $candidates = ['.env.example', '.env'];

        foreach ($candidates as $candidate) {
            $path = Path::join($root, $candidate);

            if (! is_file($path)) {
                continue;
            }

            $keys = [];
            foreach (file($path) ?: [] as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#') || ! str_contains($line, '=')) {
                    continue;
                }
                $key = trim(explode('=', $line, 2)[0]);
                if ($key !== '' && preg_match('/^[A-Z0-9_]+$/', $key)) {
                    $keys[] = $key;
                }
            }

            return array_values(array_unique($keys));
        }

        return [];
    }
}
