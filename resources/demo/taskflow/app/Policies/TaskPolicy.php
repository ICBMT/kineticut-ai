<?php

namespace App\Policies;

use App\Models\Task;
use App\Models\User;

class TaskPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->exists;
    }

    public function view(User $user, Task $task): bool
    {
        return $user->id === $task->creator_id
            || $user->id === $task->assignee_id
            || $task->project->members()->whereKey($user->id)->exists();
    }

    public function create(User $user): bool
    {
        return $user->exists;
    }

    public function update(User $user, Task $task): bool
    {
        return $user->id === $task->creator_id || $user->id === $task->assignee_id;
    }

    public function delete(User $user, Task $task): bool
    {
        return $user->id === $task->creator_id || $user->isAdmin();
    }

    public function complete(User $user, Task $task): bool
    {
        return $this->update($user, $task);
    }
}
