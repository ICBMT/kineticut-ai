<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python\Stages;

use App\Enums\EdgeKind;
use App\Enums\Language;
use App\Enums\Layer;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Python\PythonIndex;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;

/**
 * Stage 2 of the Python pipeline — what the project is built with.
 *
 * Python has no compile step to read, so the evidence is the packaging itself:
 * `pyproject.toml` (PEP 621 or Poetry), `requirements.txt`, `Pipfile`,
 * `setup.py`/`setup.cfg`. From those come the three things a reader wants first
 * — which Python, which framework, and what it depends on — plus the entry
 * scripts that start the whole thing (`manage.py`, `main.py`, a `__main__`
 * guard).
 *
 * The framework is the headline, exactly as it is for the other languages: a
 * Django project says "Django 5.0" before it says anything else, because that
 * one word tells you how the folders are arranged.
 */
class BuildStage implements Stage
{
    /** Packages that deserve to be the headline rather than a dependency row. */
    private const FRAMEWORKS = [
        'django' => 'Django',
        'flask' => 'Flask',
        'fastapi' => 'FastAPI',
        'starlette' => 'Starlette',
        'aiohttp' => 'aiohttp',
        'tornado' => 'Tornado',
        'pyramid' => 'Pyramid',
        'scrapy' => 'Scrapy',
        'streamlit' => 'Streamlit',
        'dash' => 'Dash',
        'pytest' => null,
        'sphinx' => null,
    ];

    /** Libraries that say what *kind* of Python project this is. */
    private const COMPANIONS = [
        'sqlalchemy' => 'SQLAlchemy',
        'django-rest-framework' => 'DRF',
        'djangorestframework' => 'DRF',
        'celery' => 'Celery',
        'pydantic' => 'Pydantic',
        'pandas' => 'pandas',
        'numpy' => 'NumPy',
        'pytorch' => 'PyTorch',
        'torch' => 'PyTorch',
        'tensorflow' => 'TensorFlow',
        'transformers' => 'Transformers',
        'scikit-learn' => 'scikit-learn',
    ];

    public function __construct(private readonly PythonIndex $index) {}

    public function name(): ScanStage
    {
        return ScanStage::Build;
    }

