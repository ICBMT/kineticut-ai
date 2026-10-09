<?php

declare(strict_types=1);

namespace App\Models;

use App\Enums\EdgeKind;
use App\Enums\Layer;
use App\Enums\NodeType;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class GraphNode extends Model
{
    protected $fillable = [
        'scan_id', 'node_key', 'type', 'layer', 'label', 'fqcn', 'file_path', 'line',
        'module', 'parent_key', 'weight', 'fan_in', 'fan_out', 'loc',
        'pos_x', 'pos_y', 'pos_z', 'meta',
    ];

    protected function casts(): array
    {
        return [
            'meta' => 'array',
            'type' => NodeType::class,
            'layer' => Layer::class,
        ];
    }

    public function scan(): BelongsTo
    {
        return $this->belongsTo(Scan::class);
    }

    public function edgeKind(): EdgeKind
    {
        return EdgeKind::tryFrom($this->type->value) ?? EdgeKind::Uses;
    }
}
