<?php

namespace App\Policies;

use App\Models\Project;
use App\Models\User;

class ProjectPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->exists;
    }

    public function view(User $user, Project $project): bool
    {
        return $user->id === $project->owner_id || $project->members()->whereKey($user->id)->exists();
    }

    public function create(User $user): bool
    {
        return $user->exists;
    }

    public function delete(User $user, Project $project): bool
    {
        return $user->id === $project->owner_id || $user->isAdmin();
    }
}
