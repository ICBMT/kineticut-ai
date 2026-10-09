<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Enums\Layer;
use App\Models\GraphNode;
use App\Models\Project;
use App\Models\Scan;
use App\Support\Path;

/**
 * Finds the part of the project a question is about.
 *
 * A codebase never fits in a context window, so the question is matched against
 * the graph — keys, labels, signatures, file paths, layers, modules — and the
 * winners are turned into source excerpts read straight from the workspace,
 * using the line numbers the scan stored. Structural questions ("what calls
 * Renderer?") are answered from the edges rather than by guessing from text.
 */
class ContextBuilder
{
    /** Words that carry no signal when matching code. */
    private const STOPWORDS = [
        'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'to', 'of', 'in', 'on', 'at',
        'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'how', 'what',
        'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they',
        'me', 'my', 'our', 'your', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
        'explain', 'tell', 'show', 'describe', 'please', 'help', 'understand', 'work', 'works', 'does',
        'there', 'here', 'when', 'where', 'why', 'all', 'any', 'some', 'each', 'every', 'from', 'not',
    ];

    public function __construct(private readonly ProjectBrief $brief)
    {
    }

    /**
     * The messages handed to the model, plus the citations the panel will offer.
     *
     * `$onStep` is how the panel knows the assistant is working rather than
     * stuck: this method is the slow part of an answer (searching the graph,
     * reading files off disk, assembling the prompt), and it reports each stage
     * as it finishes. Nothing is reported after the model starts talking — from
     * there the answer itself is the progress.
     *
     * @param  array<int, array{role: string, content: string}>  $history
     * @param  (callable(array<string, mixed>): void)|null  $onStep
     * @return array{messages: array<int, array{role: string, content: string}>, citations: array<int, array<string, mixed>>, context_chars: int}
     */
    public function build(Project $project, Scan $scan, string $question, array $history = [], ?callable $onStep = null): array
    {
        $report = $onStep ?? static function (): void {
        };

        $tokens = $this->tokens($question);

        $report([
            'stage' => 'searching',
            'label' => $tokens === []
                ? 'Looking through the graph for the busiest code'
                : 'Searching the graph for '.$this->phrase($tokens),
        ]);

        $picked = $this->pick($scan, $tokens);

        $report([
            'stage' => 'selected',
            'label' => $picked->isEmpty()
                ? 'Nothing matched — answering from the project brief'
                : sprintf('%d node%s look relevant', $picked->count(), $picked->count() === 1 ? '' : 's'),
            'keys' => $picked->pluck('node_key')->take(8)->all(),
        ]);

        $graph = $this->edges($scan, $picked->pluck('node_key')->all());
        $read = $this->excerpts($project, $picked);
        $excerpts = $read['text'];

        if ($read['files'] !== []) {
            $report([
                'stage' => 'reading',
                'label' => sprintf('Reading %d file%s', count($read['files']), count($read['files']) === 1 ? '' : 's'),
                'files' => $read['files'],
            ]);
        }

        $citations = $picked->map(fn (GraphNode $node) => [
            'key' => $node->node_key,
            'label' => $node->label,
            'type' => $node->type->value,
            'type_label' => $node->type->label(),
            'layer' => $node->layer->value,
            'file' => $node->file_path,
            'line' => $node->line,
            'color' => null,
        ])->values()->all();

        $sections = [];

        if ($graph !== '') {
            $sections[] = "RELATIONSHIPS INVOLVING THE CODE BELOW:\n".$graph;
        }

        if ($excerpts !== '') {
            $sections[] = "SOURCE OF THE MOST RELEVANT FILES:\n".$excerpts;
        }

        $retrieved = $this->budget(implode("\n\n", $sections));
        $brief = $this->brief->text($project, $scan);

        $messages = [[
            'role' => 'system',
            'content' => $this->instructions()."\n\n".$brief,
        ]];

        foreach (array_slice($history, -6) as $turn) {
            $role = ($turn['role'] ?? 'user') === 'assistant' ? 'assistant' : 'user';
            $content = trim((string) ($turn['content'] ?? ''));

            if ($content !== '') {
                $messages[] = ['role' => $role, 'content' => mb_substr($content, 0, 4000)];
            }
        }

        $messages[] = [
            'role' => 'user',
            'content' => ($retrieved !== '' ? $retrieved."\n\n" : '').'QUESTION: '.$question,
        ];

        $report([
            'stage' => 'ready',
            'label' => sprintf('Sending %s of context (brief + %d excerpt%s)', $this->kilobytes(strlen($retrieved)), count($read['files']), count($read['files']) === 1 ? '' : 's'),
        ]);

        return [
            'messages' => $messages,
            'citations' => $citations,
            'context_chars' => strlen($retrieved),
        ];
    }