    public function run(ScanContext $context): array
    {
        $graph = $context->loadGraph();
        $root = $context->root;

        $packages = [];
        $manager = null;
        $requires = null;
        $projectName = null;

        // ---- pyproject.toml -------------------------------------------------
        if (is_file($root.'/pyproject.toml')) {
            $data = $this->toml($root.'/pyproject.toml');

            $manager = isset($data['tool']['poetry']) ? 'poetry'
                : (isset($data['tool']['uv']) ? 'uv' : 'pip');
            $requires = $data['project']['requires-python'] ?? $data['tool']['poetry']['dependencies']['python'] ?? null;
            $projectName = $data['project']['name'] ?? $data['tool']['poetry']['name'] ?? null;

            foreach ($this->keyed($data['project']['dependencies'] ?? []) as $name => $version) {
                $packages[$name] = $version;
            }

            foreach ($this->keyed($data['tool']['poetry']['dependencies'] ?? []) as $name => $version) {
                if (strtolower($name) !== 'python') {
                    $packages[$name] = $version;
                }
            }

            foreach ($data['project']['optional-dependencies'] ?? [] as $group) {
                foreach ($this->keyed(is_array($group) ? $group : []) as $name => $version) {
                    $packages[$name] ??= $version;
                }
            }
        }

        // ---- requirements.txt ----------------------------------------------
        if (is_file($root.'/requirements.txt')) {
            $manager ??= 'pip';

            foreach ($this->requirements($root.'/requirements.txt') as $name => $version) {
                $packages[$name] = $version;
            }
        }

        // ---- Pipfile / setup.py --------------------------------------------
        if (is_file($root.'/Pipfile')) {
            $manager ??= 'pipenv';

            $data = $this->toml($root.'/Pipfile');

            foreach ($this->keyed($data['packages'] ?? []) as $name => $version) {
                $packages[$name] = $version;
            }
        }

        if (is_file($root.'/setup.py') || is_file($root.'/setup.cfg')) {
            $manager ??= 'setuptools';

            foreach (['setup.py', 'setup.cfg'] as $manifest) {
                $text = @file_get_contents($root.'/'.$manifest);

                if ($text === false) {
                    continue;
                }

                if (preg_match('/install_requires\s*=\s*\[(.*?)\]/s', $text, $match) === 1) {
                    preg_match_all('/[\'"]([A-Za-z0-9_.\-]+)\s*([<>=!~][^,\'"]*)?[\'"]/', $match[1], $found, PREG_SET_ORDER);

                    foreach ($found as $requirement) {
                        $packages[$requirement[1]] = trim($requirement[2] ?? '');
                    }
                }
            }
        }

        // ---- the framework --------------------------------------------------
        $framework = null;
        $frameworkVersion = null;

        foreach ($packages as $name => $version) {
            $lower = strtolower($name);

            if (isset(self::FRAMEWORKS[$lower]) && self::FRAMEWORKS[$lower] !== null && $framework === null) {
                $framework = self::FRAMEWORKS[$lower];
                $frameworkVersion = $this->cleanVersion($version);
            }
        }

        // A `manage.py` is Django even when the manifest forgot to say so.
        if ($framework === null && is_file($root.'/manage.py')) {
            $framework = 'Django';
        }

        $companions = [];

        foreach ($packages as $name => $_) {
            if (isset(self::COMPANIONS[strtolower($name)])) {
                $companions[self::COMPANIONS[strtolower($name)]] = true;
            }
        }

        // ---- the Python itself ----------------------------------------------
        $python = $this->pythonVersion($requires, $root);

        $graph->node('env:python', NodeType::Package, $python !== null ? 'Python '.$python : 'Python', [
            'module' => 'Environment',
            'layer' => Layer::Infrastructure->value,
            'weight' => 72,
            'meta' => [
                'package' => 'python',
                'version' => $python,
                'requires' => is_string($requires) ? $requires : null,
                'manager' => 'platform',
                'kind' => 'platform',
                'language' => Language::Python->value,
            ],
        ]);

        // ---- the framework, as a node of its own -----------------------------
        if ($framework !== null) {
            $key = 'framework:'.strtolower($framework);

            $graph->node($key, NodeType::Library, $frameworkVersion !== null ? $framework.' '.$frameworkVersion : $framework, [
                'module' => 'Framework',
                'layer' => Layer::Infrastructure->value,
                'weight' => 82,
                'meta' => [
                    'framework' => $framework,
                    'version' => $frameworkVersion,
                    'language' => Language::Python->value,
                    'manager' => 'platform',
                    'kind' => 'platform',
                    'companions' => array_keys($companions),
                ],
            ]);

            $graph->edge('env:python', $key, EdgeKind::Provides, ['label' => $framework]);
        }

        // ---- dependencies ----------------------------------------------------
        $created = [];

        foreach ($packages as $name => $version) {
            $lower = strtolower($name);

            // The framework is already on the map as itself.
            if (isset(self::FRAMEWORKS[$lower]) && self::FRAMEWORKS[$lower] !== null) {
                continue;
            }

            $key = 'pkg:'.$name;
            $created[] = $key;

            $graph->node($key, NodeType::Package, $name, [
                'module' => 'Packages',
                'layer' => Layer::External->value,
                'weight' => 30,
                'meta' => [
                    'package' => $name,
                    'version' => $this->cleanVersion($version),
                    'manager' => $manager ?? 'pip',
                    'kind' => isset(self::COMPANIONS[$lower]) ? 'companion' : null,
                    'language' => Language::Python->value,
                ],
            ]);

            $parent = $framework !== null ? 'framework:'.strtolower($framework) : 'env:python';
            $graph->edge($parent, $key, EdgeKind::Uses, ['label' => $name]);
        }

        // ---- entry scripts ---------------------------------------------------
        $entries = $this->entries($context);

        foreach ($entries as $entry) {
            $key = 'entry:'.$entry['module'];

            $graph->node($key, NodeType::Executable, $entry['label'], [
                'file' => $entry['path'],
                'line' => $entry['line'],
                'module' => 'Entry',
                'layer' => Layer::Entry->value,
                'parent' => 'dir:'.(dirname($entry['path']) === '.' ? '' : dirname($entry['path'])),
                'loc' => $entry['lines'],
                'weight' => NodeType::Executable->importance(),
                'meta' => [
                    'language' => Language::Python->value,
                    'kind' => $entry['kind'],
                    'module_name' => $entry['module'],
                    'guard' => $entry['guard'],
                    'framework' => $framework,
                    'doc' => $entry['doc'],
                ],
            ]);

            if ($framework !== null) {
                $graph->edge($key, 'framework:'.strtolower($framework), EdgeKind::Uses, ['label' => 'starts']);
            }
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->writeArtifact('build', [
            'system' => $manager ?? ($entries !== [] ? 'python' : 'pip'),
            'project' => $projectName,
            'python' => $python,
            'requires_python' => is_string($requires) ? $requires : null,
            'framework' => $framework,
            'framework_version' => $frameworkVersion,
            'companions' => array_keys($companions),
            'packages' => array_keys($packages),
            'entries' => array_map(fn (array $entry) => $entry['module'], $entries),
        ]);

        $headline = $framework !== null
            ? trim($framework.' '.($frameworkVersion ?? ''))
            : 'Python'.($python !== null ? ' '.$python : '');

        $context->project->update(['framework_version' => $headline]);

        $context->log(sprintf(
            '%s · %d package%s · %d entry point%s',
            $headline,
            count($packages),
            count($packages) === 1 ? '' : 's',
            count($entries),
            count($entries) === 1 ? '' : 's',
        ));

        return [
            'summary' => sprintf('%s · %d packages', $headline, count($packages)),
            'metrics' => [
                'build_system' => $manager ?? 'pip',
                'package_manager' => $manager ?? 'pip',
                'packages' => count($packages),
                'package_count' => count($packages),
                'python' => $python,
                'requires_python' => is_string($requires) ? $requires : null,
                'framework' => $framework,
                'framework_version' => $frameworkVersion,
                'companions' => array_keys($companions),
                'entries' => count($entries),
                'project' => $projectName,
            ],
        ];
    }

    /**
     * The scripts that start the application, found the way a reader finds
     * them: `manage.py` and friends at the root, or anywhere a `__main__` guard
     * actually runs something.
     *
     * @return array<int, array{path:string, module:string, label:string, kind:string, guard:bool, line:?int, lines:int, doc:?string}>
     */
    private function entries(ScanContext $context): array
    {
        $entries = [];
        $seen = [];

        foreach ($this->index->modules($context) as $module) {
            if (! $this->index->isEntry($module)) {
                continue;
            }

            $path = $module['path'];
            $base = basename($path);

            if (isset($seen[$path])) {
                continue;
            }

            $seen[$path] = true;

            $kind = match (strtolower(basename($path))) {
                'manage.py' => 'manage',
                'wsgi.py' => 'wsgi',
                'asgi.py' => 'asgi',
                'cli.py' => 'cli',
                '__main__.py' => 'package',
                default => ($module['parsed']['entry'] ?? false) ? 'script' : 'module',
            };

            $entries[] = [
                'path' => $path,
                'module' => $module['module'],
                'label' => $base,
                'kind' => $kind,
                'guard' => (bool) ($module['parsed']['entry'] ?? false),
                'line' => $module['parsed']['entry_line'] ?? null,
                'lines' => $module['lines'],
                'doc' => $module['parsed']['doc'] ?? null,
            ];
        }

        // Root entry scripts first — that is the order a reader scans them in.
        usort($entries, fn (array $a, array $b) => [substr_count($a['path'], '/'), $a['path']] <=> [substr_count($b['path'], '/'), $b['path']]);

        return $entries;
    }

    /** `>=3.11`, `^3.11` or `3.11.*` all read as 3.11. */
    private function pythonVersion(?string $requires, string $root): ?string
    {
        if (is_string($requires) && $requires !== '' && preg_match('/(\d+\.\d+)/', $requires, $match) === 1) {
            return $match[1];
        }

        // No declaration: the interpreter that produced a lock file is still a
        // useful answer, and `runtime.txt` (Heroku) states it outright.
        if (is_file($root.'/runtime.txt')) {
            $text = trim((string) @file_get_contents($root.'/runtime.txt'));

            if (preg_match('/python-(\d+\.\d+)/i', $text, $match) === 1) {
                return $match[1];
            }
        }

        if (is_file($root.'/.python-version')) {
            $text = trim((string) @file_get_contents($root.'/.python-version'));

            if (preg_match('/^(\d+\.\d+)/', $text, $match) === 1) {
                return $match[1];
            }
        }

        return null;
    }

    /**
     * A deliberately small TOML reader — enough for `[project]`,
     * `[tool.poetry]`, `[packages]` and their dependency lists, which is all
     * this stage reads. Anything it does not understand it leaves alone rather
     * than guessing.
     */
    private function toml(string $path, int $depth = 0): array
    {
        $text = @file_get_contents($path);

        if ($text === false || $depth > 2) {
            return [];
        }

        $directory = dirname($path);
        $data = [];
        $pointer = &$data;
        $lines = preg_split('/\R/', $text) ?: [];
        $count = count($lines);

        for ($index = 0; $index < $count; $index++) {
            $line = trim($lines[$index]);

            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }

            // A value may continue on the next line — `dependencies = [` is how
            // every real pyproject.toml writes its dependencies.
            while ($this->unbalanced($line) > 0 && $index + 1 < $count) {
                $index++;
                $line .= ' '.trim($lines[$index]);
            }

            // ---- [section] and [section.sub], arrays of tables included -------
            if (str_starts_with($line, '[')) {
                $isArray = str_starts_with($line, '[[');
                $parts = array_map(
                    fn (string $part) => trim($part, '"\' '),
                    explode('.', trim($line, "[] \t")),
                );

                $pointer = &$data;
                $last = count($parts) - 1;

                foreach ($parts as $position => $part) {
                    if ($isArray && $position === $last) {
                        $pointer[$part] ??= [];
                        $pointer[$part][] = [];
                        $pointer = &$pointer[$part][count($pointer[$part]) - 1];

                        continue;
                    }

                    if (! isset($pointer[$part]) || ! is_array($pointer[$part])) {
                        $pointer[$part] = [];
                    }

                    $pointer = &$pointer[$part];
                }

                continue;
            }

            // ---- key = value ---------------------------------------------------
            if (preg_match('/^([A-Za-z0-9_\-\."\']+)\s*=\s*(.+)$/s', $line, $match) !== 1) {
                continue;
            }

            $key = trim($match[1], '"\' ');
            $value = trim($match[2]);
            $pointer[$key] = $this->tomlValue($value, $directory, $depth);
        }

        return $data;
    }

