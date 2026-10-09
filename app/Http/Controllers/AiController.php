<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Project;
use App\Services\Ai\AiProvider;
use App\Services\Ai\AiUnavailable;
use App\Services\Ai\ContextBuilder;
use App\Services\Ai\ProjectBrief;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The assistant, from the browser's side of the fence.
 *
 * This controller is the only thing that talks to the model, and it streams:
 * the reply is newline-delimited JSON as it arrives, so the panel types the
 * answer instead of waiting for it. The browser never reaches the model
 * directly — which means the model can stay on 127.0.0.1 where it belongs,
 * there is no CORS to configure, and the project context is assembled from the
 * database rather than shipped from the page.
 */
class AiController extends Controller
{
    /**
     * Whitespace written after every event, to get it past the built-in dev
     * server's output buffer. See emit().
     */
    private const BUFFER_BYPASS = 4096;

    public function __construct(
        private readonly AiProvider $provider,
        private readonly ProjectBrief $brief,
        private readonly ContextBuilder $context,
    ) {
    }

    /** Is a model listening, what has it got, and what should be used? */
    public function status(Project $project): JsonResponse
    {
        $enabled = (bool) config('atlas.ai.enabled', true);
        $status = $enabled ? $this->cachedStatus() : ['available' => false, 'endpoint' => (string) config('atlas.ai.base_url'), 'models' => [], 'error' => null];

        $suggested = (array) config('atlas.ai.suggested_models', []);
        $installed = $status['models'];

        // Prefer the configured default; if it is not pulled, the first
        // suggestion that is; otherwise whatever is installed.
        $default = (string) config('atlas.ai.model');
        $model = $default;

        if ($status['available'] && ! $this->installed($installed, $default)) {
            $model = $this->firstInstalled($installed, array_keys($suggested)) ?? ($installed[0] ?? $default);
        }

        return response()->json([
            'enabled' => $enabled,
            'available' => $status['available'],
            'provider' => $this->provider->name(),
            'endpoint' => $status['endpoint'],
            'error' => $status['error'],
            'model' => $model,
            'default_model' => $default,
            'model_installed' => $this->installed($installed, $model),
            'installed' => $status['models'],
            'suggested' => $suggested,
            'setup' => $this->setup($status, $installed),
            'has_graph' => $project->scans()->where('status', 'completed')->exists(),
        ]);
    }

    /** What to tell a person whose machine has no model on it yet. */
    private function setup(array $status, array $installed): array
    {
        $default = (string) config('atlas.ai.model');

        return [
            'model' => $default,
            'steps' => [
                'install' => 'Install Ollama from ollama.com/download',
                'pull' => 'ollama pull '.$default,
                'serve' => 'ollama serve   # already running on most installs',
            ],
            'missing_model' => $status['available'] && ! $this->installed($installed, $default),
        ];
    }

