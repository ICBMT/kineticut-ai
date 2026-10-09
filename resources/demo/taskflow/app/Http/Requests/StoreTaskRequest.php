<?php

namespace App\Http\Requests;

use App\Enums\TaskPriority;
use App\Enums\TaskStatus;
use App\Rules\ValidPriority;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreTaskRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('create', \App\Models\Task::class);
    }

    public function rules(): array
    {
        return [
            'title' => ['required', 'string', 'max:180'],
            'description' => ['nullable', 'string', 'max:5000'],
            'project_id' => ['required', Rule::exists('projects', 'id')],
            'assignee_id' => ['nullable', Rule::exists('users', 'id')],
            'priority' => ['sometimes', new ValidPriority],
            'status' => ['sometimes', Rule::enum(TaskStatus::class)],
            'due_at' => ['nullable', 'date', 'after:today'],
            'estimate_minutes' => ['nullable', 'integer', 'min:5', 'max:2400'],
            'tags' => ['array'],
            'tags.*' => ['string', 'max:40'],
        ];
    }

    public function priority(): TaskPriority
    {
        return TaskPriority::from($this->input('priority', TaskPriority::Medium->value));
    }
}
