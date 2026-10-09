<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages;

use App\Enums\Language;

/**
 * Decides what kind of project a directory holds.
 *
 * Every profile scores the directory independently and the highest score wins,
 * so a .NET solution with a stray CMakeLists.txt still lands on C#, a C++
 * project that vendors a couple of C# tools still lands on C++, and a Django
 * project that ships a build script still lands on Python. A directory no
 * profile recognises returns null, which the extract stage reports honestly
 * instead of guessing.
 */
class ProfileRegistry
{
    /** @var array<string, LanguageProfile> */
    private array $profiles = [];

    public function __construct(
        LaravelProfile $laravel,
        CppProfile $cpp,
        CSharpProfile $csharp,
        PythonProfile $python,
    ) {
        foreach ([$laravel, $cpp, $csharp, $python] as $profile) {
            $this->profiles[$profile->language()->value] = $profile;
        }
    }

    /**
     * @return array{profile: LanguageProfile, confidence: int, scores: array<string, int>}|null
     */
    public function detect(string $root): ?array
    {
        $scores = [];

        foreach ($this->profiles as $key => $profile) {
            $scores[$key] = $profile->detect($root);
        }

        arsort($scores);

        $best = array_key_first($scores);
        $confidence = (int) $scores[$best];

        // Below this a "match" is noise — a stray .cs file in a docs folder
        // should not turn a project into a C# solution.
        if ($best === null || $confidence < 20) {
            return null;
        }

        return [
            'profile' => $this->profiles[$best],
            'confidence' => min(100, $confidence),
            'scores' => $scores,
        ];
    }

    /**
     * The most project-like directory at or below `$root`.
     *
     * GitHub's "Download ZIP" and Finder's "Compress" both wrap everything in a
     * single folder, and that wrapper tells us nothing: a C# solution then sits
     * one level down, where its .sln lives. This walks a bounded depth, scores
     * every candidate with the same profiles, and reports which directory won —
     * so callers can both pick the language *and* scan the right root.
     *
     * @return array{profile: LanguageProfile, confidence: int, scores: array<string, int>, directory: string}|null
     */
    public function detectWithin(string $root, int $maxDepth = 2, int $maxDirectories = 40): ?array
    {
        $best = $this->detect($root);
        $bestDirectory = $root;
        $bestScore = $best['confidence'] ?? 0;

        $queue = [[$root, 0]];
        $visited = 0;
        $skip = ['vendor', 'node_modules', 'build', 'bin', 'obj', 'dist', 'out', '.git',
            'third_party', 'third-party', 'packages', 'debug', 'release', '.vs', 'testresults'];

        while ($queue !== [] && $visited < $maxDirectories) {
            [$directory, $depth] = array_shift($queue);

            if ($depth >= $maxDepth) {
                continue;
            }

            foreach (@scandir($directory) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..' || $entry[0] === '.') {
                    continue;
                }

                $path = $directory.'/'.$entry;

                if (! is_dir($path) || in_array(strtolower($entry), $skip, true)) {
                    continue;
                }

                $visited++;
                $queue[] = [$path, $depth + 1];

                $result = $this->detect($path);

                if ($result !== null && $result['confidence'] > $bestScore) {
                    $best = $result;
                    $bestDirectory = $path;
                    $bestScore = $result['confidence'];
                }
            }
        }

        if ($best === null) {
            return null;
        }

        return $best + ['directory' => $bestDirectory];
    }

    public function for(Language $language): LanguageProfile
    {
        return $this->profiles[$language->value] ?? $this->profiles[Language::Php->value];
    }

    /** @return array<string, LanguageProfile> */
    public function all(): array
    {
        return $this->profiles;
    }
}
