<?php

declare(strict_types=1);

namespace App\Services\Scan;

use App\Enums\Language;
use App\Enums\ScanStage as StageEnum;
use App\Services\Scan\Languages\Cxx\DeclarationParser;
use App\Services\Scan\Languages\Cxx\Stages\BuildStage;
use App\Services\Scan\Languages\Cxx\Stages\CallStage;
use App\Services\Scan\Languages\Cxx\Stages\DeclarationStage;
use App\Services\Scan\Languages\Cxx\Stages\FileIndexStage as CxxFileIndexStage;
use App\Services\Scan\Languages\Cxx\Stages\ReferenceStage;
use App\Services\Scan\Languages\Cxx\SymbolClassifier;
use App\Services\Scan\Languages\LanguageProfile;
use App\Services\Scan\Languages\Python\PythonIndex;
use App\Services\Scan\Languages\Python\PythonParser;
use App\Services\Scan\Languages\Python\PythonSymbolClassifier;
use App\Services\Scan\Languages\Python\Stages\BuildStage as PythonBuildStage;
use App\Services\Scan\Languages\Python\Stages\CallStage as PythonCallStage;
use App\Services\Scan\Languages\Python\Stages\DeclarationStage as PythonDeclarationStage;
use App\Services\Scan\Languages\Python\Stages\ModelStage as PythonModelStage;
use App\Services\Scan\Languages\Python\Stages\ReferenceStage as PythonReferenceStage;
use App\Services\Scan\Languages\Python\Stages\RouteStage as PythonRouteStage;
use App\Services\Scan\Languages\Python\Stages\ViewStage as PythonViewStage;
use App\Services\Scan\Languages\PythonProfile;
use App\Services\Scan\Languages\ProfileRegistry;
use App\Services\Scan\Parsers\BladeParser;
use App\Services\Scan\Parsers\MigrationParser;
use App\Services\Scan\Parsers\PhpFileAnalyzer;
use App\Services\Scan\Parsers\RouteParser;
use App\Services\Scan\Stages\ClassParseStage;
use App\Services\Scan\Stages\ExtractStage;
use App\Services\Scan\Stages\FileIndexStage;
use App\Services\Scan\Stages\InsightsStage;
use App\Services\Scan\Stages\LayoutStage;
use App\Services\Scan\Stages\LinkStage;
use App\Services\Scan\Stages\ManifestStage;
use App\Services\Scan\Stages\ModelStage;
use App\Services\Scan\Stages\RouteStage;
use App\Services\Scan\Stages\SchemaStage;
use App\Services\Scan\Stages\ViewStage;

/**
 * Assembles the right pipeline for a language.
 *
 * The stage list lives here, in one place, so it is impossible to get the order
 * wrong and easy to see what each language actually runs. The Laravel plan is
 * untouched by the C-family work: `Language::Php` builds exactly the stages it
 * always has.
 */
class ScanPipelineFactory
{
    /** @var array<string, ScanPipeline> */
    private array $pipelines = [];

    public function __construct(private readonly ProfileRegistry $registry) {}

    public function for(Language $language): ScanPipeline
    {
        return $this->pipelines[$language->value] ??= new ScanPipeline($this->stages($language));
    }

    /** @return array<int, Stage> */
    public function stages(Language $language): array
    {
        $profile = $this->registry->for($language);

        $stages = [new ExtractStage];

        foreach ($profile->plan() as $stage) {
            $stages[] = $this->stage($stage, $profile);
        }

        return $stages;
    }

    /** The stage list as enum values — handy for diagnostics and tests. */
    public function planNames(Language $language): array
    {
        return array_values(array_filter(array_map(
            fn (Stage $stage) => $stage->name()->value,
            $this->stages($language),
        )));
    }

    private function stage(StageEnum $stage, LanguageProfile $profile): Stage
    {
        $isPhp = $profile->language() === Language::Php;
        $isPython = $profile->language() === Language::Python;

        return match ($stage) {
            // ---- Laravel ----------------------------------------------------
            StageEnum::Files => $isPhp
                ? new FileIndexStage(new ClassClassifier)
                : new CxxFileIndexStage($profile),
            StageEnum::Manifest => new ManifestStage,
            StageEnum::Classes => new ClassParseStage(new PhpFileAnalyzer, new ClassClassifier),
            StageEnum::Routes => $isPython
                ? new PythonRouteStage(new PythonIndex(new PythonParser))
                : new RouteStage(new RouteParser),
            StageEnum::Models => $isPython
                ? new PythonModelStage(new PythonIndex(new PythonParser))
                : new ModelStage,
            StageEnum::Schema => new SchemaStage(new MigrationParser),
            StageEnum::Views => $isPython
                ? new PythonViewStage(new PythonIndex(new PythonParser))
                : new ViewStage(new BladeParser),
            StageEnum::Links => new LinkStage,

            // ---- Python -----------------------------------------------------
            StageEnum::Build => $isPython ? new PythonBuildStage(new PythonIndex(new PythonParser)) : new BuildStage,
            StageEnum::Declarations => $isPython
                ? new PythonDeclarationStage(new PythonIndex(new PythonParser), new PythonSymbolClassifier)
                : new DeclarationStage($profile, new DeclarationParser, new SymbolClassifier),
            StageEnum::References => $isPython
                ? new PythonReferenceStage(new PythonIndex(new PythonParser))
                : new ReferenceStage($profile),
            StageEnum::Calls => $isPython ? new PythonCallStage : new CallStage($profile),

            // ---- Shared -----------------------------------------------------
            StageEnum::Insights => new InsightsStage,
            StageEnum::Layout => new LayoutStage,
            default => throw new \RuntimeException('No stage implementation for '.$stage->value),
        };
    }
}
