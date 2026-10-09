<?php

namespace Tests\Feature;

use App\Models\Project;
use App\Models\Scan;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Tests\TestCase;
use ZipArchive;

/**
 * The whole promise of AtlasScope in one test: take a zip, scan it, open the
 * atlas, read a node's source back out and search the graph.
 */
class AtlasWorkflowTest extends TestCase
{
    use RefreshDatabase;

    /** A uuid that the prune tests treat as a project that still exists. */
    private const LIVE_UUID = '22222222-2222-4222-8222-222222222222';

    /** @var array<int, string> */
    private array $temporaryPaths = [];

    private array $createdProjects = [];

    private array $fixtureArchives = [];

    protected function setUp(): void
    {
        parent::setUp();

        // No worker in tests: run the pipeline inline.
        config(['atlas.sync_scans' => true, 'atlas.verbose_scans' => false]);
    }

    protected function tearDown(): void
    {
        foreach ($this->createdProjects as $project) {
            app(\App\Services\ProjectManager::class)->destroy($project);
        }

        foreach ($this->fixtureArchives as $archive) {
            if (is_file($archive)) {
                @unlink($archive);
            }
        }

        // Storage roots handed to the prune tests, which must never touch the
        // real one.
        foreach ($this->temporaryPaths as $path) {
            File::deleteDirectory($path);
        }

        parent::tearDown();
    }

    public function test_the_welcome_screen_loads(): void
    {
        $this->get('/')->assertOk()->assertSee('AtlasScope', escape: false);
    }

    public function test_an_uploaded_project_is_scanned_and_mapped(): void
    {
        $response = $this->post('/projects', [
            'name' => 'Fixture App',
            'archive' => $this->fixtureArchive(),
        ]);

        $project = Project::firstOrFail();
        $this->createdProjects[] = $project;

        $response->assertRedirect(route('projects.atlas', $project));

        $scan = $project->scans()->latest('id')->firstOrFail();
        $this->assertSame('completed', $scan->status->value, (string) $scan->error);
        $this->assertGreaterThan(0, $scan->node_count);

        $graph = $this->getJson(route('api.atlas.graph', $project))->assertOk()->json();

        $this->assertTrue($graph['ready']);
        $this->assertNotEmpty($graph['nodes']);
        $this->assertNotEmpty($graph['edges']);
        $this->assertNotEmpty($graph['insights']);

        // Every node has to carry a 3D position, or the atlas renders as a dot.
        $positioned = collect($graph['nodes'])->filter(fn ($node) => $node['x'] !== 0.0 || $node['z'] !== 0.0);
        $this->assertGreaterThan(count($graph['nodes']) / 2, $positioned->count());

        // ...and the graph has to look like this project, not an empty shell.
        $types = collect($graph['nodes'])->pluck('type')->unique();
        $this->assertContains('route', $types);
        $this->assertContains('controller', $types);
        $this->assertContains('model', $types);
        $this->assertContains('table', $types);
    }

    /**
     * The upload guard has to be able to fail without taking the app down with
     * it: a rejected upload is a redirect with a readable error, never a 500.
     * (An over-eager fallback error renderer once turned every validation
     * failure into a 500 page — this is the test that would have caught it.)
     */
    public function test_a_rejected_upload_is_a_readable_error_not_a_500(): void
    {
        $this->post(route('projects.store'), ['archive' => UploadedFile::fake()->create('notes.txt', 4, 'text/plain')])
            ->assertSessionHasErrors('archive');

        $this->post(route('projects.store'), [])->assertSessionHasErrors('archive');

        $this->assertSame(0, Project::count());
    }

    /**
     * The natural limit is written down once, in bin/limits.env, and consumed by
     * both the shell wrapper and the app. If they ever drift, the UI advertises
     * one number while the server enforces another — the exact failure this
     * project already had once.
     */
    public function test_the_natural_limit_is_the_same_number_in_shell_and_php(): void
    {
        $dev = \App\Support\Ini::devLimits();

        $this->assertTrue($dev['defined'], 'bin/limits.env is missing — the dev server would fall back to PHP defaults.');

        $this->assertSame(
            \App\Support\Ini::devBytes('upload_max'),
            (int) config('atlas.max_archive_bytes'),
            'bin/limits.env and config/atlas.php disagree about the natural archive limit.',
        );

        $this->assertGreaterThan(
            \App\Support\Ini::devBytes('upload_max'),
            \App\Support\Ini::devBytes('post_max'),
            'post_max_size must leave room for multipart overhead above upload_max_filesize.',
        );

        $this->assertGreaterThan(
            (int) config('atlas.max_archive_bytes'),
            (int) config('atlas.max_extracted_bytes'),
            'Unpacking needs a larger guard than the archive ceiling: source compresses several times over.',
        );
    }

