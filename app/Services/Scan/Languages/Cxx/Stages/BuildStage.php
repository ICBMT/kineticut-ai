<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx\Stages;

use App\Enums\EdgeKind;
use App\Enums\Language;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Reads the build manifests — CMakeLists.txt for C++, .sln/.csproj for C# —
 * and turns them into the top of the graph: what this project *builds*.
 *
 * A build file is the one place a foreign codebase states its own structure in
 * plain text, so it is worth the parse: executables and libraries become the
 * entry points of a C++ atlas, and a .csproj tells us the target framework,
 * the NuGet packages and which sibling projects it depends on.
 */
class BuildStage implements Stage
{
    public function name(): ScanStage
    {
        return ScanStage::Build;
    }

    public function run(ScanContext $context): array
    {
        $graph = new GraphBuilder;
        $language = $context->language;

        $summary = $language === Language::CSharp
            ? $this->scanDotNet($context, $graph)
            : $this->scanCMake($context, $graph);

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        return $summary;
    }

    /* ------------------------------------------------------------- CMake -- */

    private function scanCMake(ScanContext $context, GraphBuilder $graph): array
    {
        $files = $this->findFiles($context->root, ['CMakeLists.txt'], 60);
        $targets = [];
        $packages = [];
        $projectName = $context->project->displayName();

        foreach ($files as $relative => $absolute) {
            $source = (string) @file_get_contents($absolute);

            if ($source === '') {
                continue;
            }

            // project(Acme LANGUAGES CXX)
            if (preg_match('/project\s*\(\s*([A-Za-z0-9_\-\.]+)/i', $source, $matches)) {
                $projectName = $matches[1];
            }

            // add_executable(acme src/main.cpp ...) / add_library(render ...)
            if (preg_match_all('/add_(executable|library)\s*\(\s*([A-Za-z0-9_\-\.]+)([^)]*)\)/i', $source, $matches, PREG_SET_ORDER)) {
                foreach ($matches as $match) {
                    $name = $match[2];
                    $isExecutable = strtolower($match[1]) === 'executable';

                    $targets[$name] = [
                        'name' => $name,
                        'kind' => $isExecutable ? 'executable' : 'library',
                        'file' => $relative,
                        'sources' => $this->sourceList($match[3]),
                    ];
                }
            }

            // target_link_libraries(app PRIVATE render util)
            if (preg_match_all('/target_link_libraries\s*\(\s*([A-Za-z0-9_\-\.]+)([^)]*)\)/i', $source, $matches, PREG_SET_ORDER)) {
                foreach ($matches as $match) {
                    if (! isset($targets[$match[1]])) {
                        continue;
                    }

                    $targets[$match[1]]['links'][] = array_values(array_filter(
                        preg_split('/\s+/', trim($match[2])) ?: [],
                        fn (string $part) => $part !== '',
                    ));
                }
            }

            // find_package(Qt6 REQUIRED) — the closest thing C++ has to a dependency list
            if (preg_match_all('/find_package\s*\(\s*([A-Za-z0-9_\-\.]+)/i', $source, $matches)) {
                foreach ($matches[1] as $package) {
                    $packages[$package] = true;
                }
            }
        }

        foreach ($targets as $name => $target) {
            $isExecutable = $target['kind'] === 'executable';
            $key = 'target:'.$name;

            $graph->node($key, $isExecutable ? NodeType::Executable : NodeType::Library, $name, [
                'layer' => $isExecutable ? Layer::Entry : Layer::Infrastructure,
                'file' => $target['file'],
                'module' => 'Build',
                'weight' => $isExecutable ? 92 : 60,
                'meta' => [
                    'target' => $name,
                    'kind' => $target['kind'],
                    'sources' => array_slice($target['sources'], 0, 40),
                    'build_system' => 'cmake',
                ],
            ]);
        }

        foreach ($targets as $name => $target) {
            $links = $target['links'] ?? [];

            foreach ($links as $group) {
                foreach ($group as $linked) {
                    $linked = trim($linked);

                    if ($linked === '' || in_array(strtoupper($linked), ['PRIVATE', 'PUBLIC', 'INTERFACE'], true)) {
                        continue;
                    }

                    if (isset($targets[$linked])) {
                        $graph->edge('target:'.$name, 'target:'.$linked, EdgeKind::DependsOn);
                    } elseif (isset($packages[$linked])) {
                        $graph->edge('target:'.$name, 'pkg:'.$linked, EdgeKind::DependsOn);
                    }
                }
            }
        }

        foreach (array_keys($packages) as $package) {
            $graph->node('pkg:'.$package, NodeType::Package, $package, [
                'layer' => Layer::External,
                'module' => 'Packages',
                'weight' => 30,
                'meta' => ['package' => $package, 'manager' => 'cmake'],
            ]);
        }

        // Remember the target source lists so the reference stage can attach
        // the entry point files to the targets that build them.
        $context->writeArtifact('build', [
            'system' => 'cmake',
            'project' => $projectName,
            'targets' => array_map(fn (array $t) => [
                'name' => $t['name'],
                'kind' => $t['kind'],
                'file' => $t['file'],
                'sources' => $t['sources'],
            ], array_values($targets)),
        ]);

        $context->project->update(['framework_version' => 'CMake']);

        $executables = count(array_filter($targets, fn (array $t) => $t['kind'] === 'executable'));

        $context->log(sprintf(
            'CMake: %d target%s (%d executable%s) · %d packages',
            count($targets), count($targets) === 1 ? '' : 's',
            $executables, $executables === 1 ? '' : 's',
            count($packages),
        ));

        return [
            'summary' => sprintf('%d CMake targets · %d packages', count($targets), count($packages)),
            'metrics' => [
                'targets' => count($targets),
                'executables' => $executables,
                'libraries' => count($targets) - $executables,
                'packages' => count($packages),
                'build_system' => 'cmake',
                'project' => $projectName,
            ],
        ];
    }

