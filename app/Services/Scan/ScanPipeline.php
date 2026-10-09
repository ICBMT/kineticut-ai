<?php

declare(strict_types=1);

namespace App\Services\Scan;

use App\Enums\ScanStage as StageEnum;
use App\Enums\ScanStatus;
use App\Models\GraphEdge;
use App\Models\GraphNode;
use App\Models\Scan;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Runs every stage in order, timing each one, streaming progress into the scan
 * record and finally persisting the finished graph.
 */
class ScanPipeline
{
    /** @param iterable<Stage> $stages */
    public function __construct(private readonly iterable $stages) {}

    public function run(ScanContext $context): void
    {
        $scan = $context->scan;
        $scan->update([
            'status' => ScanStatus::Running->value,
            'started_at' => now(),
            'error' => null,
            'progress' => 1,
        ]);

        $started = microtime(true);
        $metrics = [];

        foreach ($this->stages as $stage) {
            $enum = $stage->name();
            $scan->markStage($enum, 'running');
            $context->log('→ '.$enum->label(), 'info', [], true);

            $stageStart = microtime(true);

            try {
                $result = $stage->run($context);
            } catch (Throwable $e) {
                $scan->markStage($enum, 'failed', ['error' => $e->getMessage()]);
                $scan->update([
                    'status' => ScanStatus::Failed->value,
                    'error' => $enum->label().' failed: '.$e->getMessage(),
                    'finished_at' => now(),
                    'duration_ms' => (int) ((microtime(true) - $started) * 1000),
                ]);
                $context->log('✗ '.$enum->label().' failed: '.$e->getMessage(), 'error', [
                    'exception' => get_class($e),
                ], true);

                throw $e;
            }

            $ms = (int) ((microtime(true) - $stageStart) * 1000);
            $scan->refresh()->markStage($enum, 'done', $result['summary'] ?? null, $ms);

            if (! empty($result['metrics'])) {
                $metrics = array_replace($metrics, $result['metrics']);
            }

            $context->log('✓ '.$enum->label().($result['summary'] ? ' — '.$result['summary'] : ''), 'success');
        }

        $this->persistGraph($context);

        $counts = DB::table('graph_nodes')->where('scan_id', $scan->id)->count();
        $edgeCount = DB::table('graph_edges')->where('scan_id', $scan->id)->count();

        $scan->refresh()->update([
            'status' => ScanStatus::Completed->value,
            'progress' => 100,
            'metrics' => $metrics,
            'node_count' => $counts,
            'edge_count' => $edgeCount,
            'finished_at' => now(),
            'duration_ms' => (int) ((microtime(true) - $started) * 1000),
        ]);

        $context->project->update([
            'last_scanned_at' => now(),
            'file_count' => $scan->file_count,
        ]);

        $context->log(sprintf(
            'Scan complete: %s nodes, %s relationships in %.1fs',
            number_format($counts),
            number_format($edgeCount),
            (microtime(true) - $started)
        ), 'success', [], true);
    }

    /** Bulk-insert the finished graph in chunks so big projects stay fast. */
    private function persistGraph(ScanContext $context): void
    {
        $scanId = $context->scan->id;

        GraphNode::where('scan_id', $scanId)->delete();
        GraphEdge::where('scan_id', $scanId)->delete();

        $payload = $context->readArtifact('graph');
        $nodes = $payload['nodes'] ?? [];
        $edges = $payload['edges'] ?? [];

        $now = now()->toDateTimeString();

        foreach (array_chunk($nodes, 400) as $chunk) {
            GraphNode::insert(array_map(fn (array $node) => [
                'scan_id' => $scanId,
                'node_key' => $node['key'],
                'type' => $node['type'],
                'layer' => $node['layer'],
                'label' => mb_substr((string) $node['label'], 0, 191),
                'fqcn' => isset($node['fqcn']) ? mb_substr((string) $node['fqcn'], 0, 191) : null,
                'file_path' => $node['file'] ?? null,
                'line' => $node['line'] ?? null,
                'module' => isset($node['module']) ? mb_substr((string) $node['module'], 0, 191) : null,
                'parent_key' => $node['parent'] ?? null,
                'weight' => (int) ($node['weight'] ?? 30),
                'fan_in' => (int) ($node['fan_in'] ?? 0),
                'fan_out' => (int) ($node['fan_out'] ?? 0),
                'loc' => (int) ($node['loc'] ?? 0),
                'pos_x' => (float) ($node['pos_x'] ?? 0),
                'pos_y' => (float) ($node['pos_y'] ?? 0),
                'pos_z' => (float) ($node['pos_z'] ?? 0),
                'meta' => json_encode($node['meta'] ?? [], JSON_UNESCAPED_SLASHES),
                'created_at' => $now,
                'updated_at' => $now,
            ], $chunk));
        }

        foreach (array_chunk($edges, 500) as $chunk) {
            GraphEdge::insert(array_map(fn (array $edge) => [
                'scan_id' => $scanId,
                'source_key' => $edge['source'],
                'target_key' => $edge['target'],
                'kind' => $edge['kind'],
                'label' => isset($edge['label']) ? mb_substr((string) $edge['label'], 0, 191) : null,
                'weight' => (float) ($edge['weight'] ?? 1),
                'hits' => (int) ($edge['hits'] ?? 1),
                'meta' => json_encode($edge['meta'] ?? [], JSON_UNESCAPED_SLASHES),
                'created_at' => $now,
                'updated_at' => $now,
            ], $chunk));
        }

        $context->scan->refresh()->update([
            'node_count' => count($nodes),
            'edge_count' => count($edges),
        ]);

        $metrics = $context->scan->metrics ?? [];
        $metrics['graph'] = ['nodes' => count($nodes), 'edges' => count($edges)];
        $context->scan->refresh()->update(['metrics' => $metrics]);

        // Free the heavy artefact now that it lives in the database.
        @unlink($context->artifactPath('graph'));
    }

    /** Pipeline order for the container binding. */
    public static function stageOrder(): array
    {
        return StageEnum::pipeline();
    }
}
