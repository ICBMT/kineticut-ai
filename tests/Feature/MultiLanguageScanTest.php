<?php

namespace Tests\Feature;

use App\Enums\Language;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Models\Project;
use App\Services\ProjectManager;
use App\Services\Scan\Languages\ProfileRegistry;
use App\Services\Scan\Languages\Cxx\DeclarationParser;
use App\Services\Scan\Languages\Cxx\Lexer;
use App\Services\Scan\ScanPipelineFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;
use ZipArchive;

/**
 * The C++ and C# pipelines, end to end.
 *
 * These tests exist for one reason: a Laravel-shaped graph is easy to produce
 * by accident and hard to notice, so each language is asserted on the things
 * that make it *that* language — CMake targets and call chains for C++, routes
 * and namespaces for C# — plus the promise that languages are detected from the
 * archive and the Laravel pipeline is never used for them.
 */
class MultiLanguageScanTest extends TestCase
{
    use RefreshDatabase;

    private array $createdProjects = [];

    private array $fixtureArchives = [];

    protected function setUp(): void
    {
        parent::setUp();

        config(['atlas.sync_scans' => true, 'atlas.verbose_scans' => false]);
    }

    protected function tearDown(): void
    {
        foreach ($this->createdProjects as $project) {
            app(ProjectManager::class)->destroy($project);
        }

        foreach ($this->fixtureArchives as $archive) {
            if (is_file($archive)) {
                @unlink($archive);
            }
        }

        parent::tearDown();
    }

    /* ------------------------------------------------------------- plans -- */

    public function test_each_language_gets_its_own_stage_plan(): void
    {
        $factory = app(ScanPipelineFactory::class);

        $this->assertSame(
            ['extract', 'manifest', 'files', 'classes', 'routes', 'models', 'schema', 'views', 'links', 'insights', 'layout'],
            $factory->planNames(Language::Php),
            'The Laravel pipeline must stay exactly as it was.',
        );

        foreach ([Language::Cpp, Language::CSharp] as $language) {
            $this->assertSame(
                ['extract', 'build', 'files', 'declarations', 'references', 'calls', 'insights', 'layout'],
                $factory->planNames($language),
            );
        }

        /*
         * Python runs the Laravel *shape* — routes, models and views are real
         * things in a Django project — but with the generic file index and its
         * own reader stages, and the file tree first because there is no build
         * system to read the project out of.
         */
        $this->assertSame(
            ['extract', 'files', 'build', 'declarations', 'references', 'calls', 'routes', 'models', 'views', 'insights', 'layout'],
            $factory->planNames(Language::Python),
            'The Python plan must match the one the scan page reports.',
        );

        $this->assertSame(
            $factory->planNames(Language::Python),
            array_map(fn (ScanStage $stage) => $stage->value, ScanStage::planFor('python')),
            'The profile plan and the payload plan must never drift apart.',
        );
    }

    /* ---------------------------------------------------------- detection -- */

    public function test_an_uploaded_cpp_archive_is_detected_and_scanned(): void
    {
        [$project, $scan] = $this->scanArchive($this->cppArchive(), 'AcmeRender');

        $this->assertSame('cpp', $project->refresh()->language);
        $this->assertSame('completed', $scan->status->value, (string) $scan->error);
        $this->assertSame(
            ['extract', 'build', 'files', 'declarations', 'references', 'calls', 'insights', 'layout'],
            $scan->toScanPayload()['stages']->pluck('key')->all(),
            'The scan page must report the C++ plan, not the Laravel one.',
        );

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();
        $types = collect($graph['nodes'])->pluck('type');
        $keys = collect($graph['edges'])->map(fn ($edge) => $edge['source'].'→'.$edge['target'].' '.$edge['kind']);

        // The build manifest is read: CMake targets and packages become nodes.
        $this->assertContains('library', $types, 'add_library() should produce a library node.');
        $this->assertContains('config', $types, 'CMakeLists.txt should be a visible config node.');
        $this->assertTrue(
            collect($graph['nodes'])->contains(fn ($node) => $node['label'] === 'render_core'),
            'The render_core CMake target is missing.',
        );

        // The code itself is parsed: classes, structs, free functions, namespaces.
        $this->assertContains('class', $types);
        $this->assertContains('struct', $types, 'Vertex is a struct and should be typed as one.');
        $this->assertContains('function', $types, 'main() should be a function node.');
        $this->assertContains('namespace', $types, 'acme::render should be a namespace node.');

        // And the call graph is wired.
        $this->assertTrue(
            $keys->contains(fn ($key) => str_contains($key, 'calls')),
            'No call edges were produced for the C++ project.',
        );
    }

