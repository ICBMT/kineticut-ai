<?php

namespace App\Models;

use App\Http\Resources\TaskResource;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * An export preset that stores which columns a user wants in their CSV.
 * It builds the export payload itself, so it knows about the API resource.
 */
class TaskExportTemplate extends Model
{
    protected $fillable = ['name', 'columns', 'user_id'];

    protected $casts = ['columns' => 'array'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function preview(Task $task): array
    {
        $resource = new TaskResource($task);

        return collect($resource->resolve())
            ->only($this->columns ?? [])
            ->all();
    }
}
