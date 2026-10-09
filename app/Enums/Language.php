<?php

declare(strict_types=1);

namespace App\Enums;

/**
 * The codebases AtlasScope knows how to read.
 *
 * A language decides three things: which stage pipeline runs, how files and
 * symbols map onto the architectural Layers, and which file extensions the
 * indexer cares about. Everything downstream — the graph, the layouts, the
 * focus engine, the insights — is language-agnostic, because all of it works
 * on the graph rather than on source code.
 */
enum Language: string
{
    case Php = 'php';
    case Cpp = 'cpp';
    case CSharp = 'csharp';
    case Python = 'python';
    case Unknown = 'unknown';

    public function label(): string
    {
        return match ($this) {
            self::Php => 'Laravel (PHP)',
            self::Cpp => 'C++',
            self::CSharp => 'C#',
            self::Python => 'Python',
            self::Unknown => 'Unrecognised',
        };
    }

    /** What the project card shows in its badge. */
    public function short(): string
    {
        return match ($this) {
            self::Php => 'PHP',
            self::Cpp => 'C++',
            self::CSharp => 'C#',
            self::Python => 'PY',
            self::Unknown => '?',
        };
    }

    public function color(): string
    {
        return match ($this) {
            self::Php => '#a78bfa',
            self::Cpp => '#38bdf8',
            self::CSharp => '#34d399',
            self::Python => '#fbbf24',
            self::Unknown => '#94a3b8',
        };
    }

    /** Source file extensions the file index should count lines for. */
    public function sourceExtensions(): array
    {
        return match ($this) {
            self::Php => ['php', 'blade'],
            self::Cpp => ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h', 'inl', 'ipp', 'tpp', 'cu'],
            self::CSharp => ['cs'],
            self::Python => ['py', 'pyi', 'pyw'],
            self::Unknown => [],
        };
    }

    /** The build/manifest files a scan should look for first. */
    public function manifestFiles(): array
    {
        return match ($this) {
            self::Php => ['composer.json'],
            self::Cpp => ['CMakeLists.txt', 'meson.build', 'Makefile', 'premake5.lua'],
            self::CSharp => ['*.sln', '*.csproj'],
            self::Python => ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
            self::Unknown => [],
        };
    }

    public static function tryFromLoose(?string $value): self
    {
        return self::tryFrom((string) $value) ?? self::Unknown;
    }
}
