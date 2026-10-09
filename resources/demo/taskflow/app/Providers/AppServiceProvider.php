<?php

namespace App\Providers;

use App\Models\Task;
use App\Observers\TaskObserver;
use App\Services\ReportService;
use App\Services\TaskService;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Cache\RateLimiting\Limit;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(ReportService::class);
        $this->app->bind(TaskService::class, fn ($app) => new TaskService($app->make(ReportService::class)));
    }

    public function boot(): void
    {
        Task::observe(TaskObserver::class);

        Gate::define('manage-billing', fn ($user) => $user->isAdmin());

        RateLimiter::for('api', fn ($request) => Limit::perMinute(60)->by($request->user()?->id));
    }
}
