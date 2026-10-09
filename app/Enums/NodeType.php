<?php

declare(strict_types=1);

namespace App\Enums;

/**
 * Every kind of artefact AtlasScope can discover inside a Laravel project.
 * Each type belongs to an architectural Layer and gets its own glyph + colour
 * in the 3D observatory.
 */
enum NodeType: string
{
    case Route = 'route';
    case Controller = 'controller';
    case Middleware = 'middleware';
    case Request = 'request';
    case Resource = 'resource';
    case Policy = 'policy';
    case Model = 'model';
    case Service = 'service';
    case Action = 'action';
    case Job = 'job';
    case Event = 'event';
    case Listener = 'listener';
    case Notification = 'notification';
    case Mailable = 'mailable';
    case Console = 'console';
    case Schedule = 'schedule';
    case Observer = 'observer';
    case Rule = 'rule';
    case Cast = 'cast';
    case Enum = 'enum';
    case Interface_ = 'interface';
    case Trait_ = 'trait';
    case Exception = 'exception';
    case Dto = 'dto';
    case Provider = 'provider';
    case Config = 'config';
    case Command = 'command';
    case View = 'view';
    case Component = 'component';
    case Livewire = 'livewire';
    case Table = 'table';
    case Migration = 'migration';
    case Factory = 'factory';
    case Seeder = 'seeder';
    case Test = 'test';
    case TestSuite = 'suite';
    case Package = 'package';
    case PhpClass = 'class';
    case Directory = 'directory';

    // ---- Types that come from C-family codebases (C++ / C#) ---------------
    case Struct = 'struct';
    case Record = 'record';
    case Function = 'function';
    case Namespace = 'namespace';
    case Executable = 'executable';
    case Library = 'library';

    /**
     * What this type is called, in the language of the project being read.
     *
     * The neutral label says what the thing *is*; a language that has a
     * household name for it says that instead. A Django model is not an
     * Eloquent model and a Django template is not a Blade view, so those two
     * read differently per language — the graph shape is identical either way,
     * which is why only the words change.
     */
    public function label(?Language $language = null): string
    {
        return $language !== null
            ? (self::LABELS[$language->value][$this->value] ?? $this->baseLabel())
            : $this->baseLabel();
    }

    /**
     * Per-language names for the handful of types whose framework name would be
     * wrong anywhere else.
     */
    private const LABELS = [
        // An EF Core or domain entity is a model, not an Eloquent one.
        'csharp' => [
            self::Model->value => 'Model',
        ],
        'python' => [
            self::Model->value => 'Model',
            self::View->value => 'Template',
            self::Command->value => 'Command',
            self::Request->value => 'Form',
            self::Resource->value => 'Serializer',
        ],
    ];

    private function baseLabel(): string
    {
        return match ($this) {
            self::Route => 'Route',
            self::Controller => 'Controller',
            self::Middleware => 'Middleware',
            self::Request => 'Form Request',
            self::Resource => 'API Resource',
            self::Policy => 'Policy',
            self::Model => 'Eloquent Model',
            self::Service => 'Service',
            self::Action => 'Action',
            self::Job => 'Queued Job',
            self::Event => 'Event',
            self::Listener => 'Listener',
            self::Notification => 'Notification',
            self::Mailable => 'Mailable',
            self::Console => 'Console Command',
            self::Schedule => 'Scheduled Task',
            self::Observer => 'Model Observer',
            self::Rule => 'Validation Rule',
            self::Cast => 'Custom Cast',
            self::Enum => 'Enum',
            self::Interface_ => 'Interface',
            self::Trait_ => 'Trait',
            self::Exception => 'Exception',
            self::Dto => 'Data Object',
            self::Provider => 'Service Provider',
            self::Config => 'Config File',
            self::Command => 'Artisan Command',
            self::View => 'Blade View',
            self::Component => 'Component',
            self::Livewire => 'Livewire Component',
            self::Table => 'Database Table',
            self::Migration => 'Migration',
            self::Factory => 'Factory',
            self::Seeder => 'Seeder',
            self::Test => 'Test',
            self::TestSuite => 'Test Suite',
            self::Package => 'Package',
            // One label for every language: a C++ class and a C# class are the
            // same shape in the graph, and the badge next to it says which
            // project you are looking at.
            self::PhpClass => 'Class',
            self::Directory => 'Directory',
            self::Struct => 'Struct',
            self::Record => 'Record',
            self::Function => 'Function',
            self::Namespace => 'Namespace',
            self::Executable => 'Executable',
            self::Library => 'Library',
        };
    }