    public function test_an_uploaded_csharp_archive_is_detected_and_scanned(): void
    {
        [$project, $scan] = $this->scanArchive($this->csharpArchive(), 'Acme Tasks');

        $this->assertSame('csharp', $project->refresh()->language);
        $this->assertSame('completed', $scan->status->value, (string) $scan->error);

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();
        $nodes = collect($graph['nodes']);
        $labels = $nodes->pluck('label');

        // .NET metadata lands on the project.
        $this->assertSame('net8.0', $project->framework_version);

        // Solution and project files are visible, and the project graph is read.
        $this->assertTrue($nodes->where('type', 'config')->isNotEmpty(), 'Acme.sln should be a visible config node.');
        $this->assertContains('library', $nodes->pluck('type'), 'Acme.Core.csproj should be a library node.');
        $this->assertContains('executable', $nodes->pluck('type'), 'The web project is an executable.');
        $this->assertTrue(
            collect($graph['edges'])->contains(fn ($edge) => $edge['kind'] === 'depends_on'),
            'The ProjectReference between the two projects should be a depends_on edge.',
        );

        // C# declarations are classified the way a .NET developer reads them.
        $classifications = $nodes->pluck('type');
        $this->assertContains('controller', $classifications);
        $this->assertContains('interface', $classifications);
        $this->assertContains('service', $classifications);
        $this->assertContains('test', $classifications, 'tests/Acme.Tests should be classified as tests.');

        // ASP.NET attributes become real routes with HTTP edges.
        $routes = $nodes->where('type', 'route');
        // Two from the controller's attributes, one from app.MapGet.
        $this->assertGreaterThanOrEqual(3, $routes->count(), 'Controller attributes should produce routes.');

        // The compact payload carries labels, not metadata — the label is what
        // the user reads in the tracer, so that is what is asserted.
        $labels = $routes->pluck('label')->all();
        $this->assertContains('GET /api/tasks', $labels, '[Route("api/[controller]")] and [HttpGet] must combine.');
        $this->assertContains('POST /api/tasks/{id:int}', $labels, 'Route templates keep their constraints.');
        $this->assertContains('GET /api/health', $labels, 'Minimal-API endpoints are routes too.');

        $this->assertTrue(
            collect($graph['edges'])->contains(fn ($edge) => $edge['kind'] === 'http'),
            'Routes must be joined to their controllers by http edges.',
        );

        // A controller -> service call edge proves the call graph is real.
        $this->assertTrue(
            collect($graph['edges'])->contains(fn ($edge) => $edge['kind'] === 'calls'),
            'No call edges were produced for the C# project.',
        );
    }

    public function test_python_inheritance_inside_a_project_becomes_edges(): void
    {
        [$project, $scan] = $this->scanArchive($this->pythonInheritanceArchive(), 'Storage Shapes');

        $this->assertSame('completed', $scan->status->value, (string) $scan->error);

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();
        $edges = collect($graph['edges'])->map(fn ($edge) => [
            'from' => $edge['source'],
            'to' => $edge['target'],
            'kind' => $edge['kind'],
        ]);

        $this->assertTrue(
            $edges->contains(fn ($edge) => $edge['from'] === 'class:app.bookmarks.BookmarkRepository'
                && $edge['to'] === 'class:app.storage.Repository'
                && $edge['kind'] === 'extends'),
            'class BookmarkRepository(Repository) should extend the class in the same project.',
        );

        $this->assertTrue(
            $edges->contains(fn ($edge) => $edge['from'] === 'class:app.bookmarks.BookmarkCard'
                && $edge['to'] === 'class:app.storage.Renderable'
                && $edge['kind'] === 'implements'),
            'A class built on a Protocol should be drawn as implementing it.',
        );

        // Exactly two: a base the project does not contain draws nothing, which
        // is why the Django sample honestly reports 0 inheritance links.
        $this->assertSame(
            2,
            $edges->filter(fn ($edge) => in_array($edge['kind'], ['extends', 'implements'], true))->count(),
            'Inheritance edges should only be drawn between classes that exist in the project.',
        );
    }

