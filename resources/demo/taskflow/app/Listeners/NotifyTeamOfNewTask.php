<?php

namespace App\Listeners;

use App\Events\TaskCreated;
use App\Notifications\TeamActivityNotification;
use Illuminate\Contracts\Queue\ShouldQueue;

class NotifyTeamOfNewTask implements ShouldQueue
{
    public function handle(TaskCreated $event): void
    {
        $team = $event->task->project->owner->teams()->first();

        $team?->members->each(
            fn ($member) => $member->id !== $event->author->id
                ? $member->notify(new TeamActivityNotification($event->task))
                : null
        );
    }
}
