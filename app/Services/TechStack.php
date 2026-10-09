<?php

declare(strict_types=1);

namespace App\Services;

use App\Enums\EdgeKind;
use App\Enums\Language;
use App\Enums\Layer;
use App\Models\GraphNode;
use App\Models\Project;
use App\Models\Scan;

/**
 * What the project is built on, in one small object.
 *
 * Every language answers the same three questions — what runs it, what builds
 * it, and what it depends on — but the evidence lives in different places: a
 * composer.json for Laravel, a `.csproj` target framework for C#, a
 * `CMakeLists.txt` project declaration for C++, a `pyproject.toml` for Python.
 * They are all read from the
 * graph here, so the tech strip on the right of the atlas looks the same
 * whatever is loaded, and only its contents change.
 */
class TechStack
{
    /** Packages listed before the list is summarised rather than printed. */
    private const MAX_PACKAGES = 6;

    public function build(Project $project, ?Scan $scan): array
    {
        $language = $project->language();
        $metrics = $scan?->metrics ?? [];

        $packages = $scan !== null ? $this->packages($scan) : [];
        $stacks = [
            'php' => 'PHP',
            'csharp' => '.NET',
            'cpp' => 'C++',
            'python' => 'CPython',
        ];

        $items = [];

        // ---- the language itself -------------------------------------------
        $runtime = $stacks[$language->value] ?? null;
        $name = $language === Language::Php ? 'PHP' : $language->label();

        $items[] = [
            'label' => 'Language',
            'value' => $name,
            // "C++ (C++)" helps nobody; the runtime is only worth a line when
            // it says something the name does not.
            'hint' => $runtime !== null && $runtime !== $name ? $runtime : null,
        ];

        // ---- the runtime / framework ---------------------------------------
        $framework = $this->framework($project, $metrics, $language);

        if ($framework !== null) {
            $items[] = $framework;
        }

        // ---- the build system / package manager -----------------------------
        $build = $this->buildSystem($metrics, $language);

        if ($build !== null) {
            $items[] = $build;
        }

        // ---- how much code, as a scale reference ---------------------------
        $items[] = [
            'label' => 'Source',
            'value' => number_format((int) ($project->file_count ?? 0)).' files',
            'hint' => number_format((int) ($project->loc ?? 0)).' lines',
        ];

        return [
            'language' => $language->value,
            'language_label' => $language->label(),
            'language_short' => $language->short(),
            'color' => $language->color(),
            'headline' => $this->headline($project, $language, $framework),
            'items' => array_values(array_filter($items, fn (?array $item) => $item !== null)),
            'packages' => $packages,
            'packages_label' => match ($language) {
                Language::Php => 'Composer packages',
                Language::CSharp => 'NuGet packages',
                Language::Python => 'Python packages',
                default => 'CMake packages',
            },
            // The project column is authoritative when it has a number (composer
            // writes it), and the chip count is the honest fallback when a
            // compiled scan only ever found packages in the build file.
            'package_count' => $project->package_count ?: count($packages),
        ];
    }

    /** The one-line summary that sits at the top of the strip. */
    private function headline(Project $project, Language $language, ?array $framework): string
    {
        return match ($language) {
            Language::Php => $project->framework_version !== null
                ? 'Laravel '.$project->framework_version
                : 'Laravel',
            // (the badge beside the headline already says PHP, so the headline
            // spends its characters on the framework instead)
            Language::CSharp => $framework['value'] !== null
                ? '.NET '.$framework['value']
                : '.NET',
            Language::Cpp => $project->framework_version !== null
                ? 'C++ · '.$project->framework_version
                : 'C++',
            // Django, Flask, FastAPI — whatever the manifest named, or nothing.
            Language::Python => $project->framework_version !== null
                ? $project->framework_version
                : 'Python',
            default => $language->label(),
        };
    }