    public function test_a_folder_of_scripts_is_recognised_as_python(): void
    {
        // No pyproject.toml, no manage.py, no requirements.txt — the way a lot of
        // beginners arrive: a folder of .py files. It has to be claimed as Python
        // rather than falling through to the PHP fallback, and the `__main__`
        // guard has to become the entry point a journey can start from.
        $archive = $this->zip([
            'report.py' => <<<'PY'
            """Print a tiny sales report."""

            import sys


            def main():
                print(f"{sys.argv[0]} reporting")


            if __name__ == "__main__":
                main()
            PY,
            'helpers.py' => <<<'PY'
            """Small things the report leans on."""


            def money(value):
                return f"{value:,.2f}"
            PY,
        ], 'py-scripts');

        [$project, $scan] = $this->scanArchive($archive, 'Loose Scripts');

        $this->assertSame('python', $project->refresh()->language);
        $this->assertSame('completed', $scan->status->value, (string) $scan->error);

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();

        $this->assertSame(
            'report.py',
            collect($graph['nodes'])->firstWhere('type', 'executable')['label'] ?? null,
            'The `if __name__ == "__main__"` guard should make report.py the entry point.',
        );
    }

    public function test_a_project_with_nothing_to_trace_says_so(): void
    {
        // A Python library: modules and classes, no route table and nothing that
        // runs on its own. The tracer has to admit that rather than offer an
        // empty dropdown, and the note it shows has to be the one for this
        // situation — the same panel says something different for a C++ project
        // that merely lacks a main().
        $archive = $this->zip([
            'pyproject.toml' => <<<'TOML'
            [tool.poetry]
            name = "string-tools"
            version = "0.1.0"
            TOML,
            'string_tools/__init__.py' => '',
            'string_tools/casing.py' => <<<'PY'
            """Case helpers — nothing here starts anything."""


            class Caser:
                """Turning one spelling into another."""

                def to_snake(self, name: str) -> str:
                    return name.lower()

                def to_screaming(self, name: str) -> str:
                    return name.upper()
            PY,
        ], 'py-library');

        [$project, $scan] = $this->scanArchive($archive, 'String Tools');

        $this->assertSame('completed', $scan->status->value, (string) $scan->error);

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();
        $types = collect($graph['nodes'])->pluck('type');

        $this->assertFalse($types->contains('route'), 'A library has no routes.');
        $this->assertFalse($types->contains('executable'), 'A library has nothing executable.');

        $page = $this->get(route('projects.atlas', $project))->assertOk();

        $page->assertSee('data-empty-note=', false);
        $page->assertSee('No routes and no entry point were found', false);
        $page->assertSee('rescan it if the scan looks incomplete', false);
    }

