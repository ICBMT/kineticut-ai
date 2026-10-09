<?php

use App\Console\Commands\SendDueTaskReminders;
use Illuminate\Support\Facades\Schedule;

Schedule::command(SendDueTaskReminders::class)->hourly()->withoutOverlapping();
Schedule::command('model:prune')->daily();
Schedule::call(function () {
    cache()->forget('taskflow.overview');
})->everyFiveMinutes()->name('flush-overview-cache');
