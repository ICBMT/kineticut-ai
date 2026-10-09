<?php

namespace App\Actions;

use App\Events\TaskCompleted;
use App\Models\Task;
use App\Models\User;
use App\Services\ReportService;

class CompleteTaskAction
{
    public function __construct(private readonly ReportService $reports) {}

    public function handle(Task $task, User $user): Task
    {
        if ($task->completed_at !== null) {
            return $task;
        }

        $task->forceFill([
            'completed_at' => now(),
            'status' => 'done',
        ])->save();

        event(new TaskCompleted($task, $user));
        $this->reports->invalidate($task->project_id);

        return $task;
    }
}