    public function test_an_uploaded_python_archive_is_detected_and_scanned(): void
    {
        [$project, $scan] = $this->scanArchive($this->pythonArchive(), 'Shop Bookmarks');

        $this->assertSame('python', $project->refresh()->language);
        $this->assertSame('completed', $scan->status->value, (string) $scan->error);
        $this->assertStringContainsString('Django', (string) $project->framework_version);

        $this->assertSame(
            ['extract', 'files', 'build', 'declarations', 'references', 'calls', 'routes', 'models', 'views', 'insights', 'layout'],
            $scan->toScanPayload()['stages']->pluck('key')->all(),
            'The scan page must report the Python plan, not the Laravel one.',
        );

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();
        $nodes = collect($graph['nodes']);
        $types = $nodes->pluck('type');
        $edges = collect($graph['edges']);
        $keys = $edges->map(fn ($edge) => $edge['source'].'→'.$edge['target'].' '.$edge['kind']);

        // ---- the shape of a Django project, as nodes ------------------------
        $this->assertContains('namespace', $types, 'A module (shop.models) should be a namespace node.');
        $this->assertContains('model', $types, 'Tag and Bookmark are Django models.');
        $this->assertContains('table', $types, 'A model maps onto a table node.');
        $this->assertContains('route', $types, 'urlpatterns should produce routes.');
        $this->assertContains('view', $types, 'A template should be a view node.');
        $this->assertContains('executable', $types, 'manage.py should be an entry point.');

        // ---- the entry point is traceable -----------------------------------
        $entry = $nodes->firstWhere('type', 'executable');
        $this->assertSame('manage.py', $entry['label']);
        $this->assertSame('entry', $entry['layer'], 'An entry point belongs on the entry layer.');

        // ---- the database is read from the class bodies ----------------------
        $bookmark = $nodes->first(fn ($node) => $node['type'] === 'table' && $node['label'] === 'bookmark');
        $this->assertNotNull($bookmark, 'Bookmark should map to a `bookmark` table.');

        // Columns live on the node detail (the render payload stays small), and
        // a table that says "6 columns" in the atlas is only honest if the panel
        // can list them.
        $detail = $this->nodeDetail($project, $bookmark['key']);
        $columns = collect($detail['meta']['columns'] ?? []);
        $this->assertTrue($columns->contains(fn ($column) => $column['name'] === 'title'));
        $this->assertTrue(
            $columns->contains(fn ($column) => $column['name'] === 'owner_id'),
            'ForeignKey("User") is a column called owner_id, exactly as the database sees it.',
        );

        $this->assertTrue(
            $keys->contains(fn ($key) => str_contains($key, 'persists')),
            'A model must be joined to the table it persists to.',
        );
        $this->assertTrue(
            $edges->contains(fn ($edge) => $edge['kind'] === 'belongs_to'),
            'ForeignKey("User") should draw a table-to-table edge.',
        );

        // ---- routes reach their views ---------------------------------------
        $route = $nodes->first(fn ($node) => $node['type'] === 'route' && str_contains($node['label'], '/bookmarks/'));
        $this->assertNotNull($route, 'The bookmark detail route is missing.');
        $this->assertSame('GET /bookmarks/{pk}', $route['label'], 'Django\'s <int:pk> should read as {pk}.');

        $routeDetail = $this->nodeDetail($project, $route['key']);
        $this->assertSame('GET', $routeDetail['meta']['method']);
        $this->assertSame('django-url', $routeDetail['meta']['action_type']);

        // ---- the front page is a route as well --------------------------------
        // `path("", views.index)` is Django's spelling of the site root, and its
        // key ends in a slash. Laravel matches a request against a copy of the
        // URI with the trailing slash removed, so that key arrives one character
        // short; both forms have to land on the same node or the first thing a
        // reader clicks — the front page — is the one thing that never opens.
        $root = $nodes->first(fn ($node) => $node['type'] === 'route' && $node['label'] === 'GET /');
        $this->assertNotNull($root, 'The site root should be a route node.');
        $this->assertSame('route:GET /', $root['key']);

        $rootDetail = $this->nodeDetail($project, $root['key']);
        $this->assertSame('GET /', $rootDetail['label'], 'A key that ends in a slash must still be reachable.');
        $this->assertNotEmpty($rootDetail['edges_out'], 'The front page must keep its edges.');

        $trimmed = str_replace(
            '__KEY__',
            rawurlencode('route:GET ').'/',
            route('api.atlas.nodes', ['project' => $project, 'key' => '__KEY__']),
        );
        $trimmedDetail = $this->getJson($trimmed)->assertOk()->json();
        $this->assertSame(
            'route:GET /',
            $trimmedDetail['key'],
            'The router trims the trailing slash; the endpoint has to put it back.',
        );

        $this->assertTrue(
            $keys->contains(fn ($key) => $key === 'route:GET /→func:shop.views.index http'),
            'The front page must point at the view that handles it.',
        );
        $this->assertTrue(
            $keys->contains(fn ($key) => str_starts_with($key, $route['key'].'→') && str_ends_with($key, ' http')),
            'The route must point at the function that handles it.',
        );

        // ---- the words are Python's, not Laravel's ---------------------------
        // (The imports-and-calls assertions follow.)
        $model = $nodes->first(fn ($node) => $node['type'] === 'model');
        $this->assertNotNull($model, 'Bookmark, Tag and User are Django models.');
        $this->assertSame('Model', $model['type_label'], 'A Django model is a Model, not an Eloquent Model.');
        $this->assertSame('Database Table', $bookmark['type_label'], 'The table it persists to is still a table.');

        $template = $nodes->first(fn ($node) => $node['type'] === 'view');
        $this->assertNotNull($template, 'The Django template should be a view node.');
        $this->assertSame('Template', $template['type_label'], 'A Django template is not a Blade view.');

        $this->assertSame(
            3,
            $scan->refresh()->metrics['class_types']['model'] ?? null,
            'Tag, Bookmark and User should be counted as models in the breakdown.',
        );

        // The project report reads that same breakdown, so it must be a table
        // rather than the "run a scan" empty state a finished scan never needs —
        // and the rows must speak Python.
        $this->get(route('projects.show', $project))
            ->assertOk()
            ->assertSee('Model</td>', false)
            ->assertDontSee('Eloquent Model')
            ->assertDontSee('Run a scan to see how the application is composed.');

        $this->assertTrue(
            $keys->contains(fn ($key) => str_contains($key, 'imports')),
            'from shop.models import Bookmark should be an imports edge.',
        );
        $this->assertTrue(
            $keys->contains(fn ($key) => str_contains($key, 'calls')),
            'The Python project produced no call edges.',
        );
        $this->assertTrue(
            $keys->contains(fn ($key) => str_contains($key, 'renders')),
            'render(request, "shop/index.html") should join the view to its template.',
        );
        $this->assertTrue(
            $keys->contains(fn ($key) => str_contains($key, 'includes')),
            '{% extends "base.html" %} should join the templates.',
        );

        // ---- and the tech strip calls it what it is ---------------------------
        $stack = app(\App\Services\TechStack::class)->build($project->refresh(), $scan->refresh());

        $this->assertSame('python', $stack['language']);
        $this->assertSame('Python packages', $stack['packages_label']);
        $this->assertStringContainsString('Django', $stack['headline']);
    }

