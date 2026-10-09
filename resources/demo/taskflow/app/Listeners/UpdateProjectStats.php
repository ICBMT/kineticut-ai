<?php

namespace App\Listeners;

use App\Events\TaskCreated;
use App\Events\TaskCompleted;
use App\Services\ReportService;

class UpdateProjectStats
{
    public function __construct(private readonly ReportService $reports) {}

    public function handle(TaskCreated|TaskCompleted $event): void
    {
        $this->reports->invalidate($event->task->project_id);
    }
}
