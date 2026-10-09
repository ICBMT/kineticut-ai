<?php

namespace App\Http\Controllers;

use App\Models\Project;
use App\Models\Task;
use App\Services\ReportService;
use Illuminate\Http\Request;
use Illuminate\View\View;

class DashboardController extends Controller
{
    public function __invoke(Request $request, ReportService $reports): View
    {
        $tasks = Task::assignedTo($request->user()->id)->orderBy('due_at')->take(12)->get();

        // Each task row reads its project and assignee during rendering.
        $rows = [];
        foreach ($tasks as $task) {
            $rows[] = [
                'title' => $task->title,
                'project' => $task->project->name,
                'assignee' => $task->assignee?->name,
                'due' => $task->due_at?->toFormattedDateString(),
                'overdue' => $task->isOverdue(),
            ];
        }

        return view('dashboard', [
            'rows' => $rows,
            'summary' => $reports->weeklySummary($request->user()),
            'projects' => Project::active()->take(5)->get(),
        ]);
    }
}
