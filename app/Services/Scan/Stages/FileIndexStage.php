<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\ClassClassifier;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use App\Support\Path;

/**
 * Stage 2 — walks the tree (honouring the skip list) and records every file,
 * its language, size and module. Directory nodes are created here too so the
 * explorer sidebar has a real hierarchy to render.
 */
class FileIndexStage implements Stage
{
    private const LANGUAGE_MAP = [
        'php' => 'php', 'blade.php' => 'blade', 'js' => 'javascript', 'jsx' => 'javascript',
        'ts' => 'typescript', 'tsx' => 'typescript', 'vue' => 'vue', 'css' => 'css',
        'scss' => 'scss', 'sass' => 'sass', 'json' => 'json', 'md' => 'markdown',
        'yml' => 'yaml', 'yaml' => 'yaml', 'xml' => 'xml', 'sql' => 'sql', 'sh' => 'shell',
        'env' => 'env', 'twig' => 'twig', 'html' => 'html', 'svg' => 'svg', 'txt' => 'text',
    ];

    public function __construct(private readonly ClassClassifier $classifier) {}

    public function name(): ScanStage
    {
        return ScanStage::Files;
    }

    public function run(ScanContext $context): array
    {
        $graph = new GraphBuilder;
        $files = [];
        $directories = [];
        $maxFiles = 25_000;

        $walk = function (string $dir, string $relative) use (&$walk, &$files, &$directories, $context, $maxFiles): void {
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

                if (is_dir($absolute)) {
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
                $lines = 0;

                if ($size > 0 && $size < 4_000_000 && in_array($extension, ['php', 'blade', 'js', 'ts', 'vue', 'css', 'json', 'md', 'yml', 'yaml'], true)) {
                    $content = @file_get_contents($absolute);
                    $lines = $content === false ? 0 : substr_count($content, "\n") + 1;
                }

                $files[] = [
                    'path' => $rel,
                    'size' => $size,
                    'lines' => $lines,
                    'ext' => $extension,
                    'language' => self::LANGUAGE_MAP[$extension] ?? 'other',
                    'module' => $this->classifier->moduleFor($rel),
                    'dir' => dirname($rel) === '.' ? '' : dirname($rel),
                    'hidden' => str_starts_with($entry, '.'),
                ];
            }
        };

        $walk($context->root, '');

        // ---- Directory nodes (limited depth keeps the 3D scene readable) ----
        $topLevel = [];

        foreach (array_keys($directories) as $rel) {
            $depth = substr_count($rel, '/');

            if ($depth > 2) {
                continue;
            }

            $label = basename($rel);
            $parentRel = dirname($rel) === '.' ? null : dirname($rel);

            $graph->node('dir:'.$rel, NodeType::Directory, $label, [
                'file' => $rel,
                'module' => $this->classifier->moduleFor($rel.'/x'),
                'parent' => $parentRel !== null ? 'dir:'.$parentRel : null,
                'weight' => $depth === 0 ? 34 : 18,
                'meta' => [
                    'depth' => $depth,
                    'path' => $rel,
                    'top_level' => $depth === 0,
                ],
            ]);

            $topLevel[$rel] = true;

            if ($parentRel !== null && isset($directories[$parentRel])) {
                $graph->edge('dir:'.$parentRel, 'dir:'.$rel, EdgeKind::Groups);
            }
        }

        // ---- Config files as first-class nodes ----
        foreach ($files as $file) {
            if (preg_match('#^config/([a-z0-9_\-]+)\.php$#i', $file['path'], $matches)) {
                $graph->node('config:'.$matches[1], NodeType::Config, $matches[1].'.php', [
                    'file' => $file['path'],
                    'module' => 'Config',
                    'loc' => $file['lines'],
                    'weight' => 45,
                    'meta' => ['config_key' => $matches[1]],
                ]);
            }

            if ($file['path'] === 'bootstrap/app.php') {
                $graph->node('bootstrap:app', NodeType::Config, 'bootstrap/app.php', [
                    'file' => $file['path'],
                    'module' => 'Bootstrap',
                    'loc' => $file['lines'],
                    'weight' => 50,
                    'meta' => ['bootstrap' => true],
                ]);
            }
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
        $context->log(sprintf('Indexed %s files · %s · %s lines of code', number_format(count($files)), Path::humanBytes(array_sum(array_column($files, 'size'))), number_format($totalLines)));

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
        if (str_ends_with($path, '.blade.php')) {
            return 'blade';
        }

        $ext = pathinfo($path, PATHINFO_EXTENSION);

        return $ext === '' ? 'other' : strtolower($ext);
    }
}
