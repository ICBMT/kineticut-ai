<h1>Overdue task</h1>

<p>{{ $task->title }} was due {{ $task->due_at?->toFormattedDateString() }}.</p>

<p><a href="{{ route('tasks.show', $task) }}">Open it in TaskFlow</a></p>