    /**
     * The reason AtlasScope works on a stock PHP install: a raw request body is
     * not a multipart form upload, so upload_max_filesize and post_max_size do
     * not apply to it. A big archive arrives as pieces that are stitched back
     * together and scanned like any other upload.
     */
    public function test_a_large_archive_can_be_streamed_in_pieces(): void
    {
        $archive = $this->fixtureArchive()->getRealPath();
        $bytes = (string) file_get_contents($archive);
        $piece = 512; // deliberately small so the test has several pieces

        $started = $this->postJson(route('uploads.start'), [
            'bytes' => strlen($bytes),
            'name' => 'big-project.zip',
        ])->assertOk()->assertJsonStructure(['token', 'chunk_size']);

        $token = $started->json('token');
        $total = (int) ceil(strlen($bytes) / $piece);

        for ($index = 0; $index < $total; $index++) {
            $this->call(
                'PUT',
                route('uploads.chunk', ['token' => $token]),
                [], [], [],
                ['HTTP_X_ATLAS_INDEX' => $index, 'HTTP_X_ATLAS_TOTAL' => $total, 'CONTENT_TYPE' => 'application/octet-stream'],
                substr($bytes, $index * $piece, $piece),
            )->assertOk();
        }

        $done = $this->postJson(route('uploads.complete', ['token' => $token]), ['name' => 'Streamed Project'])
            ->assertOk()
            ->assertJsonStructure(['project', 'redirect']);

        $project = Project::where('uuid', $done->json('project'))->first();

        $this->assertNotNull($project, 'The streamed archive did not become a project.');
        $this->assertSame('Streamed Project', $project->name);
        $this->assertSame('upload', $project->source_type);
        /*
         * Integrity, proved from the outside: read the fixture zip ourselves and
         * compare what the reassembled archive produced. A dropped, duplicated
         * or reordered piece would change both numbers.
         */
        $zip = new ZipArchive();
        $zip->open($archive);

        $expectedBytes = 0;
        $expectedEntries = 0;

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);

            if (str_ends_with((string) ($stat['name'] ?? ''), '/')) {
                continue;
            }

