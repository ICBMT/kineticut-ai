<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Invitation extends Model
{
    protected $fillable = ['email', 'token', 'team_id', 'expires_at'];

    protected $casts = ['expires_at' => 'datetime'];

    public function team(): BelongsTo
    {
        return $this->belongsTo(Team::class);
    }
}
