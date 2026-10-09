<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Project;
use App\Models\Scan;
use App\Services\DemoProjectBuilder;
use App\Services\GraphPayload;
use App\Services\ProjectManager;
use App\Support\Ini;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use App\Services\TechStack;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\View\View;

class ProjectController extends Controller
{
    public function __construct(
        private readonly ProjectManager $manager,
        private readonly GraphPayload $payload,
        private readonly DemoProjectBuilder $demo,
    ) {}

    public function index(): View
    {
        return view('projects.index', [
            'projects' => Project::with('latestScan')->latest('id')->get(),
            'demoFiles' => $this->demo->fileCount(),
            'totals' => [
                'projects' => Project::count(),
                'nodes' => (int) DB::table('graph_nodes')->count(),
                'edges' => (int) DB::table('graph_edges')->count(),
            ],
            // Surfaced in the UI so an upload that would be discarded by PHP is
            // caught before the user wastes five minutes waiting for it. The
            // browser re-reads the same numbers from api.atlas.capacity first,
            // so raising a limit never leaves a stale guard behind.
            'upload' => Ini::capacity() + [
                'ceiling' => Ini::uploadCeiling(),
                'ceiling_human' => Ini::forHumans(Ini::uploadCeiling()),
                'capacity_url' => route('api.atlas.capacity'),
            ],
        ]);
    }

    /** Accepts a .zip upload and starts the first scan. */
    public function store(Request $request): RedirectResponse
    {
        $capacity = Ini::capacity();

        $validated = $request->validate([
            'archive' => ['required', 'file', 'mimes:zip', 'max:'.(int) ($capacity['app_max_bytes'] / 1024)],
            'name' => ['nullable', 'string', 'max:120'],
        ], [
            'archive.mimes' => 'Please upload a .zip archive of your Laravel project (the folder that contains composer.json).',
            'archive.max' => 'That archive is larger than AtlasScope\'s own limit of '.$capacity['app_max_human'].'. Raise ATLAS_MAX_ARCHIVE_BYTES if that is intentional.',
            // PHP accepted the request but flagged the file itself: the message
            // has to name the exact ini setting or it is useless.
            'archive.uploaded' => 'The archive never finished arriving: PHP discarded it because it exceeds upload_max_filesize ('.$capacity['upload_max_filesize'].'). Re-zip your project without vendor/ and node_modules/, or restart the dev server with: '.$capacity['raise_command'].' ('.$capacity['raise_env'].').',
        ]);

        try {
            $project = $this->manager->storeUpload($validated['archive'], $validated['name'] ?? null);
        } catch (\Throwable $e) {
            return back()->withErrors(['archive' => $e->getMessage()])->withInput();
        }

        return redirect()->route('projects.atlas', $project);
    }

    public function storeDemo(): RedirectResponse
    {
        if (! config('atlas.demo_enabled', true)) {
            return back()->withErrors(['archive' => 'The demo project is disabled.']);
        }

        $project = $this->manager->createDemo();

        return redirect()->route('projects.atlas', $project);
    }

    public function show(Project $project): View
    {
        return view('projects.show', [
            'project' => $project->load('scans'),
        ]);
    }

