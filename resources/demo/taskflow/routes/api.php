<?php

use App\Http\Controllers\Api\StatsController;
use App\Http\Controllers\Api\TaskApiController;
use Illuminate\Support\Facades\Route;

Route::middleware('auth:sanctum')->group(function () {
    Route::apiResource('tasks', TaskApiController::class);
    Route::get('tasks/{task}/activity', [TaskApiController::class, 'activity'])->name('api.tasks.activity');
    Route::get('stats/overview', [StatsController::class, 'overview'])->name('api.stats.overview');
    Route::get('stats/throughput', StatsController::class)->name('api.stats.throughput');
});