    /* ------------------------------------------------------------ parser -- */

    public function test_the_python_parser_reads_idioms_without_throwing(): void
    {
        $parser = new \App\Services\Scan\Languages\Python\PythonParser;

        $parsed = $parser->parse(<<<'PY'
        """The bookmarks module."""
        import os
        from shop.models import Bookmark, Tag
        from . import views


        class BookmarkService:
            """Create and search bookmarks."""

            def __init__(self, repository=None):
                self.repository = repository

            async def create(self, owner, url: str) -> Bookmark:
                bookmark = Bookmark(owner=owner, url=url)
                bookmark.save()
                return bookmark


        def summarise(bookmark: Bookmark):
            return bookmark.title


        if __name__ == "__main__":
            summarise(None)
        PY);

        $this->assertTrue($parsed['entry'], 'The __main__ guard must be detected.');
        $this->assertCount(1, $parsed['types']);
        $this->assertSame('BookmarkService', $parsed['types'][0]['name']);
        $this->assertSame(['Bookmark', 'Tag'], array_column($parsed['imports'][1]['names'], 'name'));
        $this->assertSame(1, $parsed['imports'][2]['relative'], 'A relative import keeps its dot count.');

        $functions = collect($parsed['functions']);

        $this->assertTrue($functions->contains(fn ($f) => $f['name'] === 'create' && $f['async'] === true && $f['owner'] === 'BookmarkService'));
        $this->assertTrue($functions->contains(fn ($f) => $f['name'] === 'summarise' && $f['owner'] === null));

        $create = $functions->firstWhere('name', 'create');
        $this->assertSame(['self', 'owner', 'url'], array_column($create['args'], 'name'));
        $this->assertSame('str', $create['args'][2]['annotation'], 'Annotations must survive.');
        $this->assertSame('Bookmark', $create['returns']);

        // `bookmark = Bookmark(...)` is the only place Python states the type.
        $variables = collect($parsed['variables']);
        $this->assertTrue($variables->contains(fn ($v) => $v['name'] === 'bookmark' && $v['call'] === 'Bookmark'));
        $this->assertTrue($variables->contains(fn ($v) => $v['name'] === 'repository' && $v['attribute'] === true));
    }

