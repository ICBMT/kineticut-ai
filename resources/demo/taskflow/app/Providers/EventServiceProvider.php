<?php

namespace App\Providers;

use App\Events\TaskCompleted;
use App\Events\TaskCreated;
use App\Listeners\NotifyTeamOfNewTask;
use App\Listeners\UpdateProjectStats;
use Illuminate\Foundation\Support\Providers\EventServiceProvider as ServiceProvider;

class EventServiceProvider extends ServiceProvider
{
    protected $listen = [
        TaskCreated::class => [
            NotifyTeamOfNewTask::class,
            UpdateProjectStats::class,
        ],
        TaskCompleted::class => [
            UpdateProjectStats::class,
        ],
    ];
}
