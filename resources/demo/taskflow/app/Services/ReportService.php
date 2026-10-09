<?php

namespace App\Services;

use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

class ReportService
{
    public function weeklySummary(User $user): array
    {
        return Cache::remember("taskflow.summary.{$user->id}", 300, function () use ($user) {
            $tasks = Task::assignedTo($user->id);

            return [
                'open' => (clone $tasks)->whereNull('completed_at')->count(),
                'overdue' => (clone $tasks)->overdue()->count(),
                'completed_this_week' => (clone $tasks)
                    ->whereBetween('completed_at', [now()->startOfWeek(), now()->endOfWeek()])
                    ->count(),
                'focus_minutes' => (clone $tasks)->sum('estimate_minutes'),
            ];
        });
    }

    public function throughput(User $user): array
    {
        return Task::query()
            ->where('assignee_id', $user->id)
            ->whereNotNull('completed_at')
            ->select(DB::raw('date(completed_at) as day'), DB::raw('count(*) as total'))
            ->groupBy('day')
            ->orderBy('day')
            ->get()
            ->all();
    }

    public function projectHealth(Project $project): array
    {
        $tasks = $project->tasks();

        return [
            'completion_rate' => round(
                (clone $tasks)->whereNotNull('completed_at')->count() / max(1, (clone $tasks)->count()) * 100,
                1
            ),
            'blocked' => (clone $tasks)->where('status', 'blocked')->count(),
        ];
    }

    public function invalidate(int $projectId): void
    {
        Cache::forget("taskflow.project.{$projectId}");
        Cache::forget('taskflow.overview');
    }
}
