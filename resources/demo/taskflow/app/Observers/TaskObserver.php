<?php

namespace App\Observers;

use App\Events\TaskCompleted;
use App\Models\Task;
use App\Services\ReportService;
use Illuminate\Support\Facades\Cache;

class TaskObserver
{
    public function __construct(private readonly ReportService $reports) {}

    public function created(Task $task): void
    {
        $this->reports->invalidate($task->project_id);
    }

    public function updated(Task $task): void
    {
        Cache::forget("taskflow.task.{$task->id}");
    }

    public function deleted(Task $task): void
    {
        $this->reports->invalidate($task->project_id);
    }
}