    private function framework(Project $project, array $metrics, Language $language): ?array
    {
        if ($language === Language::Php) {
            if ($project->framework_version === null && $project->php_constraint === null) {
                return null;
            }

            return [
                'label' => 'Framework',
                'value' => $project->framework_version !== null ? 'Laravel '.$project->framework_version : 'Laravel',
                'hint' => $project->php_constraint !== null ? 'requires PHP '.$project->php_constraint : null,
            ];
        }

        if ($language === Language::CSharp) {
            // `<TargetFramework>net8.0</TargetFramework>`, gathered by the build stage.
            $target = $metrics['target_framework'] ?? $project->framework_version;

            return $target !== null && $target !== '' ? [
                'label' => 'Runtime',
                'value' => $target,
                'hint' => str_starts_with((string) $target, 'net') ? 'ASP.NET Core' : null,
            ] : null;
        }

        // Python states its framework in the packaging file, and its own
        // version separately — both are worth a row, because "Django 5.0 on
        // Python 3.11" is the whole answer to "what is this".
        if ($language === Language::Python) {
            $framework = $project->framework_version;
            $python = $metrics['python'] ?? $metrics['requires_python'] ?? null;
            $hint = $python !== null ? 'requires '.(string) $python : null;

            return $framework !== null || $python !== null ? [
                'label' => $framework !== null ? 'Framework' : 'Runtime',
                'value' => $framework ?? ('Python '.$python),
                'hint' => $hint,
            ] : null;
        }

        // C++ states its standard in CMake, and its project name with it.
        if (($metrics['build_system'] ?? null) === 'cmake') {
            return [
                'label' => 'Target',
                'value' => (string) ($metrics['project'] ?? $project->displayName()),
                'hint' => sprintf(
                    '%d target%s · %d executable%s',
                    (int) ($metrics['targets'] ?? 0),
                    (int) ($metrics['targets'] ?? 0) === 1 ? '' : 's',
                    (int) ($metrics['executables'] ?? 0),
                    (int) ($metrics['executables'] ?? 0) === 1 ? '' : 's',
                ),
            ];
        }

        return null;
    }

    private function buildSystem(array $metrics, Language $language): ?array
    {
        $system = $metrics['build_system'] ?? null;

        /*
         * Composer is Laravel's build system in every sense that matters to
         * someone reading the strip: it resolves the dependencies and writes the
         * autoloader. The PHP scanner reports the count rather than a name, so
         * the row is built from that.
         */
        if ($language === Language::Php) {
            $count = (int) ($metrics['packages'] ?? 0);

            if ($count === 0 && $system === null) {
                return null;
            }

            return [
                'label' => 'Packages',
                'value' => 'composer',
                'hint' => sprintf('%d required', $count),
            ];
        }

        if ($system === null) {
            return null;
        }

        $label = match ($language) {
            Language::CSharp => 'Build',
            Language::Cpp => 'Build',
            Language::Python => 'Packages',
            default => 'Packages',
        };

        return [
            'label' => $label,
            'value' => match ($system) {
                'cmake' => 'CMake',
                'msbuild' => 'MSBuild (.sln)',
                'poetry' => 'Poetry (pyproject.toml)',
                'pipenv' => 'Pipenv',
                'setuptools' => 'setuptools',
                'uv' => 'uv',
                'pip' => 'pip (requirements.txt)',
                default => ucfirst((string) $system),
            },
            'hint' => $language === Language::Php
                ? ($metrics['packages'] ?? $metrics['package_count'] ?? null)
                : sprintf('%d package%s', (int) ($metrics['packages'] ?? 0), ((int) ($metrics['packages'] ?? 0)) === 1 ? '' : 's'),
        ];
    }

    private function packageManager(Language $language, array $metrics): ?string
    {
        return match ($language) {
            Language::Php => 'composer',
            Language::CSharp => 'nuget',
            Language::Cpp => ($metrics['build_system'] ?? null) === 'cmake' ? 'find_package' : null,
            Language::Python => $metrics['package_manager'] ?? 'pip',
            default => null,
        };
    }

    /**
     * Named dependencies, taken from the package nodes the scan created — which
     * means C++ and C# get the same treatment composer packages already had.
     *
     * @return array<int, array{name:string, version:?string}>
     */
    private function packages(Scan $scan): array
    {
        return GraphNode::where('scan_id', $scan->id)
            ->where('type', 'package')
            ->orderByDesc('weight')
            ->limit(self::MAX_PACKAGES * 3)
            ->get()
            ->map(function (GraphNode $node) {
                $meta = $node->meta ?? [];

                return [
                    'name' => $node->label,
                    'version' => $meta['version'] ?? null,
                    // Framework packages (`Microsoft`, `System`) are noise here.
                    'kind' => $meta['kind'] ?? $meta['manager'] ?? null,
                ];
            })
            ->reject(fn (array $package) => $package['kind'] === 'platform')
            ->unique('name')
            ->take(self::MAX_PACKAGES)
            ->map(fn (array $package) => ['name' => $package['name'], 'version' => $package['version']])
            ->values()
            ->all();
    }
}