            $expectedBytes += (int) $stat['size'];
            $expectedEntries++;
        }

        $zip->close();

        $this->assertSame(
            $expectedBytes,
            $project->archive_size,
            'The streamed archive did not unpack to the same source as the original.',
        );

        $this->assertSame(
            $expectedEntries,
            (int) $project->meta['extracted_entries'],
            'A piece was dropped or duplicated while reassembling.',
        );

        // Nothing is left behind: no session directory, no loose archive.
        $this->assertDirectoryDoesNotExist(storage_path('app/atlas/_uploads/'.$token));
        $this->assertFileDoesNotExist(storage_path('app/atlas/_uploads/'.$token.'.zip'));
    }

    /** Out-of-order or unknown pieces would silently corrupt an archive. */
    public function test_chunked_uploads_reject_bad_input(): void
    {
        $this->postJson(route('uploads.start'), ['bytes' => 0])->assertStatus(422);
        $this->postJson(route('uploads.start'), ['bytes' => (int) config('atlas.max_archive_bytes') + 1])->assertStatus(422);

        $token = $this->postJson(route('uploads.start'), ['bytes' => 1024])->json('token');

        // A piece out of order is refused rather than appended.
        $this->call('PUT', route('uploads.chunk', ['token' => $token]), [], [], [],
            ['HTTP_X_ATLAS_INDEX' => 3, 'CONTENT_TYPE' => 'application/octet-stream'], 'not the first piece')
            ->assertStatus(409);

        // Unknown or malformed sessions are a 404, not a filesystem guess.
        $this->call('PUT', route('uploads.chunk', ['token' => str_repeat('a', 40)]), [], [], [],
            ['HTTP_X_ATLAS_INDEX' => 0, 'CONTENT_TYPE' => 'application/octet-stream'], 'x')
            ->assertStatus(404);

        // Completing an empty session is refused, and aborting cleans up.
        $this->postJson(route('uploads.complete', ['token' => $token]))->assertStatus(422);
        $this->deleteJson(route('uploads.abort', ['token' => $token]))->assertOk();
        $this->assertDirectoryDoesNotExist(storage_path('app/atlas/_uploads/'.$token));
    }

    /** The browser re-reads this before it decides anything about a chosen file. */
    public function test_the_capacity_endpoint_reports_live_upload_limits(): void
    {
        $response = $this->getJson(route('api.atlas.capacity'))->assertOk();

        $response->assertJsonStructure([
            'max_bytes', 'max_human', 'app_max_bytes', 'upload_max_filesize',
            'post_max_size', 'constrained_by', 'constrained_by_php',
            'raise_command', 'raise_env', 'raise_ini', 'raise_note',
            'dev_upload_max', 'dev_upload_max_human', 'dev_post_max',
            'natural_max_bytes', 'natural_max_human',
        ]);

        $appMax = (int) config('atlas.max_archive_bytes');
        $ceiling = $response->json('max_bytes');

        $this->assertGreaterThan(0, $ceiling);
        $this->assertLessThanOrEqual($appMax, $ceiling, 'The ceiling can never exceed what the app itself allows.');
    }

    public function test_the_atlas_view_and_its_endpoints_respond(): void
    {
        $project = $this->scannedFixture();

        $this->get(route('projects.atlas', $project))
            ->assertOk()
            ->assertSee('id="atlas"', escape: false)
            ->assertSee('data-graph-url', escape: false);

        $this->getJson(route('api.atlas.status', $project))
            ->assertOk()
            ->assertJsonPath('status', 'completed');

        $this->getJson(route('api.atlas.events', $project))
            ->assertOk()
            ->assertJsonStructure(['events']);

        $search = $this->getJson(route('api.atlas.search', ['project' => $project, 'q' => 'task']))
            ->assertOk()
            ->json('results');

        $this->assertNotEmpty($search);
    }

    public function test_node_detail_and_file_preview_are_sandboxed(): void
    {
        $project = $this->scannedFixture();

        $key = $project->scans()->latest('id')->firstOrFail()
            ->nodes()->where('node_key', 'like', 'class:%')->value('node_key');

        $this->getJson(route('api.atlas.nodes', ['project' => $project, 'key' => $key]))
            ->assertOk()
            ->assertJsonPath('key', $key)
            ->assertJsonStructure(['edges_in', 'edges_out']);

        $this->getJson(route('api.atlas.file', ['project' => $project, 'path' => 'app/Models/Task.php']))
            ->assertOk()
            ->assertJsonPath('path', 'app/Models/Task.php');

        // Path traversal and non-text files must be refused.
        $this->getJson(route('api.atlas.file', ['project' => $project, 'path' => '../../../.env']))
            ->assertStatus(404);

        $this->getJson(route('api.atlas.file', ['project' => $project, 'path' => 'public/logo.png']))
            ->assertStatus(415);
    }

    public function test_the_graph_is_not_ready_until_a_scan_completes(): void
    {
        $project = Project::create([
            'uuid' => '00000000-0000-4000-8000-000000000000',
            'name' => 'Queued App',
            'source_type' => 'path',
            'root_path' => storage_path('app/atlas/queued-fixture'),
            'archive_size' => 0,
            'file_count' => 0,
        ]);

        $project->scans()->create(['status' => 'queued', 'stage' => 'extract', 'progress' => 0]);

        $this->getJson(route('api.atlas.graph', $project))
            ->assertStatus(202)
            ->assertJsonPath('ready', false);
    }

    public function test_orphaned_workspaces_are_pruned(): void
    {
        /*
         * A scan that died part-way leaves a directory with no project behind
         * it. The interface cannot show it, but it should not live forever.
         *
         * The command looks at the real storage path, so this test gives it a
         * temporary one: pruning is destructive, and an earlier version of this
         * test — pointed at the real directory, against the empty test database
         * — deleted every demo project workspace on disk.
         */
        $storage = $this->temporaryStorage();

        $this->app->useStoragePath($storage);

        File::ensureDirectoryExists($storage.'/app/atlas/'.self::LIVE_UUID.'/source');
        File::ensureDirectoryExists($storage.'/app/atlas/orphaned-project/source');
        File::put($storage.'/app/atlas/orphaned-project/source/left-behind.txt', 'debris');

        Project::create([
            'uuid' => self::LIVE_UUID,
            'name' => 'Kept Project',
            'source_type' => 'path',
            'root_path' => $storage.'/app/atlas/'.self::LIVE_UUID.'/source',
            'archive_size' => 0,
            'file_count' => 1,
        ]);

        $this->artisan('atlas:prune --force')
            ->expectsOutputToContain('Removed 1 orphaned workspace')
            ->assertSuccessful();

        $this->assertDirectoryDoesNotExist($storage.'/app/atlas/orphaned-project');
        $this->assertDirectoryExists($storage.'/app/atlas/'.self::LIVE_UUID);
    }

    public function test_pruning_refuses_when_the_database_has_no_projects(): void
    {
        // The dangerous case: an empty database makes every workspace look
        // orphaned, and one wrong answer here deletes real projects.
        $storage = $this->temporaryStorage();

        $this->app->useStoragePath($storage);

        File::ensureDirectoryExists($storage.'/app/atlas/precious-project/source');
        File::put($storage.'/app/atlas/precious-project/source/keep-me.php', '<?php');

        $this->artisan('atlas:prune')
            ->expectsOutputToContain('Refusing to prune')
            ->assertFailed();

        $this->assertDirectoryExists($storage.'/app/atlas/precious-project');
    }

    /** A throwaway storage root, so destructive commands never see the real one. */
    private function temporaryStorage(): string
    {
        $path = sys_get_temp_dir().'/atlas-storage-'.Str::random(8);

        $this->temporaryPaths[] = $path;

        return $path;
    }

    /* ------------------------------------------------------------- helpers -- */

    private function scannedFixture(): Project
    {
        $this->post('/projects', ['archive' => $this->fixtureArchive()]);

        $project = Project::firstOrFail();
        $this->createdProjects[] = $project;

        $this->assertSame('completed', $project->scans()->latest('id')->firstOrFail()->status->value);

        return $project;
    }

    /** A miniature but structurally honest Laravel project, zipped in memory. */
    private function fixtureArchive(): UploadedFile
    {
        $files = [
            'composer.json' => json_encode([
                'name' => 'acme/fixture',
                'require' => ['laravel/framework' => '^13.0'],
            ], JSON_PRETTY_PRINT),
            'artisan' => "#!/usr/bin/env php\n<?php\n",
            'routes/web.php' => <<<'PHP'
<?php

use App\Http\Controllers\TaskController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('/tasks', [TaskController::class, 'index'])->name('tasks.index');
    Route::post('/tasks', [TaskController::class, 'store'])->name('tasks.store');
});

