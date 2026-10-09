<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class ProjectResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'slug' => $this->slug,
            'archived' => $this->archived_at !== null,
            'owner' => $this->whenLoaded('owner', fn () => $this->owner->name),
            'tasks_count' => $this->tasks_count ?? null,
        ];
    }
}
