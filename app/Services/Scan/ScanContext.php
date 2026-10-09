<?php

declare(strict_types=1);

namespace App\Services\Scan;

use App\Enums\Language;
use App\Models\Project;
use App\Models\Scan;
use App\Models\ScanEvent;
use App\Support\GraphBuilder;
use Illuminate\Support\Facades\File;

/**
 * Shared state handed to every pipeline stage: where the code is, where we
 * stash intermediate artefacts, how to stream progress back to the browser,
 * and the growing graph itself.
 */
class ScanContext
{
    public function __construct(
        public readonly Scan $scan,
        public readonly Project $project,
        public string $root,
        public readonly bool $verbose = false,
        /**
         * The language of the code being scanned. It selects the stage plan and
         * tunes the Laravel-only stages off, so every stage can stay ignorant of
         * how it was scheduled.
         */
        public readonly Language $language = Language::Php,
    ) {}

    public function workspace(string $append = ''): string
    {
        return $this->project->workspacePath($append);
    }

    public function artifactPath(string $name): string
    {
        return $this->workspace('.atlas/'.$name.'.json');
    }

    public function writeArtifact(string $name, array $payload): void
    {
        $path = $this->artifactPath($name);
        File::ensureDirectoryExists(dirname($path));
        file_put_contents($path, json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    public function readArtifact(string $name): array
    {
        $path = $this->artifactPath($name);

        if (! is_file($path)) {
            return [];
        }

        $decoded = json_decode((string) file_get_contents($path), true);

        return is_array($decoded) ? $decoded : [];
    }

    public function hasArtifact(string $name): bool
    {
        return is_file($this->artifactPath($name));
    }

    /** True while the Laravel-only pipelines are applicable. */
    public function isLaravel(): bool
    {
        return $this->language === Language::Php;
    }

    /** Persist the working graph so the Layout stage (and the UI) can read it. */
    public function persistGraph(GraphBuilder $graph): void
    {
        $this->writeArtifact('graph', $graph->toArray());
    }

    public function loadGraph(): GraphBuilder
    {
        $graph = new GraphBuilder;
        $payload = $this->readArtifact('graph');

        foreach ($payload['nodes'] ?? [] as $node) {
            $graph->node(
                $node['key'],
                \App\Enums\NodeType::tryFrom($node['type']) ?? \App\Enums\NodeType::Interface_,
                $node['label'] ?? $node['key'],
                $node
            );
        }

        foreach ($payload['edges'] ?? [] as $edge) {
            $graph->edge(
                $edge['source'],
                $edge['target'],
                \App\Enums\EdgeKind::tryFrom($edge['kind']) ?? \App\Enums\EdgeKind::Uses,
                $edge
            );
        }

        return $graph;
    }

    public function log(string $message, string $level = 'info', array $context = [], bool $checkpoint = false): void
    {
        // Keep the event table useful without letting a big scan flood it.
        static $seen = [];
        $fingerprint = md5($level.$message);

        if (isset($seen[$fingerprint]) && ! $checkpoint) {
            return;
        }

        $seen[$fingerprint] = true;

        try {
            ScanEvent::create([
                'scan_id' => $this->scan->id,
                'level' => $level,
                'stage' => $this->scan->stage,
                'message' => $message,
                'context' => $context ?: null,
                'created_at' => now(),
            ]);
        } catch (\Throwable) {
            // Logging must never break a scan.
        }

        if ($this->verbose) {
            $colour = match ($level) {
                'error' => "\033[31m",
                'warn' => "\033[33m",
                'success' => "\033[32m",
                default => "\033[90m",
            };
            fwrite(STDOUT, $colour.'  • '.$message."\033[0m\n");
        }
    }

    /** @return array<int, string> */
    public function tags(): array
    {
        return $this->project->meta['tags'] ?? [];
    }
}
