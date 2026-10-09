<?php

namespace App\Console\Commands;

use App\Jobs\SendTaskReminder;
use App\Models\Task;
use Illuminate\Console\Command;

class SendDueTaskReminders extends Command
{
    protected $signature = 'tasks:send-reminders {--days=2 : How far ahead to look}';

    protected $description = 'Queue reminder emails for tasks that are due soon or overdue';

    public function handle(): int
    {
        $tasks = Task::query()
            ->overdue()
            ->orWhereBetween('due_at', [now(), now()->addDays((int) $this->option('days'))])
            ->with('assignee')
            ->cursor();

        $queued = 0;

        foreach ($tasks as $task) {
            if ($task->assignee === null) {
                continue;
            }

            SendTaskReminder::dispatch($task);
            $queued++;
        }

        $this->info("Queued {$queued} reminders.");

        return self::SUCCESS;
    }
}
