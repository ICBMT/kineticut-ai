<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Python;

use App\Enums\Layer;
use App\Enums\NodeType;

/**
 * What a Python symbol *is* — its node type and which architectural deck it
 * belongs on.
 *
 * Python states its intentions less formally than C# does, but it does state
 * them: the file a class lives in (`models.py`, `views.py`, `serializers.py`),
 * the decorators on a function (`@app.route`, `@property`, `@pytest.fixture`),
 * the base class it extends (`models.Model`, `Enum`, `Serializer`), and its own
 * name (`BookmarkService`, `test_*`). Those four signals are checked in order of
 * how explicit they are, and whichever fired is recorded in `meta.rule` — the
 * same self-explaining contract the C-family classifier keeps.
 *
 * Framework conventions get their own arms because they are exactly what makes
 * a Django or Flask project legible at a glance: `views.py` is transport, not
 * "some module", and a class extending `models.Model` is persistence whatever it
 * is called.
 */
class PythonSymbolClassifier
{
    /** Folder names that place code on a deck, checked outermost first. */
    private const PATH_LAYERS = [
        'http' => ['views', 'view', 'api', 'endpoints', 'routes', 'urls', 'controllers', 'controller', 'serializers', 'schemas', 'forms'],
        'data' => ['models', 'model', 'migrations', 'repositories', 'repository', 'dao', 'db', 'database', 'persistence', 'storage', 'managers'],
        'view' => ['templates', 'static', 'themes', 'jinja2', 'jinja'],
        'application' => ['services', 'service', 'usecases', 'actions', 'tasks', 'jobs', 'workers', 'handlers', 'core', 'application', 'domain', 'business', 'use_cases'],
        'infrastructure' => ['config', 'settings', 'infra', 'infrastructure', 'scripts', 'management', 'commands', 'asgi', 'wsgi'],
        'entry' => ['bin', 'cli', 'manage', 'main', 'entry', 'app', 'apps', 'samples', 'examples'],
    ];

    /**
     * @param  array  $symbol  a declaration from the parser (plus `file` context)
     * @param  string  $file  project-relative path
     * @return array{type: NodeType, layer: Layer, rule: string}
     */
    public function classify(array $symbol, string $file): array
    {
        $name = (string) ($symbol['name'] ?? '');
        $kind = (string) ($symbol['kind'] ?? 'class');
        $decorators = $this->decoratorNames($symbol['decorators'] ?? []);
        $first = $symbol['bases'][0] ?? '';
        $base = strtolower($this->baseName(is_array($first) ? (string) ($first['name'] ?? '') : (string) $first));
        $file = ltrim(str_replace('\\', '/', $file), '/');

        // ---- tests ----------------------------------------------------------
        if ($this->isTestFile($file) || $this->isTestName($name) || $this->hasDecorator($decorators, ['fixture', 'pytest.fixture'])) {
            return ['type' => NodeType::Test, 'layer' => Layer::Test, 'rule' => 'test'];
        }

        // ---- an executable script -------------------------------------------
        if ($this->isEntryModule($file, $symbol)) {
            return ['type' => NodeType::Executable, 'layer' => Layer::Entry, 'rule' => 'entry:main-guard'];
        }

        // ---- decorators: the most explicit signal Python has ----------------
        $byDecorator = $this->byDecorators($decorators, $name, $kind);

        if ($byDecorator !== null) {
            return $byDecorator;
        }

        // ---- base classes: framework intent ---------------------------------
        $byBase = $this->byBaseClass($base, $kind, $name);

        if ($byBase !== null) {
            return $byBase;
        }

        // ---- names -----------------------------------------------------------
        $byName = $this->byName($name, $kind);

        if ($byName !== null && $byName['confidence'] === 'high') {
            return $byName;
        }

        // ---- the project's own layout ----------------------------------------
        $byPath = $this->byPath($file, $kind, $name);

        if ($byPath !== null) {
            return $byPath;
        }

        if ($byName !== null) {
            return $byName;
        }

        // ---- defaults ---------------------------------------------------------
        return match ($kind) {
            'enum' => ['type' => NodeType::Enum, 'layer' => Layer::Domain, 'rule' => 'kind'],
            'protocol' => ['type' => NodeType::Interface_, 'layer' => Layer::Domain, 'rule' => 'kind'],
            'abstract' => ['type' => NodeType::PhpClass, 'layer' => Layer::Application, 'rule' => 'kind'],
            'function' => ['type' => NodeType::Function, 'layer' => Layer::Application, 'rule' => 'kind'],
            default => ['type' => NodeType::PhpClass, 'layer' => Layer::Application, 'rule' => 'default'],
        };
    }

