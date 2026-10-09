<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class TaskResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'status' => $this->status->value,
            'priority' => $this->priority->value,
            'is_overdue' => $this->isOverdue(),
            'due_at' => $this->due_at?->toIso8601String(),
            'project' => ProjectResource::make($this->whenLoaded('project')),
            'assignee' => $this->whenLoaded('assignee', fn () => [
                'id' => $this->assignee->id,
                'name' => $this->assignee->name,
            ]),
            'tags' => $this->whenLoaded('tags', fn () => $this->tags->pluck('name')),
            'comments_count' => $this->comments_count ?? null,
            'links' => [
                'self' => route('api.tasks.show', $this->id),
                'activity' => route('api.tasks.activity', $this->id),
            ],
        ];
    }
}