    /** The house style, which is mostly about not making things up. */
    private function instructions(): string
    {
        return <<<'TEXT'
        You are the assistant built into AtlasScope, a tool that maps a codebase as a 3D graph.

        You are looking at exactly one project, which has already been scanned. Its structure,
        entry points, key index and analysis findings are below, and for each question the most
        relevant source excerpts are supplied. Answer about THIS project — its real file paths,
        its real classes and functions.

        Rules:
        - Cite code by its key in double square brackets, exactly as the key index spells it, e.g.
          [[class:App\Services\ReportService]] and [[func:main]]. The interface turns those into
          buttons that open the node, so a citation is better than a file path.
        - Never invent keys, file paths, class names or behaviour. If the excerpts do not show
          something, say what you would need to look at instead.
        - Answer the question that was asked. Lead with the answer, then the evidence.
        - Be concise: a few short paragraphs or a short list. Explain what the code does and how it
          fits the architecture, not what each line says.
        - If the question is about the project as a whole, use the architecture, modules and entry
          points above; do not walk the reader through files.
        TEXT;
    }

    /* ------------------------------------------------------------ retrieval -- */

    /**
     * The nodes the question points at.
     *
     * Scoring is unapologetically simple — substring matches on the things a
     * person would type (a class name, a path, a layer) — because the graph is
     * small and the index is already ranked by importance: a weak match on a
     * hub beats a strong match on an unconnected node.
     *
     * @param  array<int, string>  $tokens
     * @return \Illuminate\Support\Collection<int, GraphNode>
     */
    private function pick(Scan $scan, array $tokens)
    {
        $limit = (int) config('atlas.ai.context_nodes', 8);

        if ($tokens === []) {
            return $this->fallback($scan, $limit);
        }

        $candidates = $scan->nodes()->orderByDesc('weight')->limit(1500)->get();
        $scored = [];

        foreach ($candidates as $node) {
            $haystack = mb_strtolower(implode(' ', array_filter([
                $node->node_key, $node->label, $node->fqcn, $node->file_path, $node->module, $node->type->value,
            ])));
            $score = 0.0;

            foreach ($tokens as $token) {
                if (! str_contains($haystack, $token)) {
                    continue;
                }

                $score += 6;

                // A token that matches the label itself is what the user meant.
                if (str_contains(mb_strtolower((string) $node->label), $token)
                    || str_contains(mb_strtolower((string) $node->fqcn), $token)) {
                    $score += 8;
                }

                if (str_contains(mb_strtolower((string) $node->node_key), $token)) {
                    $score += 4;
                }
            }

            if ($score === 0.0) {
                continue;
            }

            // Importance breaks ties: two classes called `Task` are not equally
            // interesting, and the busy one is usually the one being asked about.
            $score += min(4, ($node->fan_in + $node->fan_out) / 4) + min(2, $node->weight / 60);

            $scored[] = ['node' => $node, 'score' => $score];
        }

        usort($scored, fn (array $a, array $b) => $b['score'] <=> $a['score']);

        $picked = collect(array_slice($scored, 0, $limit))->map(fn (array $row) => $row['node']);

        return $picked->isEmpty() ? $this->fallback($scan, $limit) : $picked;
    }

    /** A question with no names in it ("what does this app do?") still deserves files. */
    private function fallback(Scan $scan, int $limit)
    {
        return $scan->nodes()
            ->whereIn('layer', [Layer::Entry->value, Layer::Http->value, Layer::Application->value])
            ->orderByDesc('fan_in')
            ->orderByDesc('weight')
            ->limit($limit)
            ->get();
    }

    /** @param array<int, string> $keys */
    private function edges(Scan $scan, array $keys): string
    {
        if ($keys === []) {
            return '';
        }

        $edges = $scan->edges()
            ->where(fn ($query) => $query->whereIn('source_key', $keys)->orWhereIn('target_key', $keys))
            ->orderByDesc('weight')
            ->limit(28)
            ->get();

        if ($edges->isEmpty()) {
            return '';
        }

        $labels = $scan->nodes()->whereIn('node_key', $edges->flatMap(fn ($edge) => [$edge->source_key, $edge->target_key])->unique()->all())
            ->pluck('label', 'node_key');

        return $edges->map(fn ($edge) => sprintf(
            '  %s → %s (%s)',
            $labels[$edge->source_key] ?? $edge->source_key,
            $labels[$edge->target_key] ?? $edge->target_key,
            $edge->label ?: $edge->kind->value,
        ))->implode("\n");
    }