    /**
     * A `.py` file whose whole purpose is to be run: `manage.py`, `main.py`, or
     * any module with the `if __name__ == "__main__":` guard. This is the Python
     * answer to `main()` in C++ — the thing a beginner looks for first.
     */
    public function isEntryModule(string $file, array $symbol): bool
    {
        if (($symbol['kind'] ?? '') !== 'module') {
            return false;
        }

        $base = strtolower(basename($file, '.py'));

        return ($symbol['entry'] ?? false)
            || in_array($base, ['manage', 'main', '__main__', 'cli', 'run', 'wsgi', 'asgi'], true);
    }

    private function byDecorators(array $decorators, string $name, string $kind): ?array
    {
        foreach ($decorators as $decorator) {
            // Flask / FastAPI routes and view decorators: @app.route, @app.get,
            // @router.post, @blueprint.route.  The route node itself is created
            // by the route stage; this classifies the *function* as transport.
            if (preg_match('/\.(route|get|post|put|patch|delete|head|options|websocket|websocket_route)$/', $decorator) === 1
                || in_array($decorator, ['route'], true)) {
                return ['type' => NodeType::Controller, 'layer' => Layer::Http, 'rule' => 'decorator:route'];
            }

            // Django class-based view mixin (`@method_decorator`, `@require_http_methods`).
            if (in_array($decorator, ['method_decorator', 'require_http_methods', 'require_GET', 'require_POST', 'login_required', 'permission_required', 'csrf_exempt'], true)) {
                return ['type' => NodeType::Controller, 'layer' => Layer::Http, 'rule' => 'decorator:view'];
            }

            // Celery / task-queue decorators.
            if (in_array($decorator, ['shared_task', 'task', 'app.task', 'celery.task'], true)
                || preg_match('/\.(task|shared_task)$/', $decorator) === 1) {
                return ['type' => NodeType::Job, 'layer' => Layer::Application, 'rule' => 'decorator:task'];
            }

            // Django's admin registration and `@receiver` signal handlers.
            if (in_array($decorator, ['receiver'], true)) {
                return ['type' => NodeType::Listener, 'layer' => Layer::Application, 'rule' => 'decorator:receiver'];
            }

            if (preg_match('/\.(property|setter|deleter)$/', $decorator) === 1) {
                return null;
            }
        }

        return null;
    }

    private function byBaseClass(string $base, string $kind, string $name): ?array
    {
        if ($base === '') {
            return null;
        }

        // Django: models, forms, serializers, views, middleware, tests.
        if ($base === 'model' || str_ends_with($base, '.model')) {
            return ['type' => NodeType::Model, 'layer' => Layer::Domain, 'rule' => 'base:models.Model'];
        }

        if (str_ends_with($base, 'serializer') || str_ends_with($base, 'modelserializer')) {
            return ['type' => NodeType::Resource, 'layer' => Layer::Http, 'rule' => 'base:Serializer'];
        }

        if (str_ends_with($base, 'form') || $base === 'modelform') {
            return ['type' => NodeType::Request, 'layer' => Layer::Http, 'rule' => 'base:Form'];
        }

        if (preg_match('/(view|viewset|apiview|genericview|templateview|listview|detailview)$/', $base) === 1
            || $base === 'view') {
            return ['type' => NodeType::Controller, 'layer' => Layer::Http, 'rule' => 'base:View'];
        }

        if (str_contains($base, 'middleware')) {
            return ['type' => NodeType::Middleware, 'layer' => Layer::Http, 'rule' => 'base:Middleware'];
        }

        if (str_ends_with($base, 'pagination') || str_ends_with($base, 'permission') || str_ends_with($base, 'authentication')) {
            return ['type' => NodeType::Policy, 'layer' => Layer::Http, 'rule' => 'base:'.strtolower($name)];
        }

        // Pydantic / dataclasses / attrs: plain data with types.
        if (in_array($base, ['basemodel', 'dataclass', 'attrs', 'attr.s'], true) || str_ends_with($base, 'basemodel') || str_ends_with($base, 'schema')) {
            return ['type' => NodeType::Dto, 'layer' => Layer::Domain, 'rule' => 'base:BaseModel'];
        }

        if (str_ends_with($base, 'settings') || str_ends_with($base, 'config')) {
            return ['type' => NodeType::Config, 'layer' => Layer::Infrastructure, 'rule' => 'base:Config'];
        }

        if (str_ends_with($base, 'exception') || str_ends_with($base, 'error')) {
            return ['type' => NodeType::Exception, 'layer' => Layer::Domain, 'rule' => 'base:Exception'];
        }

        if ($kind === 'enum') {
            return ['type' => NodeType::Enum, 'layer' => Layer::Domain, 'rule' => 'kind:enum'];
        }

        return null;
    }

