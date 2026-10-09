<?php

namespace App\Jobs;

use App\Mail\TaskOverdueMail;
use App\Models\Task;
use App\Notifications\TaskAssignedNotification;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Mail;

class SendTaskReminder implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;

    public int $backoff = 60;

    public function __construct(public readonly Task $task) {}

    public function handle(): void
    {
        if (! $this->task->isOverdue()) {
            return;
        }

        if ($this->task->assignee === null) {
            return;
        }

        Mail::to($this->task->assignee->email)->send(new TaskOverdueMail($this->task));
        $this->task->assignee->notify(new TaskAssignedNotification($this->task));
    }

    public function tags(): array
    {
        return ['reminders', 'task:'.$this->task->id];
    }
}
