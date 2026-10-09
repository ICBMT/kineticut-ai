<?php

namespace App\Console\Commands;

use App\Jobs\GenerateProjectReport;
use App\Models\Project;
use Illuminate\Console\Command;

class PruneArchivedProjects extends Command
{
    protected $signature = 'projects:prune {--dry-run : Only report what would be pruned}';

    protected $description = 'Archive stale projects and generate a final report for each';

    public function handle(): int
    {
        $projects = Project::query()
            ->whereNull('archived_at')
            ->where('updated_at', '<', now()->subMonths(6))
            ->get();

        foreach ($projects as $project) {
            if ($this->option('dry-run')) {
                $this->line('Would prune: '.$project->name);

                continue;
            }

            GenerateProjectReport::dispatch($project->id);
            $project->update(['archived_at' => now()]);
        }

        $this->info($projects->count().' project(s) processed.');

        return self::SUCCESS;
    }
}