    /** Suffix rules, mirroring how the C-family classifier reads names. */
    private function byName(string $name, string $kind): ?array
    {
        $lower = strtolower($name);

        $map = [
            'viewset' => [NodeType::Controller, Layer::Http, 'high'],
            'view' => [NodeType::Controller, Layer::Http, 'high'],
            'controller' => [NodeType::Controller, Layer::Http, 'high'],
            'serializer' => [NodeType::Resource, Layer::Http, 'high'],
            'form' => [NodeType::Request, Layer::Http, 'high'],
            'middleware' => [NodeType::Middleware, Layer::Http, 'high'],
            'service' => [NodeType::Service, Layer::Application, 'high'],
            'manager' => [NodeType::Service, Layer::Application, 'high'],
            'repository' => [NodeType::Service, Layer::Data, 'high'],
            'helper' => [NodeType::Service, Layer::Application, 'medium'],
            'handler' => [NodeType::Service, Layer::Application, 'medium'],
            'task' => [NodeType::Job, Layer::Application, 'high'],
            'job' => [NodeType::Job, Layer::Application, 'high'],
            'worker' => [NodeType::Job, Layer::Application, 'medium'],
            'command' => [NodeType::Command, Layer::Application, 'high'],
            'settings' => [NodeType::Config, Layer::Infrastructure, 'high'],
            'config' => [NodeType::Config, Layer::Infrastructure, 'high'],
            'factory' => [NodeType::Factory, Layer::Data, 'medium'],
            'schema' => [NodeType::Dto, Layer::Domain, 'high'],
            'dto' => [NodeType::Dto, Layer::Domain, 'high'],
            'exception' => [NodeType::Exception, Layer::Domain, 'medium'],
            'error' => [NodeType::Exception, Layer::Domain, 'medium'],
            'test' => [NodeType::Test, Layer::Test, 'high'],
        ];

        foreach ($map as $suffix => [$type, $layer, $confidence]) {
            if (str_ends_with($lower, $suffix)) {
                return ['type' => $type, 'layer' => $layer, 'rule' => 'name:'.$suffix, 'confidence' => $confidence];
            }
        }

        // Protocols and ABCs are the Python spelling of an interface.
        if ($kind === 'protocol') {
            return ['type' => NodeType::Interface_, 'layer' => Layer::Domain, 'rule' => 'kind:protocol', 'confidence' => 'medium'];
        }

        return null;
    }

    private function byPath(string $file, string $kind, string $name): ?array
    {
        $segments = array_map('strtolower', explode('/', $file));
        array_pop($segments);

        foreach ($segments as $segment) {
            // `bookmarks/models.py` — the file name is the strongest folder-level
            // signal in Python, so both the directory and the file are checked.
            $segment = str_replace('.py', '', $segment);

            foreach (self::PATH_LAYERS as $deck => $names) {
                if (! in_array($segment, $names, true)) {
                    continue;
                }

                $layer = Layer::from($deck);

                $type = match ($deck) {
                    'http' => NodeType::Controller,
                    'data' => NodeType::Model,
                    'view' => NodeType::View,
                    'infrastructure' => NodeType::Config,
                    'entry' => NodeType::Executable,
                    default => NodeType::Service,
                };

                $type = match ($kind) {
                    'enum' => NodeType::Enum,
                    'protocol' => NodeType::Interface_,
                    'abstract' => NodeType::PhpClass,
                    'function' => $deck === 'http' ? NodeType::Controller : NodeType::Function,
                    default => $type,
                };

                return ['type' => $type, 'layer' => $layer, 'rule' => 'path:'.$segment];
            }
        }

        return null;
    }

    public function isTestFile(string $file): bool
    {
        $lower = strtolower(str_replace('\\', '/', $file));
        $base = basename($lower);
        $segments = explode('/', $lower);

        if (in_array('tests', $segments, true) || in_array('test', $segments, true)) {
            return true;
        }

        return str_starts_with($base, 'test_')
            || str_ends_with($base, '_test.py')
            || str_ends_with($base, 'conftest.py');
    }

    private function isTestName(string $name): bool
    {
        return str_starts_with(strtolower($name), 'test_');
    }

    /** @return array<int, string> */
    private function decoratorNames(array $decorators): array
    {
        $names = [];

        foreach ($decorators as $decorator) {
            $names[] = strtolower(is_array($decorator) ? (string) ($decorator['name'] ?? '') : (string) $decorator);
        }

        return array_values(array_filter($names));
    }

    private function hasDecorator(array $decorators, array $candidates): bool
    {
        foreach ($candidates as $candidate) {
            if (in_array($candidate, $decorators, true)) {
                return true;
            }
        }

        return false;
    }

    private function baseName(string $base): string
    {
        $parts = explode('.', trim($base, '\\'));

        return (string) end($parts);
    }
}
