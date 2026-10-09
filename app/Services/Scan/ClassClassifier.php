<?php

declare(strict_types=1);

namespace App\Services\Scan;

use App\Enums\NodeType;

/**
 * Decides what a PHP class *is* in Laravel terms.
 *
 * Namespaces are the strongest signal, then the class name suffix, then what it
 * extends or implements. The order matters: a `Policy` in `app/Policies` is a
 * policy even though it does not extend anything.
 */
class ClassClassifier
{
    public function classify(array $class): NodeType
    {
        $fqcn = $class['fqcn'] ?? '';
        $name = $class['label'] ?? '';
        $namespace = $class['namespace'] ?? '';
        $kind = $class['kind'] ?? 'class';
        $file = $class['file'] ?? '';
        $extends = (string) ($class['extends'] ?? '');
        $implements = $class['implements'] ?? [];
        $traits = $class['traits'] ?? [];

        if ($kind === 'interface') {
            return NodeType::Interface_;
        }
        if ($kind === 'trait') {
            return NodeType::Trait_;
        }
        if ($kind === 'enum') {
            return NodeType::Enum;
        }

        if (str_starts_with($file, 'tests/') || str_ends_with($name, 'Test') || $namespace === 'Tests') {
            return NodeType::Test;
        }
        if (str_contains($namespace, 'Database\\Factories') || str_ends_with($name, 'Factory')) {
            return NodeType::Factory;
        }
        if (str_contains($namespace, 'Database\\Seeders') || str_ends_with($name, 'Seeder')) {
            return NodeType::Seeder;
        }
        if (str_contains($namespace, 'Console\\Commands') || str_contains($namespace, '\\Commands') || str_ends_with($name, 'Command')) {
            return NodeType::Command;
        }
        if (str_contains($namespace, '\\Http\\Controllers') || str_ends_with($name, 'Controller')) {
            return NodeType::Controller;
        }
        if (str_contains($namespace, '\\Http\\Middleware') || str_ends_with($name, 'Middleware')) {
            return NodeType::Middleware;
        }
        if (str_contains($namespace, '\\Http\\Requests') || str_ends_with($name, 'Request')) {
            return NodeType::Request;
        }
        if (str_contains($namespace, '\\Http\\Resources') || str_ends_with($name, 'Resource') || str_ends_with($name, 'Collection')) {
            return NodeType::Resource;
        }
        if (str_contains($namespace, 'Policies') || str_ends_with($name, 'Policy')) {
            return NodeType::Policy;
        }
        if (str_contains($namespace, '\\Livewire') || in_array('Livewire\\Component', array_map(fn ($i) => ltrim((string) $i, '\\'), $implements), true)) {
            return NodeType::Livewire;
        }
        if (str_contains($namespace, 'Observers') || str_ends_with($name, 'Observer')) {
            return NodeType::Observer;
        }
        if (str_contains($namespace, '\\Jobs') || str_ends_with($name, 'Job')) {
            return NodeType::Job;
        }
        if (str_contains($namespace, '\\Events') || str_ends_with($name, 'Event')) {
            return NodeType::Event;
        }
        if (str_contains($namespace, '\\Listeners') || str_ends_with($name, 'Listener')) {
            return NodeType::Listener;
        }
        if (str_contains($namespace, '\\Notifications') || str_ends_with($name, 'Notification')) {
            return NodeType::Notification;
        }
        if (str_contains($namespace, '\\Mail') || str_ends_with($name, 'Mail') || str_ends_with($name, 'Mailable')) {
            return NodeType::Mailable;
        }
        if (str_contains($namespace, '\\Rules') || str_ends_with($name, 'Rule')) {
            return NodeType::Rule;
        }
        if (str_contains($namespace, 'Casts') || str_ends_with($name, 'Cast')) {
            return NodeType::Cast;
        }
        if (str_contains($namespace, 'Providers') || str_ends_with($name, 'ServiceProvider')) {
            return NodeType::Provider;
        }
        if (str_contains($namespace, 'Exceptions') || str_ends_with($name, 'Exception')) {
            return NodeType::Exception;
        }
        if (str_contains($namespace, 'Data') || str_contains($namespace, 'DTO') || str_ends_with($name, 'Data') || str_ends_with($name, 'Dto')) {
            return NodeType::Dto;
        }

        $extendsChain = strtolower($extends);
        if (str_ends_with($extendsChain, '\\model') || $extendsChain === 'model' || str_contains($namespace, '\\Models')) {
            return NodeType::Model;
        }
        if (str_contains($extendsChain, '\\mailable') || str_contains($extendsChain, '\\notification')) {
            return str_contains($extendsChain, 'mailable') ? NodeType::Mailable : NodeType::Notification;
        }
        if (str_contains($extendsChain, '\\command') || str_contains($extendsChain, '\\migration')) {
            return str_contains($extendsChain, 'migration') ? NodeType::Migration : NodeType::Command;
        }
        if (str_contains($extendsChain, '\\controller')) {
            return NodeType::Controller;
        }

        if (str_contains($namespace, 'Services') || str_ends_with($name, 'Service')) {
            return NodeType::Service;
        }
        if (str_contains($namespace, 'Actions') || str_ends_with($name, 'Action')) {
            return NodeType::Action;
        }
        if (str_contains($namespace, 'Support') || str_contains($namespace, 'Helpers')) {
            return NodeType::PhpClass;
        }

        if (str_contains($namespace, 'App\\')) {
            return NodeType::PhpClass;
        }

        return NodeType::PhpClass;
    }

    /**
     * A human-readable "module" grouping used for colour clustering and the
     * module legend. Derived from the path so it always matches the real repo.
     */
    public function moduleFor(string $relativePath, string $fqcn = ''): string
    {
        $path = str_replace('\\', '/', $relativePath);
        $segments = explode('/', $path);

        if (($segments[0] ?? '') === 'app') {
            if (isset($segments[1]) && ! str_contains($segments[1], '.')) {
                return $segments[1];
            }

            return 'App';
        }

        if (($segments[0] ?? '') === 'resources' && ($segments[1] ?? '') === 'views') {
            $sub = $segments[2] ?? '';
            if ($sub !== '' && ! str_contains($sub, '.')) {
                return 'Views/'.$sub;
            }

            return 'Views';
        }

        if (($segments[0] ?? '') === 'routes') {
            return 'Routes';
        }

        if (($segments[0] ?? '') === 'database') {
            return 'Database';
        }

        if (($segments[0] ?? '') === 'tests') {
            $sub = $segments[1] ?? '';

            return 'Tests'.($sub !== '' && ! str_contains($sub, '.') ? '/'.$sub : '');
        }

        if (($segments[0] ?? '') === 'config') {
            return 'Config';
        }

        if (($segments[0] ?? '') === 'bootstrap') {
            return 'Bootstrap';
        }

        return $segments[0] !== '' ? ucfirst($segments[0]) : 'Root';
    }
}
