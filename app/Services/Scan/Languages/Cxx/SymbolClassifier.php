<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx;

use App\Enums\Layer;
use App\Enums\Language;
use App\Enums\NodeType;

/**
 * Decides what a C++ or C# symbol *is* — its node type and which architectural
 * deck it belongs on.
 *
 * This is the part that makes a foreign codebase legible at a glance, so the
 * rules are explicit and ordered: a test is a test whatever it is called, a
 * controller is a controller because of its name or its attributes, and
 * everything else falls back to the project's own folder layout. Nothing here
 * guesses from a single signal — every rule states why it fired in the node's
 * metadata (`meta.rule`), which is how the atlas can explain itself.
 */
class SymbolClassifier
{
    /** Folder segments that place code on a deck, in priority order. */
    private const PATH_LAYERS = [
        'http' => ['controllers', 'controller', 'api', 'http', 'web', 'endpoints', 'routes'],
        'data' => ['data', 'persistence', 'database', 'db', 'repositories', 'repository', 'storage', 'migrations', 'dao'],
        // `render`/`components` are deliberately absent: in a graphics or
        // engine codebase they name the domain, not the presentation layer.
        'view' => ['views', 'view', 'ui', 'gui', 'widgets', 'pages', 'screens', 'templates', 'themes'],
        'application' => ['services', 'service', 'application', 'app', 'core', 'engine', 'engines', 'actions', 'usecases', 'handlers', 'jobs', 'workers', 'tasks', 'business'],
        'domain' => ['domain', 'model', 'models', 'entities', 'entity', 'dto', 'dtos', 'contracts', 'types', 'value', 'values'],
        'infrastructure' => ['infrastructure', 'infra', 'config', 'configuration', 'platform', 'build', 'cmake', 'vendor', 'third_party'],
        'entry' => ['main', 'cli', 'console', 'bootstrap', 'entry', 'apps', 'samples', 'examples', 'tools'],
    ];

    /**
     * @param  array  $symbol  a declaration from the parser
     * @param  string  $file  project-relative path
     * @return array{type: NodeType, layer: Layer, rule: string}
     */
    public function classify(Language $language, array $symbol, string $file): array
    {
        $name = $symbol['name'] ?? '';
        $qualified = $symbol['qualified'] ?? $name;
        $namespace = $symbol['namespace'] ?? '';
        $kind = $symbol['kind'] ?? 'class';
        $attributes = array_map(
            fn (array $a) => strtolower($a['name']),
            $symbol['attributes'] ?? [],
        );

        // ---- the entry point -------------------------------------------------
        // `main` is where a C++ or C# program starts, so it belongs on the
        // entrypoint deck however the project is laid out.
        if (($symbol['kind'] ?? '') === 'function' && in_array(strtolower($name), ['main', 'wmain', 'tmain'], true)) {
            return ['type' => NodeType::Function, 'layer' => Layer::Entry, 'rule' => 'name:main'];
        }

        // ---- tests ----------------------------------------------------------
        if ($this->isTestFile($file) || $this->hasTestAttribute($attributes)) {
            return ['type' => NodeType::Test, 'layer' => Layer::Test, 'rule' => 'test'];
        }

        // ---- attributes first: they are explicit intent ---------------------
        if ($language === Language::CSharp) {
            $byAttribute = $this->byCSharpAttribute($attributes, $name);

            if ($byAttribute !== null) {
                return $byAttribute;
            }
        }

        // ---- names ----------------------------------------------------------
        $byName = $this->byName($language, $kind, $name);

        if ($byName !== null && $byName['confidence'] === 'high') {
            return $byName;
        }

        // ---- the project's own folder layout ---------------------------------
        $byPath = $this->byPath($file, $kind);

        if ($byPath !== null) {
            return $byPath;
        }

        if ($byName !== null) {
            return $byName;
        }

        // ---- defaults --------------------------------------------------------
        if ($kind === 'struct' || $kind === 'record' || $kind === 'union') {
            return ['type' => NodeType::Struct, 'layer' => Layer::Domain, 'rule' => 'kind'];
        }

        if ($kind === 'enum') {
            return ['type' => NodeType::Enum, 'layer' => Layer::Domain, 'rule' => 'kind'];
        }

        if ($kind === 'interface') {
            return ['type' => NodeType::Interface_, 'layer' => Layer::Domain, 'rule' => 'kind'];
        }

        if ($kind === 'function') {
            return ['type' => NodeType::Function, 'layer' => Layer::Application, 'rule' => 'kind'];
        }

        return ['type' => NodeType::PhpClass, 'layer' => Layer::Application, 'rule' => 'default'];
    }

