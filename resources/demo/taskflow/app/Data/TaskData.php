<?php

namespace App\Data;

use App\Enums\TaskPriority;
use App\Enums\TaskStatus;
use App\Http\Requests\StoreTaskRequest;

final readonly class TaskData
{
    public function __construct(
        public string $title,
        public ?string $description,
        public int $projectId,
        public ?int $assigneeId,
        public TaskPriority $priority,
        public TaskStatus $status,
        public ?string $dueAt,
        public ?int $estimateMinutes,
        public array $tags = [],
    ) {}

    public static function fromRequest(StoreTaskRequest $request): self
    {
        return new self(
            title: $request->string('title')->value(),
            description: $request->input('description'),
            projectId: (int) $request->input('project_id'),
            assigneeId: $request->input('assignee_id') !== null ? (int) $request->input('assignee_id') : null,
            priority: $request->priority(),
            status: TaskStatus::Todo,
            dueAt: $request->input('due_at'),
            estimateMinutes: $request->input('estimate_minutes') !== null ? (int) $request->input('estimate_minutes') : null,
            tags: $request->input('tags', []),
        );
    }

    public function toArray(): array
    {
        return [
            'title' => $this->title,
            'description' => $this->description,
            'project_id' => $this->projectId,
            'assignee_id' => $this->assigneeId,
            'priority' => $this->priority->value,
            'status' => $this->status->value,
            'due_at' => $this->dueAt,
            'estimate_minutes' => $this->estimateMinutes,
        ];
    }
}
