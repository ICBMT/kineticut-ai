<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages;

use App\Enums\Language;
use App\Enums\ScanStage;

/**
 * C# — .sln solutions, .csproj projects and the ASP.NET Core conventions
 * that make routes, controllers and data access visible in the graph.
 */
class CSharpProfile extends LanguageProfile
{
    private const SKIP = [
        'bin', 'obj', '.vs', '.vscode', 'packages', 'TestResults', 'node_modules',
        'wwwroot/lib', 'Migrations', // EF migrations are noise next to the models
    ];

    public function language(): Language
    {
        return Language::CSharp;
    }

    public function detect(string $root): int
    {
        $score = 0;

        if ($this->has($root, '*.csproj')) {
            $score += 45;
        }

        if ($this->has($root, '*.sln', '*.slnx')) {
            $score += 30;
        }

        if ($this->has($root, 'Directory.Build.props', 'global.json', 'nuget.config')) {
            $score += 15;
        }

        foreach (['Program.cs', 'Startup.cs', 'appsettings.json'] as $file) {
            if (file_exists($root.'/'.$file)) {
                $score += 12;
            }
        }

        $sources = $this->countFiles($root, ['.cs'], 20);

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
        $path = $this->stripContainers($relativePath, ['src', 'source', 'sources', 'app', 'apps', 'code', 'web', 'api', 'tests', 'test']);

        $segments = explode('/', $path);

        // C# solutions nest everything one level deeper than C++ ones:
        // src/Acme.Web/Services/UserService.cs is "Services", not "Acme.Web".
        // The assembly folder is dropped when it looks like a project root.
        if (count($segments) > 1 && preg_match('/[A-Z]/', $segments[0]) && count($segments) > 2) {
            array_shift($segments);
        }

        return count($segments) > 1 ? $segments[0] : 'Root';
    }

    public function skipDirectories(): array
    {
        return self::SKIP;
    }

    public function extraSourceExtensions(): array
    {
        return ['cs', 'csproj', 'sln', 'razor', 'cshtml', 'xaml', 'props', 'targets'];
    }

    public function fileLanguage(string $path): ?string
    {
        return match (strtolower(pathinfo($path, PATHINFO_EXTENSION))) {
            'cs' => 'csharp',
            'cshtml', 'razor' => 'razor',
            'xaml' => 'xaml',
            'csproj', 'sln', 'props', 'targets' => 'msbuild',
            default => null,
        };
    }
}