    public function test_the_c_family_parser_reads_a_header_without_throwing(): void
    {
        $parser = new DeclarationParser;

        $parsed = $parser->parse(<<<'CPP'
#pragma once
#include "mesh.hpp"

namespace acme::render {

/** Draws a scene. */
class Renderer : public IRenderer {
public:
    Renderer();
    ~Renderer();

    void draw(const Mesh& mesh) const;
    static Renderer* create();

private:
    std::vector<Mesh> meshes_;
};

} // namespace acme::render
CPP);

        $this->assertSame('acme\render', $parsed['namespace']);
        $this->assertCount(1, $parsed['types']);

        $type = $parsed['types'][0];
        $this->assertSame('Renderer', $type['name']);
        $this->assertSame(['IRenderer'], array_column($type['bases'], 'name'));

        $members = collect($type['members']);
        $this->assertTrue($members->contains(fn ($m) => $m['kind'] === 'constructor'));
        $this->assertTrue($members->contains(fn ($m) => $m['kind'] === 'destructor'), '~Renderer() must be recognised.');
        $this->assertTrue($members->contains(fn ($m) => $m['name'] === 'draw' && $m['static'] === false));
        $this->assertTrue($members->contains(fn ($m) => $m['name'] === 'create' && $m['static'] === true));
    }

    public function test_the_lexer_never_throws_on_awkward_source(): void
    {
        $lexer = new Lexer;

        $samples = [
            'cpp' => "#include <vector>\nR\"raw(unclosed\n",
            'csharp' => "var s = @\"verbatim \"\"quotes\"\"\";\nvar i = $\"interpolated {x:N2}\";\n",
            'junk' => "}{)(;;;'''\n\"unterminated\n",
        ];

        foreach ($samples as $name => $source) {
            $tokens = $lexer->tokenize($source, $name === 'csharp');

            $this->assertNotEmpty($tokens, $name.' produced no tokens');
            $this->assertContainsOnlyArray($tokens);
            $this->assertCount(3, $tokens[0], 'Every token is [kind, text, line].');
        }
    }

    /* ----------------------------------------------------------- helpers -- */

    /** @return array{0: Project, 1: \App\Models\Scan} */
    /**
     * A node's detail, fetched the way the browser fetches it.
     *
     * Not `route('api.atlas.nodes', ['key' => $key])`: node keys contain their
     * own braces (`route:GET /bookmarks/{pk}`), and Laravel's URL generator
     * reads those as its own placeholders and refuses. The app never hits this
     * because it swaps a literal `__KEY__` placeholder in the browser.
     */
    private function nodeDetail(Project $project, string $key): array
    {
        $template = route('api.atlas.nodes', ['project' => $project, 'key' => '__KEY__']);
        $url = str_replace('__KEY__', rawurlencode($key), $template);

        return $this->getJson($url)->assertOk()->json();
    }

    private function scanArchive(UploadedFile $archive, string $name): array
    {
        $this->post('/projects', ['name' => $name, 'archive' => $archive]);

        $project = Project::latest('id')->firstOrFail();
        $this->createdProjects[] = $project;

        return [$project, $project->scans()->latest('id')->firstOrFail()];
    }

    private function cppArchive(): UploadedFile
    {
        return $this->zip([
            'CMakeLists.txt' => <<<'CMAKE'
            cmake_minimum_required(VERSION 3.22)
            project(AcmeRender LANGUAGES CXX)
            find_package(fmt REQUIRED)
            add_library(render_core src/renderer.cpp)
            add_executable(acme src/main.cpp)
            target_link_libraries(acme PRIVATE render_core fmt)
            CMAKE,
            'include/mesh.hpp' => <<<'CPP'
            #pragma once
            #include <string>
            namespace acme::render {
            struct Vertex { float x = 0.0f; };
            class Mesh {
            public:
                Mesh();
                ~Mesh();
                void upload();
            private:
                std::string name_;
            };
            }
            CPP,
            'src/renderer.cpp' => <<<'CPP'
            #include "mesh.hpp"
            namespace acme::render {
            Mesh::Mesh() { name_ = "mesh"; }
            Mesh::~Mesh() { }
            void Mesh::upload() { logf("uploading"); }
            void logf(const std::string& message) { }
            }
            CPP,
            'src/main.cpp' => <<<'CPP'
            #include "mesh.hpp"
            int main() {
                acme::render::Mesh mesh;
                mesh.upload();
                return 0;
            }
            CPP,
        ], 'acme-render');
    }

