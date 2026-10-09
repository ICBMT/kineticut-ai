<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\MorphTo;

class Attachment extends Model
{
    protected $fillable = ['path', 'disk', 'size', 'mime_type', 'attachable_id', 'attachable_type'];

    public function attachable(): MorphTo
    {
        return $this->morphTo();
    }

    public function humanSize(): string
    {
        return number_format($this->size / 1024, 1).' KB';
    }
}
