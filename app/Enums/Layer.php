<?php

declare(strict_types=1);

namespace App\Enums;

/**
 * The architectural strata of a Laravel application.
 *
 * Every layer is rendered as a horizontal "deck" floating in 3D space, ordered
 * from the outside world (Entry) down to persistence (Data). Reading the
 * observatory top-to-bottom is literally reading a request's journey.
 */
enum Layer: string
{
    case Entry = 'entry';
    case Http = 'http';
    case Application = 'application';
    case Domain = 'domain';
    case Data = 'data';
    case View = 'view';
    case Infrastructure = 'infrastructure';
    case Test = 'test';
    case Structure = 'structure';
    case External = 'external';

    public function label(): string
    {
        return match ($this) {
            self::Entry => 'Entrypoints',
            self::Http => 'HTTP / Transport',
            self::Application => 'Application Core',
            self::Domain => 'Domain',
            self::Data => 'Persistence',
            self::View => 'Presentation',
            self::Infrastructure => 'Infrastructure',
            self::Test => 'Quality',
            self::Structure => 'Project Structure',
            self::External => 'External',
        };
    }

    public function description(): string
    {
        return match ($this) {
            self::Entry => 'Where requests, commands and schedulers enter the system.',
            self::Http => 'Controllers, middleware, form requests, policies and API resources.',
            self::Application => 'Use-cases: services, actions, jobs, events, listeners and notifications.',
            self::Domain => 'Eloquent models, enums, contracts and other business concepts.',
            self::Data => 'Migrations, schema tables, factories and seeders.',
            self::View => 'Blade templates, anonymous components and Livewire views.',
            self::Infrastructure => 'Service providers, config and framework wiring.',
            self::Test => 'Feature, unit and browser tests.',
            self::Structure => 'Directory scaffolding — handy for orientation, hidden in runtime views.',
            self::External => 'Third-party composer packages that the application actually uses.',
        };
    }

    public function color(): string
    {
        return match ($this) {
            self::Entry => '#7dd3fc',
            self::Http => '#38bdf8',
            self::Application => '#a78bfa',
            self::Domain => '#fbbf24',
            self::Data => '#34d399',
            self::View => '#fb7185',
            self::Infrastructure => '#94a3b8',
            self::Test => '#4ade80',
            self::Structure => '#475569',
            self::External => '#a78bfa',
        };
    }

    /** Vertical order of the tiers, top (0) to bottom. */
    public function tier(): int
    {
        return match ($this) {
            self::Entry => 0,
            self::Http => 1,
            self::Application => 2,
            self::Domain => 3,
            self::Data => 4,
            self::View => 2,
            self::Infrastructure => 5,
            self::Test => 6,
            self::Structure => 7,
            self::External => 8,
        };
    }

    public function tierSlot(): int
    {
        return match ($this) {
            self::Entry => 0,
            self::Http => 1,
            self::Application => 2,
            self::View => 3,
            self::Domain => 4,
            self::Data => 5,
            self::Infrastructure => 6,
            self::Test => 7,
            self::Structure => 8,
            self::External => 9,
        };
    }

    public static function values(): array
    {
        return array_map(fn (self $l) => $l->value, self::cases());
    }
}
