<div class="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div class="flex gap-3 border-b border-slate-100 p-4">
        <select wire:model.live="status" class="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">All statuses</option>
            @foreach (\App\Enums\TaskStatus::cases() as $status)
                <option value="{{ $status->value }}">{{ $status->label() }}</option>
            @endforeach
        </select>

        <select wire:model.live="priority" class="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">Any priority</option>
            @foreach (\App\Enums\TaskPriority::cases() as $priority)
                <option value="{{ $priority->value }}">{{ ucfirst($priority->value) }}</option>
            @endforeach
        </select>
    </div>

    <table class="w-full text-sm">
        <tbody>
            @foreach ($tasks as $task)
                <tr class="border-t border-slate-100">
                    <td class="px-4 py-3 font-medium">{{ $task->title }}</td>
                    <td class="px-4 py-3 text-slate-500">{{ $task->project->name }}</td>
                    <td class="px-4 py-3">
                        <button wire:click="complete({{ $task->id }})" class="text-xs text-sky-700">Complete</button>
                    </td>
                </tr>
            @endforeach
        </tbody>
    </table>
</div>
