<?php

declare(strict_types=1);

namespace App\Models;

use App\Enums\Language;
use App\Enums\ScanStatus;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Str;

class Project extends Model
{
    use HasFactory;

    protected $fillable = [
        'uuid', 'name', 'language', 'source_type', 'source_ref', 'root_path', 'archive_size',
        'file_count', 'loc', 'framework_version', 'php_constraint', 'composer_name',
        'composer_description', 'package_count', 'meta', 'last_scanned_at',
    ];

    protected function casts(): array
    {
        return [
            'meta' => 'array',
            'last_scanned_at' => 'datetime',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (self $project) {
            $project->uuid ??= (string) Str::uuid();
        });
    }

    /** The language this project is written in; PHP unless a scan said otherwise. */
    public function language(): Language
    {
        return Language::tryFrom((string) $this->language) ?? Language::Php;
    }

    public function scans(): HasMany
    {
        return $this->hasMany(Scan::class)->latest('id');
    }

    public function latestScan(): HasOne
    {
        return $this->hasOne(Scan::class)->latestOfMany();
    }

    public function latestCompletedScan(): HasOne
    {
        return $this->hasOne(Scan::class)->ofMany([
            'id' => 'max',
        ], fn ($query) => $query->where('status', ScanStatus::Completed->value));
    }

    public function getRouteKeyName(): string
    {
        return 'uuid';
    }

    /** Absolute path to where the sources live on disk. */
    public function sourcePath(string $append = ''): string
    {
        return rtrim($this->root_path, '/').($append !== '' ? '/'.ltrim($append, '/') : '');
    }

    /** Private working directory used for stage artefacts. */
    public function workspacePath(string $append = ''): string
    {
        $base = storage_path('app/atlas/'.$this->uuid);

        return $append !== '' ? $base.'/'.ltrim($append, '/') : $base;
    }

    public function displayName(): string
    {
        return $this->name !== '' ? $this->name : 'Untitled project';
    }

    /**
     * What this project is built with, in one line.
     *
     * "Laravel 13.0", "Python · Django 5.0.6", "C# · net8.0", "C++ · CMake" —
     * and for a plain Python script, which has no framework and so states its
     * interpreter instead, just "Python 3.11". The framework string already
     * names the language in that case, which is why it is not prefixed again:
     * "Python · Python" is how a beginner's first project would otherwise read.
     */
    public function stackLine(): string
    {
        $language = $this->language();
        $framework = $this->framework_version;

        if ($language === Language::Php) {
            return $framework !== null ? 'Laravel '.$framework : 'Laravel project';
        }

        if ($framework === null) {
            return $language->label();
        }

        return str_starts_with($framework, $language->label())
            ? $framework
            : $language->label().' · '.$framework;
    }

    public function sizeForHumans(): string
    {
        $bytes = max($this->archive_size, 1);
        $units = ['B', 'KB', 'MB', 'GB'];
        $power = (int) min(floor(log($bytes, 1024)), 3);

        return round($bytes / (1024 ** $power), $power > 1 ? 1 : 0).' '.$units[$power];
    }
}
