<?php

namespace App\Http\Controllers;

use App\Actions\CompleteTaskAction;
use App\Actions\CreateTaskAction;
use App\Data\TaskData;
use App\Http\Requests\StoreTaskRequest;
use App\Http\Requests\UpdateTaskRequest;
use App\Http\Resources\TaskResource;
use App\Models\Task;
use App\Services\TaskService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class TaskController extends Controller
{
    public function __construct(
        private readonly TaskService $tasks,
        private readonly CreateTaskAction $createTask,
        private readonly CompleteTaskAction $completeTask,
    ) {
        $this->middleware('auth');
        $this->authorizeResource(Task::class, 'task');
    }

    public function index(Request $request): View
    {
        $tasks = $this->tasks->listFor($request->user(), $request->only('status', 'priority', 'project'));

        return view('tasks.index', ['tasks' => $tasks]);
    }

    public function create(): View
    {
        $this->authorize('create', Task::class);

        return view('tasks.create', ['task' => new Task]);
    }

    public function store(StoreTaskRequest $request): RedirectResponse
    {
        $task = $this->createTask->handle($request->user(), TaskData::fromRequest($request));

        return redirect()
            ->route('tasks.show', $task)
            ->with('status', 'Task created.');
    }

    public function show(Task $task): View
    {
        $task->load('project', 'assignee', 'comments.author', 'tags');

        return view('tasks.show', ['task' => $task]);
    }

    public function edit(Task $task): View
    {
        return view('tasks.edit', ['task' => $task]);
    }

    public function update(UpdateTaskRequest $request, Task $task): RedirectResponse
    {
        $task->update($request->validated());

        return redirect()->route('tasks.show', $task)->with('status', 'Task updated.');
    }

    public function destroy(Task $task): RedirectResponse
    {
        $this->authorize('delete', $task);

        $task->delete();

        return redirect()->route('tasks.index')->with('status', 'Task deleted.');
    }

    public function complete(Task $task): RedirectResponse
    {
        $this->completeTask->handle($task, request()->user());

        return back()->with('status', 'Task completed.');
    }

    public function assign(Task $task): RedirectResponse
    {
        $this->tasks->assign($task, (int) request('assignee_id'));

        return back()->with('status', 'Task reassigned.');
    }
}
