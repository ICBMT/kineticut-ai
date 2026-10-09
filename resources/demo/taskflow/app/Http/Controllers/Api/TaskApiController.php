<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreTaskRequest;
use App\Http\Requests\UpdateTaskRequest;
use App\Http\Resources\TaskResource;
use App\Models\Task;
use App\Services\TaskService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

class TaskApiController extends Controller
{
    public function __construct(private readonly TaskService $tasks)
    {
        $this->middleware('auth:sanctum');
    }

    public function index(Request $request): AnonymousResourceCollection
    {
        return TaskResource::collection(
            $this->tasks->listFor($request->user(), $request->only('status', 'priority'))
        );
    }

    public function store(StoreTaskRequest $request): JsonResponse
    {
        $task = $this->tasks->create($request->user(), $request->validated());

        return TaskResource::make($task)->response()->setStatusCode(201);
    }

    public function show(Task $task): TaskResource
    {
        $this->authorize('view', $task);

        return TaskResource::make($task->load('project', 'assignee', 'tags'));
    }

    public function update(UpdateTaskRequest $request, Task $task): TaskResource
    {
        $task->update($request->validated());

        return TaskResource::make($task);
    }

    public function destroy(Task $task): JsonResponse
    {
        $this->authorize('delete', $task);

        $task->delete();

        return response()->json(status: 204);
    }

    public function activity(Task $task): JsonResponse
    {
        return response()->json([
            'data' => $task->comments()->with('author')->latest()->take(20)->get(),
        ]);
    }
}
