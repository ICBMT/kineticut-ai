<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python\Stages;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Python\PythonIndex;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 9 of the Python pipeline — the templates a view renders.
 *
 * Django and Flask both end up in a folder called `templates`, and both say
 * what is inside in the same way: `{% extends "base.html" %}`,
 * `{% include "partials/nav.html" %}`. Those two tags are the entire template
 * inheritance tree of a Python web project, so reading them turns a directory
 * of HTML into a map.
 *
 * The link back to code is a string: `render(request, 'shop/index.html')`. It is
 * drawn as a `renders` edge from the function or class that calls it, which is
 * what makes the journey bar able to show request → view → template.
 */
class ViewStage implements Stage
{
    public function __construct(private readonly PythonIndex $index) {}

    public function name(): ScanStage
    {
        return ScanStage::Views;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $modules = $this->index->modules($context);

        $moduleKeys = $symbols['modules'] ?? [];

        $templates = $this->templates($context);
        $renders = 0;
        $includes = 0;

        // ---- the templates themselves ---------------------------------------
        foreach ($templates as $name => $template) {
            $key = 'view:'.$name;

            $graph->node($key, NodeType::View, $name, [
                'file' => $template['path'],
                'loc' => $template['lines'],
                'module' => $this->moduleFor($name),
                'layer' => Layer::View->value,
                'weight' => 55,
                'meta' => [
                    'view_name' => $name,
                    'engine' => $template['engine'],
                    'extends' => $template['extends'],
                    'includes' => $template['includes'],
                    'components' => [],
                    'livewire' => false,
                    'sections' => $template['blocks'],
                    'yields' => [],
                    'slots' => [],
                    'props' => [],
                    'routes' => [],
                    'language' => 'python',
                ],
            ]);

            foreach ($template['extends'] !== null ? [$template['extends']] : [] as $parent) {
                $parentName = $this->templateName($parent, $templates);

                if ($parentName === null) {
                    continue;
                }

                $graph->touch('view:'.$parentName, $parentName, [
                    'type' => NodeType::View->value,
                    'module' => $this->moduleFor($parentName),
                    'layer' => Layer::View->value,
                ]);
                $graph->edge($key, 'view:'.$parentName, EdgeKind::Includes, ['label' => 'extends']);
                $includes++;
            }

            foreach ($template['includes'] as $include) {
                $includeName = $this->templateName($include, $templates);

                if ($includeName === null) {
                    continue;
                }

                $graph->touch('view:'.$includeName, $includeName, [
                    'type' => NodeType::View->value,
                    'module' => $this->moduleFor($includeName),
                    'layer' => Layer::View->value,
                ]);
                $graph->edge($key, 'view:'.$includeName, EdgeKind::Includes, ['label' => '{% include %}']);
                $includes++;
            }
        }

        // ---- `render(request, 'shop/index.html')` ---------------------------
        foreach ($modules as $module) {
            $dotted = $module['module'];
            $moduleKey = $moduleKeys[$dotted] ?? null;

            foreach ($module['parsed']['calls'] ?? [] as $call) {
                if (! in_array(strtolower((string) ($call['name'] ?? '')), ['render', 'render_template', 'render_to_string', 'template'], true)) {
                    continue;
                }

                $name = $this->renderedTemplate((string) ($call['args'] ?? ''), $templates);

                if ($name === null) {
                    continue;
                }

                $from = $this->caller($module, $call, $symbols, $moduleKey);

                if ($from === null || ! $graph->has($from)) {
                    continue;
                }

                $graph->touch('view:'.$name, $name, [
                    'type' => NodeType::View->value,
                    'module' => $this->moduleFor($name),
                    'layer' => Layer::View->value,
                ]);
                $graph->edge($from, 'view:'.$name, EdgeKind::Renders, ['label' => 'renders']);
                $renders++;
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('views', [
            'views' => array_map(fn (array $template) => $template['path'], $templates),
            'templates' => array_keys($templates),
        ]);

        $context->log(sprintf(
            '%d templates · %d renders · %d inheritance links',
            count($templates),
            $renders,
            $includes,
        ));

        return [
            'summary' => sprintf('%d templates · %d rendered by views', count($templates), $renders),
            'metrics' => [
                'templates' => count($templates),
                'renders' => $renders,
                'includes' => $includes,
            ],
        ];
    }

    /**
     * Every `.html` / `.jinja` file under a templates folder, parsed for the two
     * tags that mean something structurally.
     *
     * @return array<string, array{path:string, engine:string, extends:?string, includes:array<int,string>, blocks:array<int,string>, lines:int}>
     */
    private function templates(ScanContext $context): array
    {
        $files = $context->readArtifact('files')['files'] ?? [];
        $templates = [];

        foreach ($files as $file) {
            $path = (string) ($file['path'] ?? '');
            $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));

            if (! in_array($extension, ['html', 'jinja', 'jinja2', 'j2', 'xml'], true)) {
                continue;
            }

            if (($file['size'] ?? 0) > 400_000) {
                continue;
            }

            $source = @file_get_contents($context->root.'/'.$path);

            if ($source === false || $source === '') {
                continue;
            }

            $name = $this->viewName($path);

            // A file outside a `templates` folder is a page only if it says so —
            // otherwise every README-ish HTML in the project would appear.
            $inTemplates = preg_match('#(^|/)templates/#', $path) === 1;
            $isJinja = in_array($extension, ['jinja', 'jinja2', 'j2'], true);

            if (! $inTemplates && ! $isJinja && ! str_contains($source, '{%')) {
                continue;
            }

            preg_match_all('/\{%-?\s*extends\s+[\'"]([^\'"]+)[\'"]/', $source, $extends);
            preg_match_all('/\{%-?\s*include\s+[\'"]([^\'"]+)[\'"]/', $source, $includes);
            preg_match_all('/\{%-?\s*block\s+([A-Za-z_][A-Za-z0-9_]*)/', $source, $blocks);

            $templates[$name] = [
                'path' => $path,
                'engine' => $isJinja ? 'jinja' : (str_contains($source, '{%') || str_contains($source, '{{') ? 'django' : 'html'),
                'extends' => $extends[1][0] ?? null,
                'includes' => array_values(array_unique($includes[1])),
                'blocks' => array_values(array_unique($blocks[1])),
                'lines' => substr_count($source, "\n") + 1,
            ];
        }

        return $templates;
    }

