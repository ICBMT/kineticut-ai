<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Enums\Language;
use App\Models\GraphEdge;
use App\Models\GraphNode;
use App\Models\Project;
use App\Models\Scan;
use App\Support\Ini;
use App\Support\Path;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Read-only JSON endpoints used by the observatory UI.
 */
class AtlasApiController extends Controller
{
    /**
     * What this server will actually accept right now.
     *
     * The landing page reads the same numbers while rendering, but a page can
     * be older than a php.ini change — so the browser re-asks here before it
     * decides anything about a file the user picked.
     */
    public function capacity(): JsonResponse
    {
        return response()
            ->json(Ini::capacity())
            ->header('Cache-Control', 'no-store, max-age=0');
    }

    /**
     * Find a node by key, allowing for the one character the router eats.
     *
     * Laravel matches a request against a copy of the URI with its trailing
     * slash removed (`CompiledRouteCollection::requestWithoutTrailingSlash`),
     * so a node whose key *ends* in a slash arrives one character short —
     * `route:GET /` is how a Django project spells its front page, and a Laravel
     * `Route::get('/')` lands on exactly the same key. Asking for `$key.'/'`
     * as well is what makes those nodes reachable at all.
     *
     * @return GraphNode|null
     */
    private function nodeByKey(int $scanId, string $key): ?GraphNode
    {
        foreach ([$key, $key.'/'] as $candidate) {
            $node = GraphNode::where('scan_id', $scanId)->where('node_key', $candidate)->first();

            if ($node !== null) {
                return $node;
            }
        }

        return null;
    }

    /** Full node detail: methods, columns, relations, captures and neighbours. */
    public function node(Project $project, string $key): JsonResponse
    {
        $scan = $this->scan($project);

        if ($scan === null) {
            return response()->json(['error' => 'No completed scan for this project.'], 404);
        }

        /** @var GraphNode|null $node */
        $node = $this->nodeByKey($scan->id, $key);

        if ($node === null) {
            return response()->json(['error' => 'Node not found.'], 404);
        }

        // The key that was found, not the one that was asked for: the router
        // trims a trailing slash (see nodeByKey) and every edge lookup below
        // has to use the key as it is actually stored.
        $key = $node->node_key;

        $edges = GraphEdge::where('scan_id', $scan->id)
            ->where(fn ($query) => $query->where('source_key', $key)->orWhere('target_key', $key))
            ->orderByDesc('weight')
            ->get();

        $neighbourKeys = $edges
            ->flatMap(fn (GraphEdge $edge) => [$edge->source_key, $edge->target_key])
            ->unique()
            ->reject(fn (string $neighbour) => $neighbour === $key)
            ->values()
            ->all();

        $neighbours = GraphNode::where('scan_id', $scan->id)
            ->whereIn('node_key', $neighbourKeys)
            ->get()
            ->keyBy('node_key');

        return response()->json([
            'key' => $node->node_key,
            'label' => $node->label,
            'type' => $node->type->value,
            'type_label' => $node->type->label($project->language()),
            'glyph' => $node->type->glyph(),
            'layer' => $node->layer->value,
            'layer_label' => $node->layer->label(),
            'color' => $node->layer->color(),
            'fqcn' => $node->fqcn,
            'file' => $node->file_path,
            'line' => $node->line,
            'module' => $node->module,
            'loc' => $node->loc,
            'weight' => $node->weight,
            'fan_in' => $node->fan_in,
            'fan_out' => $node->fan_out,
            'meta' => $node->meta ?? [],
            'edges_in' => $edges->where('target_key', $key)->map(fn (GraphEdge $edge) => $this->edgePayload($edge, $neighbours->get($edge->source_key), 'in', $project->language()))->values()->all(),
            'edges_out' => $edges->where('source_key', $key)->map(fn (GraphEdge $edge) => $this->edgePayload($edge, $neighbours->get($edge->target_key), 'out', $project->language()))->values()->all(),
        ]);
    }

    /** Source code of a file inside the scanned project (sandboxed). */
    public function file(Project $project, Request $request): JsonResponse
    {
        $path = Path::normalize((string) $request->query('path', ''));
        $root = $project->sourcePath();

        abort_if($path === '', 400, 'A path parameter is required.');

        $absolute = $root.'/'.$path;
        $real = realpath($absolute);

        if ($real === false || ! file_exists($real) || ! is_file($real)) {
            return response()->json(['error' => 'File not found in this project.'], 404);
        }

        if (! Path::isInside($real, realpath($root) ?: $root)) {
            return response()->json(['error' => 'That path is outside the project.'], 403);
        }

        /*
         * The readable-extension list used to be Laravel's: `.php`, `.blade.php`
         * and a handful of web formats. That made the Source tab useless on a
         * C++ or C# project — every file it wanted to show was refused — so the
         * project's own language decides now, and anything else is judged by
         * what it actually contains rather than by its name.
         */
        if (! $this->previewable($path, $project)) {
            return response()->json([
                'error' => 'Preview is only available for text files.',
            ], 415);
        }

        $size = (int) filesize($real);

        if ($size > 512_000) {
            return response()->json(['error' => 'File is too large to preview ('.$size.' bytes).'], 413);
        }

        return response()->json([
            'path' => $path,
            'size' => $size,
            'lines' => substr_count((string) file_get_contents($real), "\n") + 1,
            'content' => (string) file_get_contents($real),
            'highlight_from' => (int) $request->integer('from', 0),
            'highlight_to' => (int) $request->integer('to', 0),
        ]);
    }

