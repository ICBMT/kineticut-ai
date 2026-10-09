<?php

namespace App\Livewire;

use App\Models\Task;
use App\Services\TaskService;
use Illuminate\Contracts\View\View;
use Livewire\Component;
use Livewire\WithPagination;

class TaskTable extends Component
{
    use WithPagination;

    public string $status = '';

    public string $priority = '';

    public function updating(string $field): void
    {
        if (in_array($field, ['status', 'priority'], true)) {
            $this->resetPage();
        }
    }

    public function complete(int $taskId, TaskService $tasks): void
    {
        $task = Task::findOrFail($taskId);
        $this->authorize('complete', $task);
        $tasks->assign($task->refresh(), auth()->id());
    }

    public function render(TaskService $tasks): View
    {
        return view('livewire.task-table', [
            'tasks' => $tasks->listFor(auth()->user(), [
                'status' => $this->status ?: null,
                'priority' => $this->priority ?: null,
            ]),
        ]);
    }
}