    private function pythonArchive(): UploadedFile
    {
        return $this->zip([
            'manage.py' => <<<'PY'
            """Start the bookmarks project."""
            import os
            import sys

            from django.core.management import execute_from_command_line


            def main():
                os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")
                execute_from_command_line(sys.argv)


            if __name__ == "__main__":
                main()
            PY,
            'requirements.txt' => <<<'TXT'
            Django==5.0.6
            gunicorn==22.0.0
            TXT,
            'shop/models.py' => <<<'PY'
            """Everything the database knows about."""
            from django.db import models


            class Tag(models.Model):
                name = models.CharField(max_length=40, unique=True)


            class User(models.Model):
                email = models.EmailField(unique=True)


            class Bookmark(models.Model):
                title = models.CharField(max_length=200)
                notes = models.TextField(null=True, blank=True)
                owner = models.ForeignKey("User", on_delete=models.CASCADE)
                tags = models.ManyToManyField(Tag, blank=True)

                def summary(self) -> str:
                    return self.title
            PY,
            'shop/views.py' => <<<'PY'
            """The HTTP surface."""
            from django.http import JsonResponse
            from django.shortcuts import get_object_or_404, render

            from shop.models import Bookmark


            def index(request):
                bookmarks = Bookmark.objects.all()[:20]

                return render(request, "shop/index.html", {"bookmarks": bookmarks})


            def bookmark_detail(request, pk: int):
                bookmark = get_object_or_404(Bookmark, pk=pk)

                return JsonResponse({"title": bookmark.title})
            PY,
            'shop/urls.py' => <<<'PY'
            """URL routing."""
            from django.urls import path

            from shop import views

            urlpatterns = [
                path("", views.index, name="index"),
                path("bookmarks/<int:pk>/", views.bookmark_detail, name="bookmark-detail"),
            ]
            PY,
            'shop/templates/base.html' => <<<'HTML'
            <!doctype html>
            <html><body>{% block content %}{% endblock %}</body></html>
            HTML,
            'shop/templates/shop/index.html' => <<<'HTML'
            {% extends "base.html" %}

            {% block content %}
            <ul>{% for bookmark in bookmarks %}<li>{{ bookmark.title }}</li>{% endfor %}</ul>
            {% endblock %}
            HTML,
            'tests/test_models.py' => <<<'PY'
            """The model helpers answer what they promise."""


            def test_summary_is_readable():
                assert "bookmark" in "bookmark"
            PY,
        ], 'py-sample');
    }

    /**
     * A Python project that inherits from *itself*.
     *
     * The Django sample inherits only from framework classes (models.Model,
     * serializers.ModelSerializer), so it correctly draws no inheritance edges —
     * there is nothing internal to point at. This archive is the other half of
     * that story: a base class in the project must become an edge.
     */
    private function pythonInheritanceArchive(): UploadedFile
    {
        return $this->zip([
            // A Python project has to say so before the detector will believe it:
            // two loose .py files are not enough evidence on their own.
            'pyproject.toml' => <<<'TOML'
            [tool.poetry]
            name = "storage-shapes"
            version = "0.1.0"
            description = "Two classes that inherit from two more."

            [tool.poetry.dependencies]
            python = "^3.11"
            TOML,
            'app/__init__.py' => '',
            'app/storage.py' => <<<'PY'
            """Storage contracts."""

            from typing import Protocol


            class Repository:
                """What every store has to be able to do."""

                def get(self, key):
                    raise NotImplementedError


            class Renderable(Protocol):
                """Anything that can draw itself."""

                def render(self) -> str:
                    ...
            PY,
            'app/bookmarks.py' => <<<'PY'
            """Bookmarks, stored and drawn."""

            from app.storage import Renderable, Repository


            class BookmarkRepository(Repository):
                """Bookmarks in memory."""

                def get(self, key):
                    return {"id": key}


            class BookmarkCard(Renderable):
                """A bookmark as one line of text."""

                def render(self) -> str:
                    return "card"
            PY,
        ], 'py-inheritance');
    }