    /** How many brackets are still open — a positive number means "keep reading". */
    private function unbalanced(string $text): int
    {
        $depth = 0;
        $quote = null;
        $length = strlen($text);

        for ($i = 0; $i < $length; $i++) {
            $character = $text[$i];

            if ($quote !== null) {
                if ($character === $quote && ($i === 0 || $text[$i - 1] !== '\\')) {
                    $quote = null;
                }

                continue;
            }

            if ($character === '"' || $character === "'") {
                $quote = $character;

                continue;
            }

            if ($character === '[' || $character === '{') {
                $depth++;
            } elseif ($character === ']' || $character === '}') {
                $depth--;
            }
        }

        return $depth;
    }

    private function tomlValue(string $value, string $directory, int $depth): mixed
    {
        // Inline table: `django = { version = "^5.0", extras = ["bcrypt"] }`.
        if (str_starts_with($value, '{')) {
            $inner = trim($value, '{} ');
            $table = [];

            foreach ($this->splitTop($inner) as $pair) {
                if (preg_match('/^\s*([A-Za-z0-9_\-"\']+)\s*=\s*(.+)$/s', $pair, $match) === 1) {
                    $table[trim($match[1], '"\' ')] = $this->tomlValue(trim($match[2]), $directory, $depth);
                }
            }

            return $table;
        }

        // Inline array: `dependencies = ["django>=5", "requests"]`.
        if (str_starts_with($value, '[') && str_ends_with($value, ']')) {
            return array_values(array_filter(array_map(
                fn (string $item) => trim($item, '"\' '),
                $this->splitTop(trim($value, '[] ')),
            ), fn (string $item) => $item !== ''));
        }

        // A table written on its own line: `[tool.poetry.dependencies]`.
        if (preg_match('/^"([^"]+)"$|^\'([^\']+)\'$/', $value, $match) === 1) {
            return $match[1] !== '' ? $match[1] : $match[2];
        }

        if (preg_match('/^(true|false)$/i', $value) === 1) {
            return strtolower($value) === 'true';
        }

        return trim($value, '"\' ');
    }

