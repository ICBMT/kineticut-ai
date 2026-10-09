<?php

declare(strict_types=1);

namespace App\Services\Scan\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Parsers\BladeParser;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;
use Illuminate\Support\Str;

/**
 * Stage 7 — the presentation layer: Blade views, layout inheritance, includes,
 * anonymous components and Livewire components, linked both ways.
 */
class ViewStage implements Stage
{
    public function __construct(private readonly BladeParser $parser) {}

    public function name(): ScanStage
    {
        return ScanStage::Views;
    }

    public function run(ScanContext $context): array
    {
        $index = $context->readArtifact('files');
        $graph = $this->freshGraph($context);

        $blade = array_values(array_filter(
            $index['files'] ?? [],
            fn (array $file) => str_ends_with($file['path'], '.blade.php') || str_ends_with($file['path'], '.twig')
        ));

        $views = [];
        $components = 0;
        $includes = 0;

        foreach ($blade as $file) {
            $name = BladeParser::viewNameFromPath($file['path']);
            $isComponent = str_starts_with($name, 'components.');
            $isLivewireView = str_starts_with($name, 'livewire.');

            $parsed = $this->parser->parse($context->root.'/'.$file['path'], $file['path'], $name);

            $key = 'view:'.$name;
            $type = $isComponent ? NodeType::Component : NodeType::View;

            $graph->node($key, $type, $this->labelFor($name), [
                'file' => $file['path'],
                'loc' => $parsed['loc'] ?? $file['lines'],
                'module' => $this->moduleForView($name),
                'layer' => Layer::View->value,
                'weight' => $isComponent ? 40 : 55,
                'meta' => [
                    'view_name' => $name,
                    'extends' => $parsed['extends'],
                    'includes' => $parsed['includes'],
                    'components' => $parsed['components'],
                    'livewire' => $parsed['livewire'],
                    'sections' => $parsed['sections'],
                    'yields' => $parsed['yields'],
                    'slots' => $parsed['slots'],
                    'props' => $parsed['props'],
                    'routes' => $parsed['routes'],
                    'gates' => $parsed['gates'],
                    'variables' => $parsed['variables'],
                    'is_component' => $isComponent,
                    'is_livewire_view' => $isLivewireView,
                ],
            ]);

            $views[$name] = $parsed;
            $isComponent && $components++;

            foreach (array_merge($parsed['extends'], $parsed['includes']) as $parent) {
                if (! is_string($parent) || $parent === '') {
                    continue;
                }
                $graph->touch('view:'.$parent, $this->labelFor($parent), [
                    'type' => NodeType::View->value,
                    'module' => $this->moduleForView($parent),
                    'layer' => Layer::View->value,
                ]);
                $graph->edge($key, 'view:'.$parent, EdgeKind::Includes, ['label' => '@extends/@include']);
                $includes++;
            }

            foreach ($parsed['components'] as $component) {
                $componentName = 'components.'.str_replace('/', '.', $component);
                $graph->touch('view:'.$componentName, $this->labelFor($componentName), [
                    'type' => NodeType::Component->value,
                    'module' => 'Views/Components',
                    'layer' => Layer::View->value,
                ]);
                $graph->edge($key, 'view:'.$componentName, EdgeKind::Includes, ['label' => '<x-'.$component.'>']);
                $includes++;
            }

            foreach ($parsed['livewire'] as $livewire) {
                $graph->touch('livewire:'.$livewire, $livewire, [
                    'type' => NodeType::Livewire->value,
                    'module' => 'Livewire',
                    'layer' => Layer::View->value,
                ]);
                $graph->edge($key, 'livewire:'.$livewire, EdgeKind::Includes, ['label' => '<livewire:'.$livewire.'>']);
            }
        }

        $this->linkLivewireClasses($context, $graph);

        $graph->pruneAndScore();
        $context->persistGraph($graph);
        $context->writeArtifact('views', ['views' => $views]);

        $context->log(sprintf(
            'Discovered %s Blade views (%s components) with %s include links',
            number_format(count($blade)),
            number_format($components),
            number_format($includes)
        ));

        return [
            'summary' => sprintf('%s views · %s components · %s includes', number_format(count($blade)), number_format($components), number_format($includes)),
            'metrics' => ['views' => count($blade), 'view_components' => $components, 'view_includes' => $includes],
        ];
    }

    /**
     * Livewire classes live in app/Livewire but render a Blade view — connect
     * the class node to its template so the two halves read as one component.
     */
    private function linkLivewireClasses(ScanContext $context, GraphBuilder $graph): void
    {
        foreach ($graph->nodes() as $key => $node) {
            if (($node['type'] ?? '') !== NodeType::Livewire->value) {
                continue;
            }

            $class = $node['fqcn'] ?? null;

            if (! $class) {
                continue;
            }

            $expected = 'livewire.'.Str::of(class_basename($class))->kebab()->replace('/', '.')->value();

            if ($graph->has('view:'.$expected)) {
                $graph->edge($key, 'view:'.$expected, EdgeKind::Renders, ['label' => 'renders']);
            }
        }
    }

    private function labelFor(string $viewName): string
    {
        return Str::of($viewName)->afterLast('.')->headline()->value() ?: $viewName;
    }

    private function moduleForView(string $name): string
    {
        $segments = explode('.', $name);

        return 'Views'.(count($segments) > 1 ? '/'.Str::headline($segments[0]) : '');
    }

    private function freshGraph(ScanContext $context): GraphBuilder
    {
        $graph = new GraphBuilder;
        $payload = $context->readArtifact('graph');

        foreach ($payload['nodes'] ?? [] as $node) {
            $graph->node($node['key'], NodeType::tryFrom($node['type']) ?? NodeType::PhpClass, $node['label'], $node);
        }
        foreach ($payload['edges'] ?? [] as $edge) {
            $graph->edge($edge['source'], $edge['target'], EdgeKind::tryFrom($edge['kind']) ?? EdgeKind::Uses, $edge);
        }

        return $graph;
    }
}