    private function csharpArchive(): UploadedFile
    {
        return $this->zip([
            'Acme.sln' => "Microsoft Visual Studio Solution File, Format Version 12.00\n",
            'src/Acme.Web/Acme.Web.csproj' => <<<'XML'
            <Project Sdk="Microsoft.NET.Sdk.Web">
              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
                <OutputType>Exe</OutputType>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" />
              </ItemGroup>
              <ItemGroup>
                <ProjectReference Include="..\Acme.Core\Acme.Core.csproj" />
              </ItemGroup>
            </Project>
            XML,
            'src/Acme.Core/Acme.Core.csproj' => <<<'XML'
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
              </PropertyGroup>
            </Project>
            XML,
            'src/Acme.Web/Program.cs' => <<<'CS'
            using Acme.Web.Services;

            var builder = WebApplication.CreateBuilder(args);
            builder.Services.AddScoped<ITaskService, TaskService>();
            var app = builder.Build();
            app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));
            app.Run();
            CS,
            'src/Acme.Web/Services/ITaskService.cs' => <<<'CS'
            namespace Acme.Web.Services;

            public interface ITaskService
            {
                Task<string> Create(string title);
            }
            CS,
            'src/Acme.Web/Services/TaskService.cs' => <<<'CS'
            namespace Acme.Web.Services;

            public class TaskService : ITaskService
            {
                private readonly ILogger<TaskService> logger;

                public TaskService(ILogger<TaskService> logger)
                {
                    this.logger = logger;
                }

                public Task<string> Create(string title)
                {
                    logger.LogInformation("creating");
                    return Task.FromResult(title);
                }
            }
            CS,
            'tests/Acme.Tests/TaskServiceTests.cs' => <<<'CS'
            using Acme.Web.Services;
            using Xunit;

            namespace Acme.Tests;

            public class TaskServiceTests
            {
                [Fact]
                public void Create_ReturnsTheTitle()
                {
                    var service = new TaskService(null!);
                    Assert.NotNull(service);
                }
            }
            CS,
            'src/Acme.Web/Controllers/TasksController.cs' => <<<'CS'
            using Acme.Web.Services;
            using Microsoft.AspNetCore.Mvc;

            namespace Acme.Web.Controllers;

            [ApiController]
            [Route("api/[controller]")]
            public class TasksController : ControllerBase
            {
                private readonly ITaskService tasks;

                public TasksController(ITaskService tasks)
                {
                    this.tasks = tasks;
                }

                [HttpGet]
                public async Task<IActionResult> Get()
                {
                    var created = await tasks.Create("list");
                    return Ok(created);
                }

                [HttpPost("{id:int}")]
                public IActionResult Create(int id)
                {
                    return Created("/api/tasks", id);
                }
            }
            CS,
        ], 'acme-tasks');
    }

    private function zip(array $files, string $name): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'atlas-'.$name).'.zip';
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);

        foreach ($files as $file => $contents) {
            $zip->addFromString($name.'/'.$file, $this->dedent($contents));
        }

        $zip->close();

        $this->fixtureArchives[] = $path;

        return new UploadedFile($path, $name.'.zip', 'application/zip', null, true);
    }

    /** Heredocs in fixtures keep their indentation; the parser should see none of it. */
    private function dedent(string $text): string
    {
        $lines = preg_split("/\r\n|\n|\r/", $text) ?: [];
        $indents = [];

        foreach ($lines as $line) {
            if (trim($line) === '') {
                continue;
            }

            $indents[] = strlen($line) - strlen(ltrim($line, ' '));
        }

        $indent = $indents === [] ? 0 : min($indents);

        return implode("\n", array_map(
            fn (string $line) => trim($line) === '' ? '' : substr($line, $indent),
            $lines,
        ));
    }
}
