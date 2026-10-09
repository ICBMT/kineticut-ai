<?php

namespace Tests\Feature;

use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TaskControllerTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_user_sees_their_tasks(): void
    {
        $user = User::factory()->create();
        Task::factory()->count(3)->create(['assignee_id' => $user->id, 'creator_id' => $user->id]);

        $response = $this->actingAs($user)->get('/tasks');

        $response->assertOk();
        $response->assertSee('Tasks');
    }

    public function test_a_task_can_be_created(): void
    {
        $user = User::factory()->create();
        $project = Project::factory()->create(['owner_id' => $user->id]);

        $response = $this->actingAs($user)->post('/tasks', [
            'title' => 'Write the release notes',
            'project_id' => $project->id,
            'priority' => 'high',
        ]);

        $response->assertRedirect();
        $this->assertDatabaseHas('tasks', ['title' => 'Write the release notes']);
    }

    public function test_an_overdue_task_can_be_completed(): void
    {
        $user = User::factory()->create();
        $task = Task::factory()->overdue()->create(['assignee_id' => $user->id, 'creator_id' => $user->id]);

        $this->actingAs($user)->post("/tasks/{$task->id}/complete")->assertRedirect();

        $this->assertNotNull($task->refresh()->completed_at);
    }
}
