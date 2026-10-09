<?php

declare(strict_types=1);

namespace App\Enums;

enum ScanStatus: string
{
    case Queued = 'queued';
    case Running = 'running';
    case Completed = 'completed';
    case Failed = 'failed';

    public function label(): string
    {
        return match ($this) {
            self::Queued => 'Queued',
            self::Running => 'Scanning',
            self::Completed => 'Ready',
            self::Failed => 'Failed',
        };
    }

    public function color(): string
    {
        return match ($this) {
            self::Queued => '#94a3b8',
            self::Running => '#38bdf8',
            self::Completed => '#34d399',
            self::Failed => '#f87171',
        };
    }

    public function isFinished(): bool
    {
        return in_array($this, [self::Completed, self::Failed], true);
    }
}
