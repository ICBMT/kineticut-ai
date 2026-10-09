<?php

declare(strict_types=1);

namespace App\Services\Scan\Parsers;

/**
 * A deliberately lightweight Blade reader.
 *
 * Blade is not pure PHP, so instead of an AST we scan for the directives that
 * carry architectural meaning: layout inheritance, includes, components,
 * Livewire mounts, route() calls and policy checks. It is fast (regex only) and
 * good enough to draw the presentation layer truthfully.
 */
class BladeParser
{
    private const CAPTURE_DIRECTIVES = [
        'extends' => 'extends',
        'include' => 'include',
        'includeIf' => 'include',
        'includeWhen' => 'include',
        'includeUnless' => 'include',
        'includeFirst' => 'include',
        'each' => 'include',
        'component' => 'component',
        'componentFirst' => 'component',
        'livewire' => 'livewire',
    ];

    public function parse(string $absolutePath, string $relativePath, string $viewName): array
    {
        $code = @file_get_contents($absolutePath);

        if ($code === false) {
            return [];
        }

        $result = [
            'name' => $viewName,
            'path' => $relativePath,
            'loc' => substr_count($code, "\n") + 1,
            'extends' => [],
            'includes' => [],
            'components' => [],
            'livewire' => [],
            'routes' => [],
            'gates' => [],
            'sections' => [],
            'stacks' => [],
            'yields' => [],
            'variables' => [],
            'slots' => [],
            'props' => [],
        ];

        // ---- Directives: @extends('x'), @include('y', [...]), @livewire('z') ----
        foreach (self::CAPTURE_DIRECTIVES as $directive => $bucket) {
            if (! preg_match_all('/@'.$directive.'\s*\(\s*([\'"])(.+?)\1/m', $code, $matches)) {
                continue;
            }

            foreach ($matches[2] as $value) {
                $value = trim($value);
                if ($value === '') {
                    continue;
                }
                $result[$bucket][] = $value;
            }
        }

        if (preg_match_all('/@each\s*\(\s*([\'"])(.+?)\1/m', $code, $matches)) {
            foreach ($matches[2] as $value) {
                $result['includes'][] = trim($value);
            }
        }

        // ---- <x-component /> and <livewire:component /> tags ----
        if (preg_match_all('/<x-([a-zA-Z0-9_.\-:]+)/', $code, $matches)) {
            foreach ($matches[1] as $tag) {
                $tag = str_replace(['.', ':'], ['/', '-'], strtolower($tag));
                if (str_starts_with($tag, 'slot') || str_starts_with($tag, 'dynamic')) {
                    continue;
                }
                $result['components'][] = $tag;
            }
        }

        if (preg_match_all('/<livewire:([a-zA-Z0-9_.\-]+)/', $code, $matches)) {
            foreach ($matches[1] as $tag) {
                $result['livewire'][] = $this->kebabToClass($tag);
            }
        }

        if (preg_match_all('/@livewire\s*\(\s*([\'"])(.+?)\1/', $code, $matches)) {
            foreach ($matches[2] as $tag) {
                $result['livewire'][] = $this->kebabToClass($tag);
            }
        }

        // ---- route('users.index') references ----
        if (preg_match_all('/(?:route|to_route)\s*\(\s*([\'"])(.+?)\1/', $code, $matches)) {
            $result['routes'] = array_values(array_unique($matches[2]));
        }

        // ---- @can / @cannot / @canany ----
        if (preg_match_all('/@(?:can|cannot|canany|elseif)\s*\(\s*([\'"])(.+?)\1/', $code, $matches)) {
            $result['gates'] = array_values(array_unique($matches[2]));
        }

        if (preg_match_all('/@(section|push|prepend)\s*\(\s*([\'"])(.+?)\2/', $code, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $result[$match[1] === 'section' ? 'sections' : 'stacks'][] = $match[3];
            }
        }

        if (preg_match_all('/@(yield|stack)\s*\(\s*([\'"])(.+?)\2/', $code, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $match) {
                $result['yields'][] = $match[3];
            }
        }

        if (preg_match_all('/<x-slot:?([a-zA-Z0-9_\-]+)?/', $code, $matches)) {
            $result['slots'] = array_values(array_unique(array_filter($matches[1])));
        }

        // ---- Detected props: @props([...]) and component class fields ----
        if (preg_match('/@props\s*\(\s*\[(.*?)\]/s', $code, $match)) {
            if (preg_match_all('/[\'"]([a-zA-Z0-9_]+)[\'"]\s*=>/', $match[1], $propMatches)) {
                $result['props'] = array_values(array_unique($propMatches[1]));
            }
        }

        // ---- Variables reaching the view: {{ $user }} style usage ----
        if (preg_match_all('/\{\{\s*\$([a-zA-Z_][a-zA-Z0-9_]*)/', $code, $matches)) {
            $result['variables'] = array_values(array_unique(array_slice($matches[1], 0, 25)));
        }

        $result['sections'] = array_values(array_unique($result['sections']));
        $result['yields'] = array_values(array_unique($result['yields']));
        $result['stacks'] = array_values(array_unique($result['stacks']));
        $result['components'] = array_values(array_unique($result['components']));
        $result['livewire'] = array_values(array_unique($result['livewire']));
        $result['includes'] = array_values(array_unique($result['includes']));
        $result['extends'] = array_values(array_unique($result['extends']));

        return $result;
    }

    /** `user-table` => `UserTable` (Livewire component class base name). */
    private function kebabToClass(string $kebab): string
    {
        $kebab = str_replace(['.', '/'], '-', $kebab);

        return str_replace(' ', '', ucwords(str_replace('-', ' ', $kebab)));
    }

    public static function viewNameFromPath(string $relativePath): string
    {
        $path = preg_replace('#^resources/views/#', '', $relativePath) ?? $relativePath;
        $path = preg_replace('#\.blade\.php$#', '', $path) ?? $path;
        $path = preg_replace('#\.php$#', '', $path) ?? $path;

        return str_replace('/', '.', $path);
    }
}