    /** A short, monospace-ish token used inside the 3D sprite badges. */
    public function glyph(): string
    {
        return match ($this) {
            self::Route => 'RT',
            self::Controller => 'CT',
            self::Middleware => 'MW',
            self::Request => 'RQ',
            self::Resource => 'RS',
            self::Policy => 'PL',
            self::Model => 'MD',
            self::Service => 'SV',
            self::Action => 'AC',
            self::Job => 'JB',
            self::Event => 'EV',
            self::Listener => 'LS',
            self::Notification => 'NT',
            self::Mailable => 'ML',
            self::Console, self::Command => 'CL',
            self::Schedule => 'SC',
            self::Observer => 'OB',
            self::Rule => 'RU',
            self::Cast => 'CS',
            self::Enum => 'EN',
            self::Interface_ => 'IF',
            self::Trait_ => 'TR',
            self::Exception => 'EX',
            self::Dto => 'DT',
            self::Provider => 'PV',
            self::Config => 'CF',
            self::View => 'VW',
            self::Component => 'CP',
            self::Livewire => 'LW',
            self::Table => 'TB',
            self::Migration => 'MG',
            self::Factory => 'FC',
            self::Seeder => 'SD',
            self::Test => 'TS',
            self::TestSuite => 'SU',
            self::Package => 'PK',
            self::PhpClass => 'CL',
            self::Directory => 'DR',
            self::Struct => 'ST',
            self::Record => 'RC',
            self::Function => 'FN',
            self::Namespace => 'NS',
            self::Executable => 'EX',
            self::Library => 'LB',
        };
    }

    public function layer(): Layer
    {
        return match ($this) {
            self::Route => Layer::Entry,
            self::Controller, self::Middleware, self::Request, self::Resource, self::Policy => Layer::Http,
            self::Service, self::Action, self::Job, self::Event, self::Listener,
            self::Notification, self::Mailable, self::Console, self::Command, self::Schedule,
            self::Observer, self::Rule => Layer::Application,
            self::Model, self::Enum, self::Interface_, self::Trait_, self::Exception,
            self::Dto, self::Cast => Layer::Domain,
            self::PhpClass => Layer::Application,
            self::Table, self::Migration, self::Factory, self::Seeder => Layer::Data,
            self::View, self::Component, self::Livewire => Layer::View,
            self::Provider, self::Config => Layer::Infrastructure,
            self::Test, self::TestSuite => Layer::Test,
            self::Directory => Layer::Structure,
            self::Package => Layer::External,
            /*
             * C-family defaults. These are only fallbacks: the C++ and C#
             * stages classify every symbol from its own path, namespace and
             * naming convention, and pass an explicit layer with the node, so a
             * controller lands on HTTP and a data access class on Persistence.
             */
            self::Struct, self::Record => Layer::Domain,
            self::Function => Layer::Application,
            self::Namespace => Layer::Structure,
            self::Executable => Layer::Entry,
            self::Library => Layer::Infrastructure,
        };
    }

    /** Higher weight = rendered larger & pulled closer to the centre of its tier. */
    public function importance(): int
    {
        return match ($this) {
            self::Route => 90,
            self::Controller => 85,
            self::Model => 88,
            self::Table => 70,
            self::Service => 75,
            self::Livewire => 72,
            self::View => 55,
            self::Job, self::Event, self::Listener => 60,
            self::Middleware, self::Request, self::Policy, self::Resource => 50,
            self::Migration, self::Factory, self::Seeder => 40,
            self::Provider, self::Config => 45,
            self::Test => 30,
            self::PhpClass => 28,
            self::Directory => 10,
            self::Struct => 30,
            self::Record => 30,
            self::Function => 34,
            self::Namespace => 16,
            self::Executable => 92,
            self::Library => 60,
            default => 35,
        };
    }

    /** Should this type be visible when the user asks for the "runtime" default view? */
    public function isRuntimeFacing(): bool
    {
        return in_array($this, [
            self::Route, self::Controller, self::Model, self::Table, self::View,
            self::Service, self::Job, self::Event, self::Listener, self::Middleware,
            self::Request, self::Policy, self::Resource, self::Livewire, self::Component,
            // A C++ or C# runtime view is its types, its free functions and its
            // entry points — namespaces and directories stay out of the way.
            self::Struct, self::Record, self::Function, self::Executable, self::Library,
        ], true);
    }

    public static function values(): array
    {
        return array_map(fn (self $t) => $t->value, self::cases());
    }
}