    /** The observatory. */
    public function atlas(Project $project): View
    {
        $scan = $project->scans()->latest('id')->first();
        $completed = $this->completedScan($project);
        $hasGraph = $completed !== null;

        return view('atlas.show', [
            'project' => $project,
            'scan' => $scan,
            // What this project is built on, for the strip at the top of the
            // inspector: language, runtime, build system and named packages.
            'stack' => app(TechStack::class)->build($project, $completed ?? $scan),
            // Is there already a finished graph to look at? If so the scanning
            // overlay offers a way straight into it while a rescan runs.
            // What the tracer says when the scan turned up nothing to trace —
            // neither a route nor an entry point, so the dropdown is hidden and
            // this is all the reader gets. It is per language because "no routes"
            // and "no entry point" are different findings with different next
            // steps, and it is only ever shown in that empty state.
            'traceEmptyNote' => match ($project->language) {
                'php', 'csharp' => 'No routes were found in this project. Browse the atlas directly, or rescan it if the scan looks incomplete.',
                'cpp' => 'No entry point was found — there is no main() or executable target in this codebase. Select any function or class instead: its calls light up in the Connections tab.',
                'python' => 'No routes and no entry point were found. A Django or Flask project should have a urls.py or @app.route; a script should have a manage.py, a main.py or an `if __name__ == "__main__"` guard. Browse the atlas directly, or rescan it if the scan looks incomplete.',
                default => 'There is nothing to trace in this graph.',
            },
            'hasGraph' => $hasGraph,
            // What the tracer calls itself depends on the *graph*, not the
            // language: a Django app answers requests, a Python script is run.
            'hasRoutes' => $hasGraph && $scan !== null && $scan->nodes()->where('type', 'route')->exists(),
            'endpoints' => [
                'graph' => route('api.atlas.graph', $project),
                'status' => route('api.atlas.status', $project),
                'node' => route('api.atlas.nodes', ['project' => $project, 'key' => '__KEY__']),
                'file' => route('api.atlas.file', $project),
                'events' => route('api.atlas.events', $project),
                'export' => route('api.atlas.export', $project),
                'ai_status' => route('api.atlas.ai.status', $project),
                'ai_ask' => route('api.atlas.ai.ask', $project),
            ],
        ]);
    }

    /** JSON snapshot of the finished graph. */
    public function graph(Project $project): JsonResponse
    {
        $scan = $this->completedScan($project);

        if ($scan === null) {
            return response()->json([
                'ready' => false,
                'scan' => $this->scanState($project),
            ], 202);
        }

        return response()->json([
            'ready' => true,
            'scan' => $this->scanState($project),
            ...$this->payload->build($project, $scan),
        ]);
    }

    /** Polled while a scan runs. */
    public function status(Project $project): JsonResponse
    {
        return response()->json($this->scanState($project));
    }

    public function events(Project $project, Request $request): JsonResponse
    {
        $scan = $project->scans()->latest('id')->first();

        if ($scan === null) {
            return response()->json(['events' => []]);
        }

        $after = (int) $request->integer('after', 0);

        return response()->json([
            'scan_id' => $scan->id,
            'events' => $scan->events()
                ->where('id', '>', $after)
                ->limit(80)
                ->get()
                ->map(fn ($event) => [
                    'id' => $event->id,
                    'level' => $event->level,
                    'stage' => $event->stage,
                    'message' => $event->message,
                    'at' => optional($event->created_at)->toIso8601String(),
                ])
                ->all(),
        ]);
    }

    public function destroy(Project $project): RedirectResponse
    {
        $this->manager->destroy($project);

        return redirect()->route('projects.index')->with('status', 'Project deleted.');
    }

    public function rescan(Project $project): RedirectResponse
    {
        $this->manager->startScan($project);

        return redirect()->route('projects.atlas', $project);
    }

    /** Download the graph as JSON for external tooling. */
    public function export(Project $project)
    {
        $scan = $this->completedScan($project);

        abort_if($scan === null, 404, 'This project has no completed scan yet.');

        $filename = str_replace(' ', '-', strtolower($project->displayName())).'-atlas.json';

        return response()->json($this->payload->build($project, $scan), 200, [
            'Content-Disposition' => 'attachment; filename="'.$filename.'"',
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    }

    private function completedScan(Project $project): ?Scan
    {
        return $project->scans()
            ->where('status', \App\Enums\ScanStatus::Completed->value)
            ->latest('id')
            ->first();
    }

    private function scanState(Project $project): array
    {
        $scan = $project->scans()->latest('id')->first();

        if ($scan === null) {
            return ['id' => null, 'status' => 'queued', 'progress' => 0, 'stages' => []];
        }

        return $scan->toScanPayload() + ['atlas_url' => route('projects.atlas', $project)];
    }
}