    /** Source for the picked nodes, read from the workspace. */
    /**
     * The source of the picked nodes, with the lines the scan pointed at.
     *
     * Returns the prompt text *and* the list of files that were genuinely read:
     * a node whose file has since moved is skipped, and the panel's trail must
     * show what the model was really given, not what was hoped for.
     *
     * @return array{text: string, files: array<int, array{path: string, label: string, key: string, line: ?int, lines: int}>}
     */
    private function excerpts(Project $project, $picked): array
    {
        $root = realpath($project->sourcePath());
        $window = (int) config('atlas.ai.excerpt_lines', 90);
        $blocks = [];
        $files = [];
        $seen = [];

        foreach ($picked as $node) {
            if (! $node->file_path || isset($seen[$node->file_path.':'.($node->line ?? 0)])) {
                continue;
            }

            $seen[$node->file_path.':'.($node->line ?? 0)] = true;

            $absolute = realpath($project->sourcePath().'/'.$node->file_path);

            if ($root === false || $absolute === false || ! Path::isInside($absolute, $root) || ! is_file($absolute)) {
                continue;
            }

            if (filesize($absolute) > 512_000) {
                continue;
            }

            $lines = file($absolute, FILE_IGNORE_NEW_LINES);
            $total = count($lines);
            $middle = max(1, (int) ($node->line ?? 1));
            $from = max(1, $middle - (int) ($window / 3));
            $to = min($total, $from + $window - 1);

            $body = [];

            for ($line = $from; $line <= $to; $line++) {
                $marker = $line === $middle ? '>' : ' ';
                $body[] = sprintf('%s%4d│ %s', $marker, $line, $lines[$line - 1]);
            }

            $blocks[] = sprintf(
                "--- %s — %s (%s, lines %d–%d of %d) ---\n%s",
                $node->node_key,
                $node->label,
                $node->file_path,
                $from,
                $to,
                $total,
                implode("\n", $body),
            );

            $files[] = [
                'path' => $node->file_path,
                'label' => (string) $node->label,
                'key' => $node->node_key,
                'line' => $node->line !== null ? (int) $node->line : null,
                'lines' => $to - $from + 1,
            ];
        }

        return ['text' => implode("\n\n", $blocks), 'files' => $files];
    }

    /** Keep the retrieved half of the prompt inside its character budget. */
    private function budget(string $text): string
    {
        $limit = (int) config('atlas.ai.context_chars', 14000);

        if (strlen($text) <= $limit) {
            return $text;
        }

        // Cut on a line boundary so an excerpt is never sliced mid-statement.
        $cut = substr($text, 0, $limit);
        $break = strrpos($cut, "\n");

        return ($break === false ? $cut : substr($cut, 0, $break))."\n… (more code was found than fits; ask about a specific class or file to read it)";
    }

    /** @return array<int, string> */
    /** The words that did the matching, in a sentence a person can read. */
    private function phrase(array $tokens): string
    {
        $words = array_slice(array_values(array_unique($tokens)), 0, 4);

        return '“'.implode('”, “', $words).'”';
    }

    /** Bytes as something the panel can put in a label. */
    private function kilobytes(int $bytes): string
    {
        return $bytes >= 1000
            ? number_format($bytes / 1000, 1).' kB'
            : $bytes.' bytes';
    }

    private function tokens(string $question): array
    {
        // Quoted phrases first: "the retry helper" is a stronger signal than
        // four separate words.
        $phrases = [];
        preg_match_all('/["\'`]([^"\'`]{3,60})["\'`]/u', $question, $matches);

        foreach ($matches[1] as $phrase) {
            $trimmed = trim(mb_strtolower($phrase));

            if ($trimmed !== '') {
                $phrases[] = $trimmed;
            }
        }

        $words = preg_split('/[^\p{L}\p{N}_\\\\:\/.-]+/u', mb_strtolower($question)) ?: [];

        $tokens = $phrases;

        foreach ($words as $word) {
            $word = trim($word, '.:-/\\');

            if (mb_strlen($word) < 3 || in_array($word, self::STOPWORDS, true)) {
                continue;
            }

            $tokens[] = $word;
        }

        return array_values(array_unique(array_slice($tokens, 0, 24)));
    }
}
