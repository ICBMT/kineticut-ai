<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx\Stages;

use App\Enums\EdgeKind;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\LanguageProfile;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\Path;

/**
 * Stage 2 of the C-family pipeline — the file tree.
 *
 * It is deliberately the same stage *shape* as the Laravel one: same artefact,
 * same directory nodes, same counters. Only two things differ, and both come
 * from the profile: which folders are noise (build output, vendored sources)
 * and which extensions count as source.
 */
class FileIndexStage implements Stage
{
    /** Extensions that are worth counting lines for whatever the language. */
    private const GENERIC_LINES = ['php', 'blade', 'js', 'ts', 'vue', 'css', 'json', 'md', 'yml', 'yaml'];

    private const GENERIC_LANGUAGE = [
        'js' => 'javascript', 'jsx' => 'javascript', 'ts' => 'typescript', 'tsx' => 'typescript',
        'vue' => 'vue', 'css' => 'css', 'scss' => 'scss', 'html' => 'html', 'json' => 'json',
        'md' => 'markdown', 'yml' => 'yaml', 'yaml' => 'yaml', 'xml' => 'xml', 'sh' => 'shell',
        'txt' => 'text', 'svg' => 'svg', 'sql' => 'sql',
    ];

    /** Manifests and settings that deserve a visible node of their own. */
    private const MANIFESTS = [
        'cmakelists.txt' => 'Build', 'makefile' => 'Build', 'meson.build' => 'Build',
        'conanfile.txt' => 'Build', 'vcpkg.json' => 'Build', 'cmakepresets.json' => 'Build',
        'directory.build.props' => 'Build', 'global.json' => 'Build', 'nuget.config' => 'Build',
        'dockerfile' => 'Build', 'docker-compose.yml' => 'Build',
        'appsettings.json' => 'Config', 'appsettings.development.json' => 'Config',
        'launchsettings.json' => 'Config',

        // Python packaging and test configuration.
        'pyproject.toml' => 'Build', 'requirements.txt' => 'Build', 'setup.py' => 'Build',
        'setup.cfg' => 'Build', 'pipfile' => 'Build', 'tox.ini' => 'Build',
        'pytest.ini' => 'Test',
    ];

    public function __construct(private readonly LanguageProfile $profile) {}

    public function name(): ScanStage
    {
        return ScanStage::Files;
    }

    public function run(ScanContext $context): array
    {
        // Continue the graph the build stage started — CMake targets and .NET
        // projects are the top of a compiled project's map, and a fresh builder
        // here would silently drop them.
        $graph = $context->loadGraph();
        $files = [];
        $directories = [];
        $maxFiles = 25_000;

        $profile = $this->profile;
        $skip = array_map('strtolower', array_merge($profile->skipDirectories(), ['node_modules', '.git']));
        $countExtensions = array_merge(self::GENERIC_LINES, $profile->extraSourceExtensions());

        $walk = function (string $dir, string $relative) use (&$walk, &$files, &$directories, $context, $maxFiles, $profile, $skip, $countExtensions): void {
            if (count($files) >= $maxFiles) {
                return;
            }

            $entries = @scandir($dir) ?: [];
            sort($entries);

            foreach ($entries as $entry) {
                if (in_array($entry, ['.', '..'], true)) {
                    continue;
                }

                $absolute = $dir.'/'.$entry;
                $rel = $relative === '' ? $entry : $relative.'/'.$entry;
                $isDirectory = is_dir($absolute);

                if ($isDirectory && in_array(strtolower($entry), $skip, true)) {
                    continue;
                }

                if ($isDirectory) {
                    if (Path::shouldSkipDirectory($rel, $entry)) {
                        continue;
                    }

                    $directories[$rel] = true;
                    $walk($absolute, $rel);

                    continue;
                }

                if (! is_file($absolute)) {
                    continue;
                }

                $size = (int) (@filesize($absolute) ?: 0);
                $extension = $this->extension($rel);
                $language = $profile->fileLanguage($rel) ?? self::GENERIC_LANGUAGE[$extension] ?? 'other';
                $lines = 0;

                if ($size > 0 && $size < 4_000_000 && in_array($extension, $countExtensions, true)) {
                    $content = @file_get_contents($absolute);
                    $lines = $content === false ? 0 : substr_count($content, "\n") + 1;
                }

                $files[] = [
                    'path' => $rel,
                    'size' => $size,
                    'lines' => $lines,
                    'ext' => $extension,
                    'language' => $language,
                    'module' => $profile->moduleFor($rel),
                    'dir' => dirname($rel) === '.' ? '' : dirname($rel),
                    'hidden' => str_starts_with($entry, '.'),
                ];
            }
        };

        $walk($context->root, '');

        // ---- Directory nodes (limited depth keeps the 3D scene readable) ----
        foreach (array_keys($directories) as $rel) {
            $depth = substr_count($rel, '/');

            if ($depth > 2) {
                continue;
            }

            $parentRel = dirname($rel) === '.' ? null : dirname($rel);

            $graph->node('dir:'.$rel, NodeType::Directory, basename($rel), [
                'file' => $rel,
                'module' => $this->profile->moduleFor($rel.'/x'),
                'parent' => $parentRel !== null ? 'dir:'.$parentRel : null,
                'weight' => $depth === 0 ? 34 : 18,
                'meta' => [
                    'depth' => $depth,
                    'path' => $rel,
                    'top_level' => $depth === 0,
                ],
            ]);

            if ($parentRel !== null && isset($directories[$parentRel])) {
                $graph->edge('dir:'.$parentRel, 'dir:'.$rel, EdgeKind::Groups);
            }
        }

        // ---- Build manifests and settings files as first-class nodes --------
        foreach ($files as $file) {
            $base = strtolower(basename($file['path']));

            if (! isset(self::MANIFESTS[$base]) && ! str_ends_with($base, '.sln')) {
                continue;
            }

            $module = self::MANIFESTS[$base] ?? 'Solution';

            $graph->node('config:'.$file['path'], NodeType::Config, $file['path'], [
                'file' => $file['path'],
                'module' => $module,
                'loc' => $file['lines'],
                'weight' => 45,
                'meta' => [
                    'manifest' => true,
                    'kind' => $module,
                    'format' => $module === 'Solution' ? 'msbuild' : 'build',
                ],
            ]);
        }

        $byLanguage = [];
        $totalLines = 0;

        foreach ($files as $file) {
            $byLanguage[$file['language']] = ($byLanguage[$file['language']] ?? 0) + 1;
            $totalLines += $file['lines'];
        }

        arsort($byLanguage);

        $context->writeArtifact('files', [
            'files' => $files,
            'directories' => array_keys($directories),
            'by_language' => $byLanguage,
            'total_lines' => $totalLines,
        ]);

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->project->update([
            'file_count' => count($files),
            'loc' => $totalLines,
        ]);

        $context->scan->refresh()->update(['file_count' => count($files)]);

        $context->log(sprintf(
            'Indexed %s files · %s · %s lines of code',
            number_format(count($files)),
            Path::humanBytes(array_sum(array_column($files, 'size'))),
            number_format($totalLines),
        ));

        return [
            'summary' => sprintf('%s files · %s dirs · %s LOC', number_format(count($files)), number_format(count($directories)), number_format($totalLines)),
            'metrics' => [
                'files' => count($files),
                'directories' => count($directories),
                'loc' => $totalLines,
                'by_language' => $byLanguage,
            ],
        ];
    }

    private function extension(string $path): string
    {
        $extension = pathinfo($path, PATHINFO_EXTENSION);

        return $extension === '' ? 'other' : strtolower($extension);
    }
}
