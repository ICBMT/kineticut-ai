<?php

namespace App\Services;

use App\Models\Project;
use App\Models\User;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Str;

class ProjectService
{
    public function forUser(User $user): Collection
    {
        return Project::query()
            ->active()
            ->withCount('tasks')
            ->where('owner_id', $user->id)
            ->orWhereHas('members', fn ($query) => $query->whereKey($user->id))
            ->get();
    }

    public function create(User $user, array $attributes): Project
    {
        $project = Project::create([
            'name' => $attributes['name'],
            'slug' => Str::slug($attributes['name']).'-'.Str::lower(Str::random(4)),
            'description' => $attributes['description'] ?? null,
            'owner_id' => $user->id,
        ]);

        $project->members()->sync(array_unique(array_merge([$user->id], $attributes['members'] ?? [])));

        return $project;
    }

    public function archive(Project $project): void
    {
        $project->update(['archived_at' => now()]);
        $project->tasks()->update(['status' => 'blocked']);
    }
}