    /**
     * Ask the project a question. Streams NDJSON:
     *
     *   {"type":"status","state":"collecting","label":"…"}
     *   {"type":"step","stage":"reading","label":"Reading 3 files","files":[…],"keys":[…]}
     *   {"type":"meta","model":"qwen3:8b","citations":[…],"context_chars":12345}
     *   {"type":"status","state":"thinking","label":"…"}
     *   {"type":"thinking","text":"…"}      the model's own reasoning, when it has any
     *   {"type":"delta","text":"The "}    the answer itself
     *   {"type":"done"}
     *   {"type":"error","message":"…"}
     *
     * The first two kinds exist because the model is not the slow part of the
     * first answer: searching the graph, reading files and building the prompt
     * happen before a single token is generated, and a panel with nothing to
     * show for ten seconds reads as broken. Steps report that work as it
     * finishes; every event after that is the model talking.
     */
    public function ask(Request $request, Project $project): StreamedResponse|JsonResponse
    {
        if (! config('atlas.ai.enabled', true)) {
            return response()->json(['error' => 'The local assistant is switched off.'], 403);
        }

        $data = $request->validate([
            'question' => ['required', 'string', 'min:2', 'max:2000'],
            'model' => ['nullable', 'string', 'max:120'],
            'history' => ['nullable', 'array', 'max:12'],
            'history.*.role' => ['nullable', 'string', 'in:user,assistant'],
            'history.*.content' => ['nullable', 'string', 'max:8000'],
        ]);

        $scan = $project->scans()->where('status', 'completed')->latest('id')->first();

        if ($scan === null) {
            return response()->json(['error' => 'This project has no finished scan to talk about yet.'], 409);
        }

        $status = $this->cachedStatus();

        if (! $status['available']) {
            return response()->json([
                'error' => $status['error'] ?? 'No local model is running.',
                'endpoint' => $status['endpoint'],
            ], 503);
        }

        // The model the browser asked for, unless it is not installed — then the
        // configured default, which the status endpoint has already vetted.
        $requested = (string) ($data['model'] ?? '');
        $model = $requested !== '' && $this->installed($status['models'], $requested)
            ? $requested
            : (string) config('atlas.ai.model');

        $question = $data['question'];
        $history = $data['history'] ?? [];

        return response()->stream(function () use ($project, $scan, $question, $history, $model, $request) {
            $this->emit(['type' => 'status', 'state' => 'collecting', 'label' => 'Finding the part of the project that matters']);

            try {
                $built = $this->context->build($project, $scan, $question, $history, function (array $step) {
                    $this->emit(['type' => 'step'] + $step);
                });
            } catch (\Throwable $exception) {
                report($exception);
                $this->emit(['type' => 'error', 'message' => 'The assistant could not assemble the project context: '.$exception->getMessage()]);

                return;
            }

            $this->emit(['type' => 'meta', 'model' => $model, 'citations' => $built['citations'], 'context_chars' => $built['context_chars']]);
            $this->emit(['type' => 'status', 'state' => 'thinking', 'label' => 'Thinking about '.$model]);

            try {
                $this->provider->chat($built['messages'], $model, function (string $text, string $kind = 'answer') {
                    $this->emit(['type' => $kind === 'thinking' ? 'thinking' : 'delta', 'text' => $text]);
                });

                $this->emit(['type' => 'done', 'stopped' => $request->boolean('stream_closed')]);
            } catch (AiUnavailable $exception) {
                $this->emit(['type' => 'error', 'message' => $exception->getMessage()]);
            } catch (\Throwable $exception) {
                report($exception);
                $this->emit(['type' => 'error', 'message' => 'The assistant failed while answering: '.$exception->getMessage()]);
            }
        }, 200, [
            'Content-Type' => 'application/x-ndjson',
            'Cache-Control' => 'no-cache, no-transform',
            // Reverse proxies must not hold the stream back.
            'X-Accel-Buffering' => 'no',
        ]);
    }

    /**
     * Write one NDJSON line and push it out immediately.
     *
     * "Immediately" is the hard part. PHP's built-in server — the one
     * `php artisan atlas:serve` runs, and the one most people will use — keeps
     * each response in a ~4 KB buffer and hands it over only when that buffer
     * fills. Neither flush() nor the content type changes that. On a slow local
     * model the first words of an answer therefore sit in that buffer for
     * seconds and then arrive together: the panel looks frozen, and the answer
     * is live only in theory. That buffered lump is the delay this whole
     * endpoint exists to remove.
     *
     * So each event carries whitespace behind it, which pushes the response
     * past the buffer and out to the browser event by event. A normal server
     * (nginx, php-fpm, Apache) flushes the padding with everything else, and
     * 4 KB per event on loopback costs nothing next to a model's own latency.
     */
    private function emit(array $payload): void
    {
        // The padding rides on the same line as the JSON: trailing whitespace is
        // legal in JSON, so a parser that reads the line as JSON never notices,
        // and the line count stays one event per event.
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        echo str_repeat(' ', self::BUFFER_BYPASS), "\n";
        flush();
    }

    /** The model list is asked often; a few seconds of cache keeps it cheap. */
    private function cachedStatus(): array
    {
        return Cache::remember('atlas:ai:status:'.md5((string) config('atlas.ai.base_url')), now()->addSeconds(15), fn () => $this->provider->status());
    }

    private function installed(array $models, ?string $model): bool
    {
        if ($model === null || $model === '') {
            return false;
        }

        foreach ($models as $candidate) {
            if ($candidate === $model || str_starts_with($candidate, $model.':')) {
                return true;
            }
        }

        return false;
    }

    /** @param array<int, string> $candidates */
    private function firstInstalled(array $models, array $candidates): ?string
    {
        foreach ($candidates as $candidate) {
            if ($this->installed($models, $candidate)) {
                return $candidate;
            }
        }

        return null;
    }
}