    /**
     * Split on the commas that separate items, not the ones inside a string or
     * a nested bracket — `{extras = ["a", "b"], version = "^5"}` is one item.
     *
     * @return array<int, string>
     */
    private function splitTop(string $text): array
    {
        $parts = [];
        $buffer = '';
        $depth = 0;
        $quote = null;
        $length = strlen($text);

        for ($i = 0; $i < $length; $i++) {
            $character = $text[$i];

            if ($quote !== null) {
                $buffer .= $character;

                if ($character === $quote && ($i === 0 || $text[$i - 1] !== '\\')) {
                    $quote = null;
                }

                continue;
            }

            if ($character === '"' || $character === "'") {
                $quote = $character;
                $buffer .= $character;

                continue;
            }

            if ($character === '[' || $character === '{' || $character === '(') {
                $depth++;
            } elseif ($character === ']' || $character === '}' || $character === ')') {
                $depth--;
            }

            if ($character === ',' && $depth === 0) {
                if (trim($buffer) !== '') {
                    $parts[] = trim($buffer);
                }

                $buffer = '';

                continue;
            }

            $buffer .= $character;
        }

        if (trim($buffer) !== '') {
            $parts[] = trim($buffer);
        }

        return $parts;
    }

    /** [[tool.poetry.source]]-style arrays and PEP 621 dependency lists. */
    private function keyed(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $out = [];

        foreach ($value as $key => $item) {
            if (is_string($key) && is_string($item)) {
                $out[$key] = $item;

                continue;
            }

            if (! is_string($item)) {
                continue;
            }

            // `"django>=5.0"` → name + version, extras dropped.
            if (preg_match('/^([A-Za-z0-9_.\-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/', $item, $match) === 1) {
                $out[$match[1]] = trim($match[2]);
            }
        }

        return $out;
    }

