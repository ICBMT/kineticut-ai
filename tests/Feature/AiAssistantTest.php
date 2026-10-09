<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Project;
use App\Services\Ai\AiProvider;
use App\Services\Ai\ContextBuilder;
use App\Services\Ai\ProjectBrief;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

/**
 * The assistant's plumbing, without a model.
 *
 * A fake provider is bound in place of Ollama, which is the point: the tests
 * care that the right context reaches the model, that the reply streams back
 * as NDJSON, and that a machine with nothing installed is told so clearly.
 */
class AiAssistantTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // The status check is cached for a few seconds; each test starts clean
        // so a fake "offline" cannot leak into a fake "online".
        Cache::flush();
    }

    protected function tearDown(): void
    {
        FakeAiProvider::$status = null;
        FakeAiProvider::$seen = [];
        FakeAiProvider::$thinking = [];
        FakeAiProvider::$reply = ['It works.'];

        parent::tearDown();
    }

    public function test_the_status_endpoint_explains_an_offline_runtime(): void
    {
        FakeAiProvider::$status = [
            'available' => false,
            'endpoint' => 'http://127.0.0.1:11434',
            'models' => [],
            'error' => 'Nothing answered on http://127.0.0.1:11434.',
        ];

        $this->bindFake();

        $project = $this->scannedProject();

        $response = $this->getJson(route('api.atlas.ai.status', $project))
            ->assertOk()
            ->assertJsonPath('available', false)
            ->assertJsonPath('model_installed', false)
            ->assertJsonStructure(['setup' => ['steps' => ['install', 'pull', 'serve'], 'model']]);

        $this->assertStringContainsString('ollama pull', $response->json('setup.steps.pull'));
    }

    public function test_the_status_endpoint_reports_the_installed_models(): void
    {
        FakeAiProvider::$status = [
            'available' => true,
            'endpoint' => 'http://127.0.0.1:11434',
            'models' => ['llama3.2:3b', 'qwen3:8b'],
            'error' => null,
        ];

        $this->bindFake();

        $this->getJson(route('api.atlas.ai.status', $this->scannedProject()))
            ->assertOk()
            ->assertJsonPath('available', true)
            ->assertJsonPath('model', 'qwen3:8b')
            ->assertJsonPath('model_installed', true)
            ->assertJsonPath('installed', ['llama3.2:3b', 'qwen3:8b']);
    }

    public function test_asking_streams_ndjson_and_hands_the_model_the_project(): void
    {
        FakeAiProvider::$status = [
            'available' => true,
            'endpoint' => 'http://127.0.0.1:11434',
            'models' => ['qwen3:8b'],
            'error' => null,
        ];

        FakeAiProvider::$reply = ['Dashboard', 'Controller', ' reads the users table.'];

        $this->bindFake();

        $project = $this->scannedProject();

        $response = $this->post(route('api.atlas.ai.ask', $project), [
            'question' => 'What does DashboardController do?',
        ]);

        $response->assertOk();
        $this->assertStringContainsString('application/x-ndjson', (string) $response->headers->get('content-type'));

        $events = $this->streamEvents($response);

        $this->assertSame('done', end($events)['type']);

        $meta = $this->firstEventOfType($events, 'meta');
        $this->assertNotNull($meta, 'the stream never said which model was answering');

        // Deltas arrive as fragments, and it is the *reassembled* text that
        // has to be the model's answer.
        $streamed = implode('', array_column(array_filter($events, fn (array $event) => $event['type'] === 'delta'), 'text'));
        $this->assertSame('DashboardController reads the users table.', $streamed);

        // The prompt: instructions, the project brief, and the file the
        // question named — with its source lines.
        $prompt = FakeAiProvider::$seen['messages'] ?? [];
        $this->assertNotEmpty($prompt);
        $this->assertSame('system', $prompt[0]['role']);
        $this->assertStringContainsString('KEY INDEX', $prompt[0]['content']);
        $this->assertStringContainsString('DashboardController', $prompt[0]['content']);

        $last = end($prompt);
        $this->assertStringContainsString('What does DashboardController do?', $last['content']);
        $this->assertStringContainsString('app/Http/Controllers/DashboardController.php', $last['content']);

        // And the citations handed back are nodes the interface can open.
        $this->assertSame('class:App\\Http\\Controllers\\DashboardController', $meta['citations'][0]['key']);
        $this->assertSame('app/Http/Controllers/DashboardController.php', $meta['citations'][0]['file']);
    }

    /**
     * The panel must never be a still rectangle: before the first token it is
     * told what the atlas is doing, and which files it is doing it to.
     */
    public function test_the_panel_is_told_what_is_happening_before_the_answer(): void
    {
        $this->bindFake();

        $project = $this->scannedProject();

        $events = $this->streamEvents($this->post(route('api.atlas.ai.ask', $project), [
            'question' => 'What does DashboardController do?',
        ]));

        $types = array_column($events, 'type');

        // The first thing on the wire is a status, not silence.
        $this->assertSame('status', $types[0]);
        $this->assertSame('collecting', $events[0]['state']);

        // Every stage of the preparation is reported, in order, and all of it
        // lands before the model has said a word.
        $steps = array_values(array_filter($events, fn (array $event) => $event['type'] === 'step'));
        $this->assertSame(['searching', 'selected', 'reading', 'ready'], array_column($steps, 'stage'));

        $reading = $steps[2];
        $this->assertSame('Reading 1 file', $reading['label']);
        $this->assertSame(
            ['app/Http/Controllers/DashboardController.php'],
            array_column($reading['files'], 'path'),
        );
        $this->assertSame('DashboardController', $reading['files'][0]['label']);

        // The chosen nodes are named too, so the trail can show them.
        $this->assertSame('class:App\\Http\\Controllers\\DashboardController', $steps[1]['keys'][0]);

        $firstStep = array_search('step', $types, true);
        $meta = array_search('meta', $types, true);
        $firstDelta = array_search('delta', $types, true);

        $this->assertLessThan($meta, $firstStep);
        $this->assertLessThan($firstDelta, $meta);

        // The last status before the answer is the model actually thinking.
        $thinkingStatus = $this->firstEventOfType($events, 'status', 'thinking');
        $this->assertNotNull($thinkingStatus);
        $this->assertStringContainsString('qwen3:8b', $thinkingStatus['label']);
    }

    /** A reasoning model's notes are streamed as their own kind, not as answer text. */
    public function test_reasoning_arrives_separately_from_the_answer(): void
    {
        FakeAiProvider::$thinking = ['The question names Dashboard', 'Controller, so I read that file. '];
        FakeAiProvider::$reply = ['It reads the users table.'];

        $this->bindFake();

        $project = $this->scannedProject();

        $events = $this->streamEvents($this->post(route('api.atlas.ai.ask', $project), [
            'question' => 'What does DashboardController do?',
        ]));

        $this->assertSame(
            'The question names DashboardController, so I read that file. ',
            $this->join($events, 'thinking'),
        );

        // The reasoning must not leak into the reply the user is reading.
        $this->assertSame('It reads the users table.', $this->join($events, 'delta'));
    }

    private function firstEventOfType(array $events, string $type, ?string $state = null): ?array
    {
        foreach ($events as $event) {
            if ($event['type'] === $type && ($state === null || ($event['state'] ?? null) === $state)) {
                return $event;
            }
        }

        return null;
    }

    /** @return array<int, array<string, mixed>> */
    private function streamEvents(\Illuminate\Testing\TestResponse $response): array
    {
        $response->assertOk();

        $body = $response->streamedContent();

        return array_values(array_filter(array_map(
            fn (string $line) => json_decode($line, true),
            explode("\n", trim($body)),
        ), fn ($event) => is_array($event)));
    }

    private function join(array $events, string $type): string
    {
        return implode('', array_column(
            array_filter($events, fn (array $event) => $event['type'] === $type),
            'text',
        ));
    }

    public function test_a_project_without_a_finished_scan_is_refused_politely(): void
    {
        FakeAiProvider::$status = [
            'available' => true,
            'endpoint' => 'http://127.0.0.1:11434',
            'models' => ['qwen3:8b'],
            'error' => null,
        ];

        $this->bindFake();

        $project = Project::create([
            'uuid' => '11111111-1111-4111-8111-111111111111',
            'name' => 'Unscanned',
            'source_type' => 'path',
            'root_path' => storage_path('app/atlas/unscanned-fixture'),
            'archive_size' => 0,
            'file_count' => 0,
        ]);

        $this->postJson(route('api.atlas.ai.ask', $project), ['question' => 'What is this?'])
            ->assertStatus(409);
    }

    public function test_an_offline_runtime_is_reported_as_a_service_message(): void
    {
        FakeAiProvider::$status = [
            'available' => false,
            'endpoint' => 'http://127.0.0.1:11434',
            'models' => [],
            'error' => 'Nothing answered on http://127.0.0.1:11434.',
        ];

        $this->bindFake();

        $this->postJson(route('api.atlas.ai.ask', $this->scannedProject()), ['question' => 'What is this?'])
            ->assertStatus(503)
            ->assertJsonPath('error', 'Nothing answered on http://127.0.0.1:11434.');
    }

    public function test_the_retriever_finds_the_class_a_question_names(): void
    {
        $project = $this->scannedProject();
        $scan = $project->scans()->where('status', 'completed')->latest('id')->firstOrFail();

        $built = app(ContextBuilder::class)->build($project, $scan, 'How does DashboardController count the work?');

        $keys = array_column($built['citations'], 'key');
        $last = $built['messages'][count($built['messages']) - 1]['content'];

        $this->assertContains('class:App\\Http\\Controllers\\DashboardController', $keys);
        $this->assertStringContainsString('DashboardController', $last);
        $this->assertStringContainsString('app/Http/Controllers/DashboardController.php', $last);
    }

    public function test_the_brief_describes_the_project_before_anyone_asks(): void
    {
        $project = $this->scannedProject();
        $scan = $project->scans()->where('status', 'completed')->latest('id')->firstOrFail();

        $brief = app(ProjectBrief::class)->text($project, $scan);

        $this->assertStringContainsString('PROJECT: '.$project->displayName(), $brief);
        $this->assertStringContainsString('STACK: Language PHP', $brief);
        $this->assertStringContainsString('ENTRY POINTS', $brief);
        $this->assertStringContainsString('GET /dashboard', $brief);
        $this->assertStringContainsString('KEY INDEX', $brief);
    }

    /* ------------------------------------------------------------- helpers -- */

    private function bindFake(): void
    {
        $this->app->instance(AiProvider::class, new FakeAiProvider());
    }

    /**
     * A miniature Laravel project, zipped in memory and scanned, so the
     * assistant is tested against a graph the test fully controls.
     */
    private function scannedProject(): Project
    {
        $archive = new UploadedFile($this->fixtureArchive(), 'dashboard-app.zip', 'application/zip', null, true);

        $this->post('/projects', ['archive' => $archive, 'name' => 'Dashboard App']);

        $project = Project::firstOrFail();

        $this->assertSame('completed', $project->scans()->latest('id')->firstOrFail()->status->value);

        return $project;
    }

    private function fixtureArchive(): string
    {
        $files = [
            'composer.json' => json_encode([
                'name' => 'acme/dashboard-app',
                'require' => ['laravel/framework' => '^13.0'],
            ], JSON_PRETTY_PRINT),
            'routes/web.php' => <<<'PHP'
<?php

use App\Http\Controllers\DashboardController;
use Illuminate\Support\Facades\Route;

Route::get('/dashboard', [DashboardController::class, 'index'])->name('dashboard');
PHP,
            'app/Http/Controllers/DashboardController.php' => <<<'PHP'
<?php

namespace App\Http\Controllers;

use App\Models\User;

class DashboardController extends Controller
{
    public function index()
    {
        $users = User::query()->count();

        return view('dashboard', ['users' => $users]);
    }
}
PHP,
            'app/Models/User.php' => <<<'PHP'
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class User extends Model
{
    protected $fillable = ['name', 'email'];
}
PHP,
            'resources/views/dashboard.blade.php' => "<h1>Dashboard</h1>\n",
        ];

        $path = tempnam(sys_get_temp_dir(), 'atlas-ai').'.zip';
        $zip = new \ZipArchive();
        $zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);

        foreach ($files as $name => $contents) {
            $zip->addFromString($name, $contents);
        }

        $zip->close();

        return $path;
    }
}

/**
 * A model that answers instantly and remembers what it was asked.
 */
class FakeAiProvider implements AiProvider
{
    /** @var array{available: bool, endpoint: string, models: array<int, string>, error: ?string}|null */
    public static ?array $status = null;

    /** @var array<int, string> */
    public static array $reply = ['It works.'];

    /** @var array<int, string> A thinking model's private notes, streamed first. */
    public static array $thinking = [];

    /** @var array<string, mixed> */
    public static array $seen = [];

    public function name(): string
    {
        return 'Fake';
    }

    public function status(): array
    {
        return self::$status ?? [
            'available' => true,
            'endpoint' => 'http://127.0.0.1:11434',
            'models' => ['qwen3:8b'],
            'error' => null,
        ];
    }

    public function chat(array $messages, string $model, callable $onDelta): void
    {
        self::$seen = ['messages' => $messages, 'model' => $model];

        foreach (self::$thinking as $chunk) {
            $onDelta($chunk, 'thinking');
        }

        foreach (self::$reply as $chunk) {
            $onDelta($chunk, 'answer');
        }
    }
}