Route::get('/dashboard', fn () => view('dashboard'))->middleware('auth')->name('dashboard');
PHP,
            'app/Http/Controllers/TaskController.php' => <<<'PHP'
<?php

namespace App\Http\Controllers;

use App\Models\Task;
use App\Services\ReportService;
use Illuminate\Http\Request;

class TaskController extends Controller
{
    public function __construct(private readonly ReportService $reports) {}

    public function index()
    {
        return view('tasks.index', ['tasks' => Task::query()->latest()->get()]);
    }

    public function store(Request $request)
    {
        $task = Task::create($request->validated());

        $this->reports->summarise($task);

        return redirect()->route('tasks.index');
    }
}
PHP,
            'app/Models/Task.php' => <<<'PHP'
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Task extends Model
{
    protected $fillable = ['title', 'done', 'project_id'];

    protected $casts = ['done' => 'boolean'];

    public function project(): BelongsTo
    {
        return $this->belongsTo(Project::class);
    }
}
PHP,
            'app/Models/Project.php' => <<<'PHP'
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Project extends Model
{
    public function tasks(): HasMany
    {
        return $this->hasMany(Task::class);
    }
}
PHP,
            'app/Services/ReportService.php' => <<<'PHP'
<?php

namespace App\Services;

use App\Models\Task;

class ReportService
{
    public function summarise(Task $task): array
    {
        return ['task' => $task->title];
    }
}
PHP,
            'database/migrations/2026_01_01_000000_create_tasks_table.php' => <<<'PHP'
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tasks', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->boolean('done')->default(false);
            $table->foreignId('project_id')->constrained();
            $table->timestamps();
        });
    }
};
PHP,
            'resources/views/tasks/index.blade.php' => <<<'BLADE'
<h1>Tasks</h1>

@foreach ($tasks as $task)
    <div>{{ $task->title }}</div>
@endforeach
BLADE,
            'resources/views/dashboard.blade.php' => "<h1>Dashboard</h1>\n",
            'public/logo.png' => "\x89PNG\r\n\x1a\nnot-really-a-png",
        ];

        $path = tempnam(sys_get_temp_dir(), 'atlas-fixture').'.zip';
        $zip = new ZipArchive();
        $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);

        foreach ($files as $name => $contents) {
            $zip->addFromString('fixture/'.$name, $contents);
        }

        $zip->close();

        $upload = new UploadedFile($path, 'fixture.zip', 'application/zip', null, true);

        $this->fixtureArchives[] = $path;

        return $upload;
    }
}
