<?php

declare(strict_types=1);

namespace App\Providers;

use App\Services\Ai\AiProvider;
use App\Services\Ai\OllamaClient;
use App\Services\Scan\Languages\ProfileRegistry;
use App\Services\Scan\ScanPipelineFactory;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Pipelines are assembled per language by the factory: the stage list
        // lives in one place, and a scan never has to know which language it is
        // about to read — the profile decides.
        $this->app->singleton(ScanPipelineFactory::class, function ($app) {
            return new ScanPipelineFactory($app->make(ProfileRegistry::class));
        });

        // The local model runtime, behind an interface: everything that asks a
        // question goes through App\Services\Ai\AiProvider, so tests answer
        // with a fake and a different runtime (LM Studio, llama.cpp) is one
        // binding away.
        $this->app->singleton(AiProvider::class, function () {
            return new OllamaClient(
                (string) config('atlas.ai.base_url'),
                (int) config('atlas.ai.timeout', 180),
                (float) config('atlas.ai.temperature', 0.2),
            );
        });
    }

    public function boot(): void
    {
        // Scans can run for minutes; losing the worker to a memory limit is the
        // usual cause of a "stuck" atlas, so give them room.
        if ($this->app->runningInConsole()) {
            @ini_set('memory_limit', '1024M');
            @set_time_limit(0);
        }

        // Behind the sandbox proxy the app is served from a different host than
        // APP_URL, so trust the forwarded headers the proxy sends.
        if (! $this->app->runningInConsole()) {
            URL::forceScheme(str_starts_with((string) config('app.url'), 'https') ? 'https' : 'http');
        }
    }
}
