<?php

namespace Tests\Feature;

use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ProjectControllerTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_project_index_lists_projects(): void
    {
        $user = User::factory()->create();
        Project::factory()->count(2)->create(['owner_id' => $user->id]);

        $this->actingAs($user)->get('/projects')->assertOk()->assertSee('Projects');
    }
}
