<?php

namespace Database\Factories;

use App\Enums\TaskPriority;
use App\Enums\TaskStatus;
use App\Models\Project;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

class TaskFactory extends Factory
{
    public function definition(): array
    {
        return [
            'title' => fake()->sentence(4),
            'description' => fake()->paragraph(),
            'status' => fake()->randomElement(TaskStatus::cases())->value,
            'priority' => fake()->randomElement(TaskPriority::cases())->value,
            'due_at' => fake()->dateTimeBetween('now', '+1 month'),
            'project_id' => Project::factory(),
            'assignee_id' => User::factory(),
            'creator_id' => User::factory(),
            'estimate_minutes' => fake()->numberBetween(15, 480),
        ];
    }

    public function completed(): static
    {
        return $this->state(fn () => ['completed_at' => now(), 'status' => TaskStatus::Done->value]);
    }

    public function overdue(): static
    {
        return $this->state(fn () => ['due_at' => now()->subWeek(), 'completed_at' => null]);
    }
}
