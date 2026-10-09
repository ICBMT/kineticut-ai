<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Turns the short class references found in a PHP file (`User::class`, `new Order`,
 * `ServiceInterface $svc`) back into fully qualified names, using the file's
 * namespace plus its `use` statements. Getting this right is what makes the
 * dependency edges trustworthy instead of a pile of guessed names.
 */
class NameResolver
{
    /** @param array<string, string> $imports alias => FQCN */
    public function __construct(
        private readonly string $namespace,
        private readonly array $imports = [],
        private readonly ?string $selfClass = null,
        private readonly ?string $parentClass = null,
    ) {}

    public function namespace(): string
    {
        return $this->namespace;
    }

    /** @return array<string, string> */
    public function imports(): array
    {
        return $this->imports;
    }

    /**
     * Resolve a node name taken from an AST to an absolute FQCN.
     * Returns null for built-in / un-namespaced scalars.
     */
    public function resolve(string $name): ?string
    {
        $name = trim($name);

        if ($name === '' || $name === 'static' || $name === 'self' || $name === 'parent') {
            return match ($name) {
                'static', 'self' => $this->selfClass,
                'parent' => $this->parentClass,
                default => null,
            };
        }

        if (str_starts_with($name, '\\')) {
            return ltrim($name, '\\');
        }

        $parts = explode('\\', $name);
        $head = $parts[0];

        // Direct import alias: `use App\Models\User as U;` => U\... => App\Models\User\...
        if (isset($this->imports[$head])) {
            $parts[0] = $this->imports[$head];

            return implode('\\', $parts);
        }

        // Already partially qualified relative to the current namespace.
        if ($this->namespace !== '') {
            return $this->namespace.'\\'.ltrim($name, '\\');
        }

        return $name;
    }

    /** True when the name looks like a builtin type or scalar. */
    public static function isBuiltin(string $name): bool
    {
        $lower = strtolower(ltrim($name, '\\'));

        return in_array($lower, [
            'int', 'float', 'string', 'bool', 'array', 'object', 'mixed', 'void', 'null',
            'callable', 'iterable', 'never', 'false', 'true', 'self', 'static', 'parent',
            'closure', 'generator', 'resource', 'number', 'scalar',
        ], true);
    }

    /** The short class name from a FQCN. */
    public static function short(string $fqcn): string
    {
        $segments = explode('\\', $fqcn);

        return end($segments) ?: $fqcn;
    }

    /** The namespace portion of a FQCN ('' when in the global namespace). */
    public static function namespaceOf(string $fqcn): string
    {
        $position = strrpos($fqcn, '\\');

        return $position === false ? '' : substr($fqcn, 0, $position);
    }

    /**
     * Famous framework classes we never create nodes for, but do count
     * so the "framework surface" metric is honest.
     */
    public static function isFramework(string $fqcn): bool
    {
        foreach ([
            'Illuminate\\', 'Laravel\\', 'Symfony\\', 'Carbon\\', 'Psr\\', 'Monolog\\',
            'GuzzleHttp\\', 'Doctrine\\', 'Composer\\', 'PHPUnit\\', 'Faker\\', 'Pest\\',
            'GrahamCampbell\\', 'Ramsey\\', 'League\\', 'Intervention\\', 'Spatie\\',
            'Livewire\\', 'Inertia\\', 'Filament\\', 'BaconQrCode\\', 'ZipStream\\',
        ] as $prefix) {
            if (str_starts_with($fqcn, $prefix)) {
                return true;
            }
        }

        return false;
    }

    /** Which composer package owns a vendor namespace (best-effort). */
    public static function vendorOf(string $fqcn): string
    {
        $segments = explode('\\', $fqcn);

        return (string) ($segments[0] ?? '');
    }
}
