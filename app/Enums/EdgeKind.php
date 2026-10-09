<?php

declare(strict_types=1);

namespace App\Enums;

/**
 * Relationship semantics between two nodes. The 3D renderer styles each kind
 * differently (colour, curvature, particle flow) so a glance tells you whether
 * you are looking at an HTTP hop, a model relation or a view include.
 */
enum EdgeKind: string
{
    case Http = 'http';                 // route -> controller action
    case Guards = 'guards';             // middleware -> route/controller
    case Validates = 'validates';       // form request -> controller
    case Authorizes = 'authorizes';     // policy -> controller/model
    case Injects = 'injects';           // DI constructor injection
    case Invokes = 'invokes';           // new X / method call
    case Uses = 'uses';                 // static call / facade / reference
    case Extends = 'extends';
    case Implements = 'implements';
    case Includes = 'includes';         // blade @include / component
    case Renders = 'renders';           // controller -> view
    case RelatesTo = 'relates_to';      // eloquent relationship
    case Owns = 'owns';                 // hasMany / hasOne family
    case BelongsTo = 'belongs_to';
    case Pivot = 'pivot';               // belongsToMany
    case Persists = 'persists';         // model -> table
    case Migrates = 'migrates';         // migration -> table
    case Dispatches = 'dispatches';     // job/event dispatch
    case Listens = 'listens';           // listener -> event
    case Notifies = 'notifies';
    case Schedules = 'schedules';
    case Tests = 'tests';               // test -> subject
    case Provides = 'provides';         // provider -> binding target
    case Configures = 'configures';
    case Imports = 'imports';           // php use-statement on an internal class
    case Groups = 'groups';             // directory grouping
    case Queue = 'queue';

    // ---- Kinds that come from C-family codebases ---------------------------
    case Calls = 'calls';               // function/method call site
    case DependsOn = 'depends_on';      // cmake target / csproj project reference

    public function label(): string
    {
        return match ($this) {
            self::Http => 'handled by',
            self::Guards => 'guarded by',
            self::Validates => 'validated by',
            self::Authorizes => 'authorized by',
            self::Injects => 'injects',
            self::Invokes => 'invokes',
            self::Uses => 'uses',
            self::Extends => 'extends',
            self::Implements => 'implements',
            self::Includes => 'includes',
            self::Renders => 'renders',
            self::RelatesTo => 'relates to',
            self::Owns => 'has many',
            self::BelongsTo => 'belongs to',
            self::Pivot => 'many-to-many',
            self::Persists => 'persists to',
            self::Migrates => 'migrates',
            self::Dispatches => 'dispatches',
            self::Listens => 'listens for',
            self::Notifies => 'notifies',
            self::Schedules => 'schedules',
            self::Tests => 'tests',
            self::Provides => 'provides',
            self::Configures => 'configures',
            self::Imports => 'imports',
            self::Groups => 'contains',
            self::Queue => 'queues',
            self::Calls => 'calls',
            self::DependsOn => 'depends on',
        };
    }

    public function color(): string
    {
        return match ($this) {
            self::Http, self::Renders => '#38bdf8',
            self::Guards, self::Validates, self::Authorizes => '#f472b6',
            self::Injects, self::Invokes, self::Uses, self::Imports => '#a78bfa',
            self::Extends, self::Implements => '#c084fc',
            self::Includes => '#fb7185',
            self::RelatesTo, self::Owns, self::BelongsTo, self::Pivot => '#fbbf24',
            self::Persists, self::Migrates => '#34d399',
            self::Dispatches, self::Queue, self::Schedules => '#22d3ee',
            self::Listens, self::Notifies => '#2dd4bf',
            self::Tests => '#4ade80',
            self::Provides, self::Configures => '#94a3b8',
            self::Groups => '#334155',
            self::Calls => '#67e8f9',
            self::DependsOn => '#94a3b8',
        };
    }

    /** Relative visual weight of the connection. */
    public function weight(): float
    {
        return match ($this) {
            self::Http => 3.0,
            self::RelatesTo, self::Owns, self::BelongsTo, self::Pivot => 2.2,
            self::Injects, self::Renders, self::Dispatches, self::Listens => 1.8,
            self::Persists, self::Migrates, self::Guards, self::Validates, self::Authorizes => 1.4,
            self::Groups => 0.4,
            self::Calls => 1.6,
            self::DependsOn => 0.8,
            default => 1.0,
        };
    }

    /** The edges that make up a "request journey" — used by the trace engine. */
    public function isFlow(): bool
    {
        return in_array($this, [
            self::Http, self::Guards, self::Validates, self::Authorizes, self::Injects,
            self::Invokes, self::Renders, self::Persists, self::RelatesTo, self::Owns,
            self::BelongsTo, self::Pivot, self::Dispatches, self::Listens, self::Includes,
            self::Queue, self::Notifies, self::Schedules,
            // A C++ or C# journey walks call sites from an entry point down to
            // whatever persists the data.
            self::Calls,
        ], true);
    }

    public static function values(): array
    {
        return array_map(fn (self $k) => $k->value, self::cases());
    }
}