    /** The source paths named inside add_executable/add_library. */
    private function sourceList(string $body): array
    {
        preg_match_all('/[A-Za-z0-9_\-\.\/\$]+\.(?:cpp|cc|cxx|hpp|hh|hxx|h|cu|rc)/i', $body, $matches);

        return array_values(array_unique($matches[0] ?? []));
    }

    /* --------------------------------------------------------------- .NET -- */

    private function scanDotNet(ScanContext $context, GraphBuilder $graph): array
    {
        $projects = $this->findFiles($context->root, ['.csproj'], 80);
        $solutions = $this->findFiles($context->root, ['.sln'], 20);
        $packages = [];
        $frameworks = [];
        $references = [];

        foreach ($projects as $relative => $absolute) {
            $xml = @simplexml_load_file($absolute);

            if ($xml === false) {
                continue;
            }

            $name = basename($relative, '.csproj');
            $key = 'target:'.$name;

            $outputType = (string) ($xml->PropertyGroup->OutputType ?? 'Library');
            $isExecutable = in_array(strtolower($outputType), ['exe', 'winexe'], true);

            $targetFramework = [];

            foreach ($xml->PropertyGroup as $group) {
                if (isset($group->TargetFramework)) {
                    $targetFramework[] = (string) $group->TargetFramework;
                }

                if (isset($group->TargetFrameworks)) {
                    $targetFramework = array_merge($targetFramework, explode(';', (string) $group->TargetFrameworks));
                }
            }

            $frameworks[$name] = $targetFramework;

            $graph->node($key, $isExecutable ? NodeType::Executable : NodeType::Library, $name, [
                'layer' => $isExecutable ? Layer::Entry : Layer::Infrastructure,
                'file' => $relative,
                'module' => 'Projects',
                'weight' => $isExecutable ? 92 : 62,
                'meta' => [
                    'project' => $name,
                    'kind' => $isExecutable ? 'executable' : 'library',
                    'framework' => implode(', ', array_unique($targetFramework)),
                    'output_type' => $outputType,
                    'build_system' => 'msbuild',
                    'sdk' => (string) ($xml->{'@attributes'}['Sdk'] ?? ''),
                ],
            ]);

            foreach ($xml->ItemGroup as $group) {
                foreach ($group->PackageReference as $reference) {
                    $package = (string) ($reference['Include'] ?? '');
                    $version = (string) ($reference['Version'] ?? ($reference->Version ?? ''));

                    if ($package === '') {
                        continue;
                    }

                    $packages[$package] = $version;

                    $graph->edge($key, 'pkg:'.$package, EdgeKind::Uses);
                }

                foreach ($group->ProjectReference as $reference) {
                    $include = (string) ($reference['Include'] ?? '');
                    $referenced = basename(str_replace('\\', '/', $include), '.csproj');

                    if ($referenced !== '') {
                        $references[] = [$name, $referenced];
                    }
                }
            }
        }

        foreach ($packages as $package => $version) {
            $graph->node('pkg:'.$package, NodeType::Package, $package, [
                'layer' => Layer::External,
                'module' => 'Packages',
                'weight' => 30,
                'meta' => ['package' => $package, 'version' => $version, 'manager' => 'nuget'],
            ]);
        }

        foreach ($references as [$from, $to]) {
            if ($graph->has('target:'.$to)) {
                $graph->edge('target:'.$from, 'target:'.$to, EdgeKind::DependsOn);
            }
        }

        $context->writeArtifact('build', [
            'system' => 'msbuild',
            'projects' => array_keys($projects),
            'solutions' => array_keys($solutions),
            'frameworks' => $frameworks,
        ]);

        if ($frameworks !== []) {
            $context->project->update(['framework_version' => implode(', ', array_unique(array_merge(...array_values($frameworks))))]);
        }

        $executables = 0;

        foreach ($graph->toArray()['nodes'] as $node) {
            if (($node['type'] ?? '') === NodeType::Executable->value) {
                $executables++;
            }
        }

        $context->log(sprintf(
            '.NET: %d project%s · %d solution%s · %d packages',
            count($projects), count($projects) === 1 ? '' : 's',
            count($solutions), count($solutions) === 1 ? '' : 's',
            count($packages),
        ));

        return [
            'summary' => sprintf('%d projects · %d solutions · %d packages', count($projects), count($solutions), count($packages)),
            'metrics' => [
                'projects' => count($projects),
                'solutions' => count($solutions),
                'executables' => $executables,
                'packages' => count($packages),
                'target_framework' => implode(', ', array_unique(array_merge(...array_values($frameworks ?: [[]])))),
                'build_system' => 'msbuild',
            ],
        ];
    }

    /** @return array<string, string> relative path => absolute path */
    private function findFiles(string $root, array $suffixes, int $limit): array
    {
        $found = [];

        $walk = function (string $dir, string $relative, int $depth) use (&$walk, &$found, $suffixes, $limit): void {
            if (count($found) >= $limit || $depth > 5) {
                return;
            }

            foreach (@scandir($dir) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..' || $entry[0] === '.' || count($found) >= $limit) {
                    continue;
                }

                $path = $dir.'/'.$entry;
                $rel = $relative === '' ? $entry : $relative.'/'.$entry;

                if (is_dir($path)) {
                    $skip = ['build', 'out', 'bin', 'obj', 'node_modules', 'vendor', '.git', 'third_party', 'third-party', 'external', 'extern', 'deps', 'subprojects', 'packages', 'debug', 'release'];

                    if (in_array(strtolower($entry), $skip, true)) {
                        continue;
                    }

                    $walk($path, $rel, $depth + 1);

                    continue;
                }

                foreach ($suffixes as $suffix) {
                    if (str_ends_with(strtolower($entry), strtolower($suffix))) {
                        $found[$rel] = $path;

                        break;
                    }
                }
            }
        };

        $walk($root, '', 0);

        return $found;
    }
}
