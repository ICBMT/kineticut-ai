<?php

namespace App\Jobs;

use App\Models\Task;
use GuzzleHttp\Client;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class SyncExternalCalendar implements ShouldQueue
{
    use Queueable;

    public function __construct(public readonly Task $task) {}

    public function handle(Client $client): void
    {
        if ($this->task->due_at === null) {
            return;
        }

        $client->post(config('taskflow.integrations.calendar_url'), [
            'json' => [
                'title' => $this->task->title,
                'due' => $this->task->due_at->toIso8601String(),
            ],
        ]);
    }
}