    /** requirements.txt, including `-r other.txt` one level down. */
    private function requirements(string $path, int $depth = 0): array
    {
        $text = @file_get_contents($path);

        if ($text === false || $depth > 2) {
            return [];
        }

        $out = [];

        foreach (preg_split('/\R/', $text) ?: [] as $line) {
            $line = trim(preg_replace('/#.*/', '', $line) ?? '');

            if ($line === '') {
                continue;
            }

            if (preg_match('/^-r\s+(.+)$/', $line, $match) === 1) {
                foreach ($this->requirements(dirname($path).'/'.trim($match[1]), $depth + 1) as $name => $version) {
                    $out[$name] = $version;
                }

                continue;
            }

            if (str_starts_with($line, '-')) {
                continue;
            }

            // `django==5.0.6`, `requests>=2.31`, `uvicorn[standard]`.
            if (preg_match('/^([A-Za-z0-9_.\-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/', $line, $match) === 1) {
                $out[$match[1]] = trim($match[2]);
            }
        }

        return $out;
    }

    private function cleanVersion(mixed $version): ?string
    {
        if (! is_string($version) || trim($version) === '') {
            return null;
        }

        $version = trim($version, " \t\"'");

        // `^5.0`, `>=5.0,<6`, `==5.0.6` all read as the number itself.
        if (preg_match('/(\d+(?:\.\d+)*)/u', str_replace('*', '', $version), $match) === 1) {
            return $match[1];
        }

        return $version === '' ? null : mb_substr($version, 0, 24);
    }
}