    /** A type name that resolves to a known NodeType, with how sure we are. */
    private function byName(Language $language, string $kind, string $name): ?array
    {
        $lower = strtolower($name);

        $map = [
            'controller' => [NodeType::Controller, Layer::Http, 'high'],
            'endpoint' => [NodeType::Controller, Layer::Http, 'high'],
            'middleware' => [NodeType::Middleware, Layer::Http, 'high'],
            'service' => [NodeType::Service, Layer::Application, 'high'],
            'manager' => [NodeType::Service, Layer::Application, 'high'],
            'engine' => [NodeType::Service, Layer::Application, 'medium'],
            'handler' => [NodeType::Service, Layer::Application, 'medium'],
            'repository' => [NodeType::Service, Layer::Data, 'high'],
            'dao' => [NodeType::Service, Layer::Data, 'high'],
            'context' => [NodeType::Service, Layer::Data, 'medium'],
            'provider' => [NodeType::Provider, Layer::Infrastructure, 'medium'],
            'config' => [NodeType::Config, Layer::Infrastructure, 'medium'],
            'settings' => [NodeType::Config, Layer::Infrastructure, 'medium'],
            'dto' => [NodeType::Dto, Layer::Domain, 'high'],
            'request' => [NodeType::Dto, Layer::Domain, 'medium'],
            'response' => [NodeType::Dto, Layer::Domain, 'medium'],
            'entity' => [NodeType::Model, Layer::Domain, 'high'],
            'model' => [NodeType::Model, Layer::Domain, 'high'],
            'exception' => [NodeType::Exception, Layer::Domain, 'medium'],
            'test' => [NodeType::Test, Layer::Test, 'high'],
        ];

        foreach ($map as $suffix => [$type, $layer, $confidence]) {
            if (str_ends_with($lower, $suffix)) {
                // An interface called `IUserService` is a service contract, not
                // a service — but it still belongs on the same deck.
                return ['type' => $kind === 'interface' && $type === NodeType::Service ? NodeType::Interface_ : $type, 'layer' => $layer, 'rule' => 'name:'.$suffix, 'confidence' => $confidence];
            }
        }

        // C++ and C# both mark interfaces with a leading I.
        if (preg_match('/^I[A-Z][A-Za-z0-9]*$/', $name) && $language === Language::CSharp) {
            return ['type' => NodeType::Interface_, 'layer' => Layer::Domain, 'rule' => 'name:IFace', 'confidence' => 'medium'];
        }

        return null;
    }

    /** ASP.NET attributes are the most reliable signal there is. */
    private function byCSharpAttribute(array $attributes, string $name): ?array
    {
        foreach ($attributes as $attribute) {
            if (in_array($attribute, ['apicontroller', 'controller'], true)) {
                return ['type' => NodeType::Controller, 'layer' => Layer::Http, 'rule' => 'attribute:'.$attribute];
            }

            if (in_array($attribute, ['route', 'httpget', 'httppost', 'httpput', 'httpdelete', 'httppatch'], true)) {
                return ['type' => NodeType::Controller, 'layer' => Layer::Http, 'rule' => 'attribute:'.$attribute];
            }

            if (str_starts_with($attribute, 'test') || in_array($attribute, ['fact', 'theory'], true)) {
                return ['type' => NodeType::Test, 'layer' => Layer::Test, 'rule' => 'attribute:'.$attribute];
            }
        }

        return null;
    }

    /** The project's folder layout, when the name told us nothing. */
    private function byPath(string $file, string $kind): ?array
    {
        $segments = array_map('strtolower', explode('/', str_replace('\\', '/', $file)));

        // Drop the file name itself and the container folders every project has.
        array_pop($segments);

        $containers = ['src', 'source', 'sources', 'app', 'lib', 'include', 'inc', 'code'];
        $segments = array_values(array_filter($segments, fn (string $s) => ! in_array($s, $containers, true)));

        foreach ($segments as $segment) {
            foreach (self::PATH_LAYERS as $deck => $names) {
                if (! in_array($segment, $names, true)) {
                    continue;
                }

                $layer = Layer::from($deck);

                // The deck a folder implies, but the language's own kind wins
                // for the node type: an interface in `src/` is still an interface.
                $type = match ($deck) {
                    'http' => NodeType::Controller,
                    'data' => NodeType::Service,
                    'view' => NodeType::View,
                    'domain' => NodeType::Model,
                    'infrastructure' => NodeType::Provider,
                    'entry' => NodeType::Executable,
                    default => NodeType::Service,
                };

                $type = match ($kind) {
                    'interface' => NodeType::Interface_,
                    'struct', 'union' => NodeType::Struct,
                    'record' => NodeType::Record,
                    'enum' => NodeType::Enum,
                    default => $type,
                };

                return ['type' => $type, 'layer' => $layer, 'rule' => 'path:'.$segment];
            }
        }

        return null;
    }

    public function isTestFile(string $file): bool
    {
        $lower = strtolower($file);

        foreach (['/tests/', 'tests/', '/test/', 'test/', '.tests/', '/spec/', 'spec/'] as $needle) {
            if (str_starts_with($lower, $needle) || str_contains($lower, $needle)) {
                return true;
            }
        }

        $base = strtolower(basename($file));

        foreach (['tests.cs', 'test.cs', '_test.cpp', '_test.cc', '_test.hpp', 'test.cpp', 'test.cc', 'spec.cpp', 'tests.cpp'] as $suffix) {
            if (str_ends_with($base, $suffix)) {
                return true;
            }
        }

        return false;
    }

    private function hasTestAttribute(array $attributes): bool
    {
        foreach ($attributes as $attribute) {
            if (str_starts_with($attribute, 'test') || in_array($attribute, ['fact', 'theory'], true)) {
                return true;
            }
        }

        return false;
    }
}