    /** Text formats the Source tab can render, whatever language wrote them. */
    private const TEXT_EXTENSIONS = [
        'js', 'ts', 'jsx', 'tsx', 'vue', 'svelte', 'json', 'css', 'scss', 'sass', 'less',
        'md', 'markdown', 'env', 'yml', 'yaml', 'txt', 'xml', 'sql', 'html', 'htm', 'ini',
        'cfg', 'conf', 'toml', 'sh', 'bash', 'bat', 'ps1', 'py', 'rb', 'go', 'rs', 'java',
        'kt', 'swift', 'gradle', 'properties', 'sln', 'csproj', 'vbproj', 'fsproj', 'props',
        'targets', 'cmake', 'mk', 'pdb', 'diff', 'patch',
    ];

    /**
     * Can the viewer show this file?
     *
     * Names come first — the language's own source extensions plus the usual
     * text formats. A file the name check does not recognise is still shown
     * when its opening block is text: valid UTF-8 with no control bytes, which
     * is what separates source from a PNG.
     */
    private function previewable(string $path, Project $project): bool
    {
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $language = $project->language();

        if (in_array($extension, self::TEXT_EXTENSIONS, true)
            || in_array($extension, $language->sourceExtensions(), true)
            || in_array(basename($path), $language->manifestFiles(), true)) {
            return true;
        }

        $sample = (string) file_get_contents($project->sourcePath().'/'.$path, false, null, 0, 8192);

        return preg_match('//u', $sample) === 1
            && preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', $sample) !== 1;
    }

    /** Free-text search across the graph. */
    public function search(Project $project, Request $request): JsonResponse
    {
        $scan = $this->scan($project);

        if ($scan === null) {
            return response()->json(['results' => []]);
        }

        $term = trim((string) $request->query('q', ''));
        $language = $project->language();

        if (mb_strlen($term) < 2) {
            return response()->json(['results' => []]);
        }

        $like = '%'.str_replace(['%', '_'], ['\%', '\_'], $term).'%';

        $results = GraphNode::where('scan_id', $scan->id)
            ->where(function ($query) use ($like) {
                $query->where('label', 'like', $like)
                    ->orWhere('fqcn', 'like', $like)
                    ->orWhere('file_path', 'like', $like)
                    ->orWhere('node_key', 'like', $like);
            })
            ->orderByDesc('weight')
            ->limit(40)
            ->get()
            ->map(fn (GraphNode $node) => [
                'key' => $node->node_key,
                'label' => $node->label,
                'type' => $node->type->value,
                'type_label' => $node->type->label($language),
                'layer' => $node->layer->value,
                'color' => $node->layer->color(),
                'file' => $node->file_path,
                'line' => $node->line,
                'score' => $node->weight,
            ])
            ->all();

        return response()->json(['term' => $term, 'results' => $results]);
    }

    /** Edges around one or more nodes — used by the tracer and the inspector. */
    public function neighbourhood(Project $project, Request $request): JsonResponse
    {
        $scan = $this->scan($project);

        if ($scan === null) {
            return response()->json(['edges' => []]);
        }

        $keys = array_slice((array) $request->query('keys', []), 0, 40);
        $keys = array_values(array_filter(array_map('strval', $keys)));

        if ($keys === []) {
            return response()->json(['edges' => []]);
        }

        $edges = GraphEdge::where('scan_id', $scan->id)
            ->whereIn('source_key', $keys)
            ->whereIn('target_key', $keys)
            ->get()
            ->map(fn (GraphEdge $edge) => [
                'source' => $edge->source_key,
                'target' => $edge->target_key,
                'kind' => $edge->kind->value,
                'label' => $edge->label,
            ])
            ->all();

        return response()->json(['edges' => $edges]);
    }

    private function edgePayload(GraphEdge $edge, ?GraphNode $other, string $direction, ?Language $language = null): array
    {
        return [
            'key' => $other?->node_key,
            'label' => $other?->label,
            'type' => $other?->type->value,
            'type_label' => $other?->type->label($language),
            'color' => $other?->layer->color(),
            'file' => $other?->file_path,
            'line' => $other?->line,
            'kind' => $edge->kind->value,
            'kind_label' => $edge->kind->label(),
            'edge_label' => $edge->label,
            'weight' => (float) $edge->weight,
            'direction' => $direction,
        ];
    }

    private function scan(Project $project): ?Scan
    {
        return $project->scans()
            ->where('status', \App\Enums\ScanStatus::Completed->value)
            ->latest('id')
            ->first();
    }
}
