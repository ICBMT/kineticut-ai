<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Project;
use App\Services\ProjectManager;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * Scan a Laravel project straight from the terminal.
 *
 *      php artisan atlas:scan /var/www/my-app
 *      php artisan atlas:scan . --name="My App" --fresh
 */
class ScanProjectCommand extends Command
{
    protected $signature = 'atlas:scan
        {path : Path to the Laravel project you want to map}
        {--name= : Friendly name shown in the UI}
        {--fresh : Delete a previous scan of the same path before scanning}
        {--verbose-stages : Print every pipeline stage as it runs}
        {--demo : Materialise and scan the bundled sample application instead}';

    protected $description = 'Analyse a Laravel project and build its 3D architecture graph';

    public function handle(ProjectManager $manager): int
    {
        config(['atlas.verbose_scans' => (bool) $this->option('verbose-stages'), 'atlas.sync_scans' => true]);

        if ($this->option('demo')) {
            $this->components->info('Materialising the bundled sample application…');
            $project = $manager->createDemo('TaskFlow');
            $this->reportResult($project);

            return self::SUCCESS;
        }

        $path = (string) $this->argument('path');
        $path = $path === '.' ? getcwd() : $path;

        if (! is_dir($path)) {
            $this->components->error("Directory not found: {$path}");

            return self::FAILURE;
        }

        $real = realpath($path) ?: $path;
        $name = (string) ($this->option('name') ?: Str::headline(basename($real)));
        $this->components->info("Scanning {$name} at {$real}");

        $existing = Project::where('root_path', $real)->first();

        if ($existing !== null) {
            if ($this->option('fresh') || $this->confirm('A project with this path is already registered. Rescan it?', true)) {
                $scan = $manager->startScan($existing);
                $this->reportResult($existing->refresh(), $scan->id);
            }

            return self::SUCCESS;
        }

        $project = $manager->adopt($real, $name, 'path', $real);
        $this->reportResult($project->refresh());

        return self::SUCCESS;
    }

    private function reportResult(Project $project, ?int $scanId = null): void
    {
        $scan = $scanId !== null ? $project->scans()->find($scanId) : $project->scans()->latest('id')->first();

        if ($scan === null) {
            $this->components->error('No scan was created.');

            return;
        }

        $scan->refresh();

        $this->newLine();
        $this->table(['Metric', 'Value'], [
            ['Project', $project->displayName()],
            ['Status', $scan->status->label()],
            [$project->language === 'php' ? 'Laravel' : $project->language()->label(), $project->framework_version ?? 'unknown'],
            ['Files', number_format($scan->file_count)],
            ['Nodes', number_format($scan->node_count)],
            ['Relationships', number_format($scan->edge_count)],
            ['Duration', number_format($scan->duration_ms).' ms'],
        ]);

        if ($scan->error !== null) {
            $this->components->error($scan->error);

            return;
        }

        $metrics = $scan->metrics ?? [];
        $insights = $metrics['insights']['total'] ?? null;

        if ($insights !== null) {
            $this->components->info("{$insights} architectural insights found.");
        }

        $this->components->info('Open the atlas: '.url('/projects/'.$project->uuid));

        // In verbose CLI mode we also drop a JSON export next to the project.
        if ($this->option('verbose-stages')) {
            $path = storage_path('app/atlas/'.$project->uuid.'/graph.json');
            File::ensureDirectoryExists(dirname($path));
            file_put_contents($path, json_encode([
                'project' => $project->only(['uuid', 'name', 'framework_version']),
                'metrics' => $metrics,
            ], JSON_PRETTY_PRINT));

            $this->components->info('Summary written to '.$path);
        }
    }
}
