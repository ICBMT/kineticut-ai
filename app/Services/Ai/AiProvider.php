<?php

declare(strict_types=1);

namespace App\Services\Ai;

/**
 * A local chat model.
 *
 * Deliberately tiny: the atlas only needs to know *what is running* and how to
 * stream a reply token by token. Ollama implements this today; LM Studio and
 * llama.cpp's server speak the same OpenAI-shaped protocol, so a second
 * implementation is a class, not a rewrite.
 */
interface AiProvider
{
    /** Human name for the status card: "Ollama", "LM Studio". */
    public function name(): string;

    /**
     * What is listening, and what models it has.
     *
     * Never throws: a status check is how the panel discovers that nothing is
     * running, and "nothing is running" is a normal answer, not an error.
     *
     * @return array{available: bool, endpoint: string, models: array<int, string>, error: ?string}
     */
    public function status(): array;

    /**
     * Stream a completion.
     *
     * `$onDelta` is called with each fragment of text as it arrives — that is
     * what makes the panel type rather than pause. Implementations must close
     * the stream and return when the model stops.
     *
     * The second argument says what kind of fragment it is: `answer` for the
     * reply itself, `thinking` for a reasoning model's private notes (`qwen3`
     * and friends emit those through the same stream). Passing them separately
     * is what lets the panel show the model working without mixing its
     * deliberation into the answer.
     *
     * @param  array<int, array{role: string, content: string}>  $messages
     * @param  callable(string, string=): void  $onDelta
     */
    public function chat(array $messages, string $model, callable $onDelta): void;
}
