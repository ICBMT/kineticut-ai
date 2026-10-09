<?php

declare(strict_types=1);

namespace App\Services\Ai;

/**
 * Ollama's HTTP API, spoken with cURL.
 *
 * cURL rather than Laravel's HTTP client because the point of this class is the
 * *write callback*: `/api/chat` streams newline-delimited JSON, and the panel
 * should render each fragment the moment the model produces it. With a client
 * that buffers the whole response first, a 30-second answer arrives as one
 * 30-second pause.
 */
class OllamaClient implements AiProvider
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly int $timeout = 180,
        private readonly float $temperature = 0.2,
    ) {
    }

    public function name(): string
    {
        return 'Ollama';
    }

    public function status(): array
    {
        $endpoint = rtrim($this->baseUrl, '/');
        $body = $this->get($endpoint.'/api/tags', 2);

        if ($body === null) {
            return [
                'available' => false,
                'endpoint' => $endpoint,
                'models' => [],
                'error' => 'Nothing answered on '.$endpoint.'.',
            ];
        }

        $decoded = json_decode($body, true);

        if (! is_array($decoded)) {
            return [
                'available' => false,
                'endpoint' => $endpoint,
                'models' => [],
                'error' => 'That address answered, but not like Ollama.',
            ];
        }

        $models = array_values(array_filter(array_map(
            fn ($model) => is_array($model) ? ($model['name'] ?? null) : null,
            $decoded['models'] ?? [],
        )));

        sort($models);

        return ['available' => true, 'endpoint' => $endpoint, 'models' => $models, 'error' => null];
    }

    public function chat(array $messages, string $model, callable $onDelta): void
    {
        $endpoint = rtrim($this->baseUrl, '/');
        $buffer = '';

        $handle = curl_init($endpoint.'/api/chat');

        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode([
                'model' => $model,
                'messages' => $messages,
                'stream' => true,
                'options' => ['temperature' => $this->temperature],
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT => $this->timeout,
            // A model that is not running should fail in seconds, not at the
            // end of the full timeout.
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_WRITEFUNCTION => function ($handle, string $chunk) use (&$buffer, $onDelta): int {
                $buffer .= $chunk;

                // NDJSON: one complete JSON object per line.
                while (($break = strpos($buffer, "\n")) !== false) {
                    $line = trim(substr($buffer, 0, $break));
                    $buffer = substr($buffer, $break + 1);

                    if ($line !== '') {
                        $this->emit($line, $onDelta);
                    }
                }

                return strlen($chunk);
            },
        ]);

        curl_exec($handle);

        $error = curl_errno($handle);
        $message = curl_error($handle);

        curl_close($handle);

        if ($error !== 0) {
            throw new AiUnavailable($error === CURLE_OPERATION_TIMEDOUT
                ? 'The model took too long to answer. A smaller model, or a shorter question, may help.'
                : 'The model stopped answering: '.$message);
        }
    }

    /**
     * One NDJSON line → whatever text it carries for the caller.
     *
     * Ollama puts the reply in `message.content` and, for a reasoning model, the
     * deliberation in `message.thinking` — both on the same stream, both in the
     * same shape. They are forwarded tagged so the panel can keep them apart.
     */
    private function emit(string $line, callable $onDelta): void
    {
        $payload = json_decode($line, true);

        if (! is_array($payload)) {
            return;
        }

        if (isset($payload['error'])) {
            throw new AiUnavailable((string) $payload['error']);
        }

        $thinking = $payload['message']['thinking'] ?? null;

        if (is_string($thinking) && $thinking !== '') {
            $onDelta($thinking, 'thinking');
        }

        $text = $payload['message']['content'] ?? null;

        if (is_string($text) && $text !== '') {
            $onDelta($text, 'answer');
        }
    }

    /** A short GET, for the status card. Returns null when nothing answers. */
    private function get(string $url, int $timeout): ?string
    {
        $handle = curl_init($url);

        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => $timeout,
        ]);

        $body = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);

        curl_close($handle);

        return is_string($body) && $status === 200 ? $body : null;
    }
}
