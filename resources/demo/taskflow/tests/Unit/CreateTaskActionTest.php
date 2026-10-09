<?php

namespace Tests\Unit;

use App\Actions\CreateTaskAction;
use App\Data\TaskData;
use App\Enums\TaskPriority;
use App\Enums\TaskStatus;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CreateTaskActionTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_creates_a_task_and_assigns_it(): void
    {
        $user = User::factory()->create();
        $project = Project::factory()->create();
        $assignee = User::factory()->create();

        $action = app(CreateTaskAction::class);

        $task = $action->handle($user, new TaskData(
            title: 'Draft the roadmap',
            description: null,
            projectId: $project->id,
            assigneeId: $assignee->id,
            priority: TaskPriority::High,
            status: TaskStatus::Todo,
            dueAt: null,
            estimateMinutes: 120,
        ));

        $this->assertSame('Draft the roadmap', $task->title);
        $this->assertSame(TaskStatus::InProgress, $task->status);
    }
}
