<?php

namespace App\Services;

use App\Enums\TaskStatus;
use App\Events\TaskCreated;
use App\Jobs\SendTaskReminder;
use App\Models\Task;
use App\Models\User;
use App\Notifications\TaskAssignedNotification;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

class TaskService
{
    public function __construct(private readonly ReportService $reports) {}

    public function listFor(User $user, array $filters = []): LengthAwarePaginator
    {
        return Task::query()
            ->with(['project:id,name', 'assignee:id,name'])
            ->when($filters['status'] ?? null, fn ($query, $status) => $query->where('status', $status))
            ->when($filters['priority'] ?? null, fn ($query, $priority) => $query->where('priority', $priority))
            ->when($filters['project'] ?? null, fn ($query, $project) => $query->where('project_id', $project))
            ->where(function ($query) use ($user) {
                $query->where('assignee_id', $user->id)->orWhere('creator_id', $user->id);
            })
            ->latest()
            ->paginate(25);
    }

    public function create(User $user, array $attributes): Task
    {
        $task = DB::transaction(function () use ($user, $attributes) {
            $task = Task::create($attributes + [
                'creator_id' => $user->id,
                'status' => $attributes['status'] ?? TaskStatus::Todo->value,
            ]);

            foreach ($attributes['tags'] ?? [] as $tag) {
                $task->tags()->firstOrCreate(['name' => $tag], ['color' => '#64748b']);
            }

            return $task;
        });

        event(new TaskCreated($task, $user));

        if ($task->assignee_id !== null && $task->assignee_id !== $user->id) {
            $task->assignee->notify(new TaskAssignedNotification($task));
        }

        SendTaskReminder::dispatch($task)->delay(now()->addHours(6));

        Cache::forget('taskflow.overview');

        return $task;
    }

    public function assign(Task $task, int $userId): Task
    {
        $task->update(['assignee_id' => $userId]);
        $this->reports->invalidate($task->project_id);

        return $task;
    }
}
