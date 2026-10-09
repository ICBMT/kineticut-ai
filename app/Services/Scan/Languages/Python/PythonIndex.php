<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python;

use App\Services\Scan\ScanContext;

/**
 * The parsed Python modules of a project, read once for the stages that need
 * them.
 *
 * Python has no headers and no build target source lists, so "which files are
 * part of the project" is answered by the file index alone. Every stage that
 * wants source — declarations, routes, models, templates — asks here and gets
 * the same modules in the same order, so a route can always be traced back to
 * the class that declares it.
 */
class PythonIndex
{
    /** Nothing legible lives in a file larger than this. */
    private const MAX_BYTES = 2_500_000;

    /** Leading folders that are packaging furniture, not importable packages. */
    private const CONTAINERS = ['src', 'lib', 'source'];

    /** @var array<string, array<int, array>> */
    private array $cache = [];

    public function __construct(private readonly PythonParser $parser) {}

    /**
     * @return array<int, array{path:string, module:string, source:string, parsed:array, lines:int, size:int}>
     */
    public function modules(ScanContext $context): array
    {
        // Declaration, route, model and view stages all want the parsed modules;
        // the artefact's stamp is what makes caching across stages safe, because
        // a second scan of another project replaces it.
        $stamp = $context->root.'|'.@filemtime($context->artifactPath('files')).'|'.@filesize($context->artifactPath('files'));

        if (isset($this->cache[$stamp])) {
            return $this->cache[$stamp];
        }

        $files = $context->readArtifact('files')['files'] ?? [];
        $modules = [];

        foreach ($files as $file) {
            $path = (string) ($file['path'] ?? '');

            if (preg_match('/\.pyw?$|\.pyi$/', $path) !== 1) {
                continue;
            }

            if (($file['size'] ?? 0) > self::MAX_BYTES) {
                continue;
            }

            $source = @file_get_contents($context->root.'/'.$path);

            if ($source === false || trim($source) === '') {
                continue;
            }

            $modules[] = [
                'path' => $path,
                'module' => $this->moduleName($path),
                'source' => $source,
                'parsed' => $this->parser->parse($source),
                'lines' => substr_count($source, "\n") + 1,
                'size' => strlen($source),
            ];
        }

        return $this->cache[$stamp] = $modules;
    }

    /**
     * `app/bookmarks/models.py` → `app.bookmarks.models`, `app/__init__.py` →
     * `app`. The leading `src`/`lib` wrapper is dropped because it is not
     * importable — `from app.models import Bookmark` has to match.
     */
    public function moduleName(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $segments = array_values(array_filter(explode('/', $path), fn (string $s) => $s !== ''));

        if ($segments !== [] && in_array(strtolower($segments[0]), self::CONTAINERS, true)) {
            array_shift($segments);
        }

        $name = implode('.', array_map(
            fn (string $segment) => preg_replace('/\.pyi?w?$/', '', $segment),
            $segments,
        ));

        return $name === '' || $name === '__init__' ? 'app' : $name;
    }

    /** The graph key a module's namespace node uses. */
    public function moduleKey(string $module): string
    {
        return 'module:'.$module;
    }

    /**
     * A module whose job is to start something: a `__main__` guard, or the
     * conventional names a framework tells you to look for.
     */
    public function isEntry(array $module): bool
    {
        $base = strtolower(basename($module['path'], '.py'));

        return ($module['parsed']['entry'] ?? false) === true
            || in_array($base, ['manage', 'main', '__main__', 'cli', 'run', 'app', 'wsgi', 'asgi'], true);
    }

    /** `def greet(name, greeting='hi') -> str` → a signature the panel can show. */
    public function signature(array $function): string
    {
        $arguments = [];

        foreach ($function['args'] ?? [] as $argument) {
            $piece = (string) ($argument['name'] ?? '');

            if (($argument['annotation'] ?? null) !== null) {
                $piece .= ': '.$argument['annotation'];
            }

            if (($argument['default'] ?? null) !== null) {
                $piece .= ' = '.$argument['default'];
            }

            $arguments[] = $piece;
        }

        $returns = $function['returns'] ?? null;

        return sprintf(
            '%sdef %s(%s)%s',
            ($function['async'] ?? false) ? 'async ' : '',
            $function['name'] ?? '?',
            implode(', ', array_filter($arguments)),
            $returns !== null ? ' -> '.$returns : '',
        );
    }
}
