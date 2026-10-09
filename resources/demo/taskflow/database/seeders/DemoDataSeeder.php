<?php

namespace Database\Seeders;

use App\Enums\TaskStatus;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Illuminate\Database\Seeder;

class DemoDataSeeder extends Seeder
{
    public function run(): void
    {
        $owner = User::factory()->create(['name' => 'Ada Lovelace', 'email' => 'ada@taskflow.test']);

        Project::factory()
            ->count(3)
            ->for($owner, 'owner')
            ->create()
            ->each(function (Project $project) use ($owner) {
                Task::factory()
                    ->count(12)
                    ->for($project)
                    ->create(['creator_id' => $owner->id]);
            });

        Task::query()->inRandomOrder()->take(5)->update([
            'status' => TaskStatus::Done->value,
            'completed_at' => now(),
        ]);
    }
}
