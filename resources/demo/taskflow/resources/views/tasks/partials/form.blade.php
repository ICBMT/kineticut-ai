@props(['task' => null, 'projects' => collect()])

<div class="space-y-4">
    <div>
        <label class="text-sm font-medium" for="title">Title</label>
        <input id="title" name="title" value="{{ old('title', $task?->title) }}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required>
        @error('title') <p class="mt-1 text-xs text-rose-600">{{ $message }}</p> @enderror
    </div>

    <div>
        <label class="text-sm font-medium" for="project_id">Project</label>
        <select id="project_id" name="project_id" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            @foreach ($projects as $project)
                <option value="{{ $project->id }}" @selected(old('project_id', $task?->project_id) == $project->id)>{{ $project->name }}</option>
            @endforeach
        </select>
    </div>

    <div>
        <label class="text-sm font-medium" for="priority">Priority</label>
        <select id="priority" name="priority" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            @foreach (\App\Enums\TaskPriority::cases() as $priority)
                <option value="{{ $priority->value }}" @selected(old('priority', $task?->priority?->value) === $priority->value)>{{ ucfirst($priority->value) }}</option>
            @endforeach
        </select>
    </div>
</div>
