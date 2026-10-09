<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Team extends Model
{
    protected $fillable = ['name', 'slug', 'plan'];

    public function members(): BelongsToMany
    {
        return $this->belongsToMany(User::class)->withPivot('role');
    }

    public function invitations(): HasMany
    {
        return $this->hasMany(Invitation::class);
    }

    public function isOnPaidPlan(): bool
    {
        return ! in_array($this->plan, ['free', 'trial'], true);
    }
}