    /** `templates/shop/index.html` → `shop.index`. */
    private function viewName(string $path): string
    {
        $path = preg_replace('#^.*?templates/#', '', str_replace('\\', '/', $path)) ?? $path;
        $path = preg_replace('/\.(html|jinja2?|j2|xml)$/i', '', $path) ?? $path;

        return str_replace('/', '.', $path);
    }

    private function moduleFor(string $name): string
    {
        $segments = explode('.', $name);

        return count($segments) > 1 ? ucfirst($segments[0]) : 'Views';
    }

    /** Match a template reference to one of the templates on disk. */
    private function templateName(string $reference, array $templates): ?string
    {
        $reference = ltrim(trim($reference), '/');
        $candidate = preg_replace('/\.(html|jinja2?|j2|xml)$/i', '', $reference) ?? $reference;
        $candidate = str_replace('/', '.', $candidate);

        if (isset($templates[$candidate])) {
            return $candidate;
        }

        // A template rendered by its full path (`shop/templates/shop/index.html`).
        foreach ($templates as $name => $template) {
            if (str_ends_with($name, '.'.$candidate) || $template['path'] === $reference) {
                return $name;
            }
        }

        return null;
    }

    /** The template named by the second argument of `render(...)`. */
    private function renderedTemplate(string $arguments, array $templates): ?string
    {
        preg_match_all('/[\'"]([^\'"]+\.(?:html|jinja2?|j2|xml))[\'"]/', $arguments, $matches);

        foreach ($matches[1] as $reference) {
            $name = $this->templateName($reference, $templates);

            if ($name !== null) {
                return $name;
            }
        }

        return null;
    }

    /**
     * Who is doing the rendering: the method's class, the function, or the
     * module itself. A class-based Django view renders from its class node —
     * the same place a route points.
     */
    private function caller(array $module, array $call, array $symbols, ?string $moduleKey): ?string
    {
        $function = $call['function'] ?? null;

        if (is_string($function) && $function !== '' && isset($symbols['functions'][$module['module'].'.'.$function])) {
            return $symbols['functions'][$module['module'].'.'.$function];
        }

        $owner = $call['owner'] ?? null;

        if (is_string($owner) && $owner !== '' && isset($symbols['types'][$module['module'].'.'.$owner])) {
            return $symbols['types'][$module['module'].'.'.$owner];
        }

        return $moduleKey;
    }
}
