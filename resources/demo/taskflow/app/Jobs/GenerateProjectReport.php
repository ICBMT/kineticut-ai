<?php

namespace App\Jobs;

use App\Models\Project;
use App\Services\ReportService;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Storage;

class GenerateProjectReport implements ShouldQueue
{
    use Queueable;

    public int $timeout = 300;

    public function __construct(public readonly int $projectId) {}

    public function handle(ReportService $reports): void
    {
        $project = Project::findOrFail($this->projectId);
        $health = $reports->projectHealth($project);

        $path = sprintf('reports/%s-%s.json', $project->slug, now()->format('Y-m-d'));
        Storage::disk(config('taskflow.reports.disk'))->put($path, json_encode($health, JSON_PRETTY_PRINT));
    }
}
