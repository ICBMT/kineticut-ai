<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages;

use App\Enums\Language;
use App\Enums\ScanStage;

/**
 * C++ — CMake projects, headers and sources.
 */
class CppProfile extends LanguageProfile
{
    /** Folders that hold checked-out third-party code rather than ours. */
    private const VENDOR_DIRS = [
        'third_party', 'third-party', 'external', 'extern', 'deps', 'depends',
        'vendor', 'subprojects', 'packages',
    ];

    /** Build output. Scanning it would triple the file count with noise. */
    private const OUTPUT_DIRS = [
        'bin', 'obj', 'out', 'cmake-build-debug', 'cmake-build-release',
        'cmake-build-relwithdebinfo', 'debug', 'release', 'build', 'dist',
        'x64', 'x86', '.vs',
    ];

    public function language(): Language
    {
        return Language::Cpp;
    }

    public function detect(string $root): int
    {
        $score = 0;

        if ($this->has($root, 'CMakeLists.txt', 'meson.build', 'premake5.lua', 'conanfile.txt', 'conanfile.py', 'vcpkg.json')) {
            $score += 40;
        }

        if ($this->has($root, '*.vcxproj')) {
            $score += 30;
        }

        if ($this->has($root, 'Makefile', 'makefile', 'CMakePresets.json')) {
            $score += 12;
        }

        foreach (['include', 'src', 'source', 'lib'] as $dir) {
            if (is_dir($root.'/'.$dir)) {
                $score += 4;
            }
        }

        // Source files are the strongest evidence that survives a missing build
        // file, so they are counted rather than merely detected.
        $sources = $this->countFiles($root, ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'], 20);

        $score += min(30, $sources * 2);

        return min(100, $score);
    }

    public function plan(): array
    {
        return [
            ScanStage::Build,
            ScanStage::Files,
            ScanStage::Declarations,
            ScanStage::References,
            ScanStage::Calls,
            ScanStage::Insights,
            ScanStage::Layout,
        ];
    }

    public function moduleFor(string $relativePath): string
    {
        $path = $this->stripContainers($relativePath, ['src', 'source', 'sources', 'include', 'inc', 'lib', 'libs', 'app', 'apps', 'code', 'tests', 'test', 'unittests', 'samples', 'examples']);

        $segments = explode('/', $path);

        // A file sitting in the container itself (src/main.cpp) belongs to the
        // first folder that actually groups code, which is the project itself.
        return count($segments) > 1 ? $segments[0] : 'Core';
    }

    public function skipDirectories(): array
    {
        return array_merge(self::VENDOR_DIRS, self::OUTPUT_DIRS);
    }

    public function extraSourceExtensions(): array
    {
        return ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h', 'inl', 'ipp', 'tpp', 'cu', 'cmake'];
    }

    public function fileLanguage(string $path): ?string
    {
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        return match ($extension) {
            'cpp', 'cc', 'cxx', 'c++', 'cu' => 'cpp',
            'h', 'hpp', 'hh', 'hxx', 'inl', 'ipp', 'tpp' => 'cpp-header',
            'cmake' => 'cmake',
            default => null,
        };
    }
}
