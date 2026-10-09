<?php

namespace App\Actions;

use App\Data\TaskData;
use App\Enums\TaskStatus;
use App\Models\Task;
use App\Models\User;
use App\Services\TaskService;

class CreateTaskAction
{
    public function __construct(private readonly TaskService $tasks) {}

    public function handle(User $user, TaskData $data): Task
    {
        $task = $this->tasks->create($user, $data->toArray());

        if ($data->assigneeId !== null) {
            $task->update(['status' => TaskStatus::InProgress->value]);
        }

        return $task->refresh();
    }
}
