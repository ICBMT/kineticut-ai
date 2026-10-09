<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages\Cxx\Stages;

use App\Enums\EdgeKind;
use App\Enums\Language;
use App\Enums\NodeType;
use App\Enums\ScanStage;
use App\Services\Scan\Languages\Cxx\Naming;
use App\Services\Scan\Languages\LanguageProfile;
use App\Services\Scan\ScanContext;
use App\Services\Scan\Stage;
use App\Support\GraphBuilder;

/**
 * Stage 5 of the C-family pipeline — who calls whom.
 *
 * A call is resolved as far as the source honestly allows: receiver and method
 * name for `renderer.draw()`, an owner for `Renderer::draw()`, a plain name for
 * `initialize()`. When the callee is a member, the edge points at its *type*,
 * because that is the unit the atlas draws — a call from `TasksController` to
 * `TaskService` is exactly the dependency a reader wants to see.
 *
 * Unresolved calls are counted, never invented: a name that matches nothing is
 * reported in the metrics instead of becoming a dangling edge.
 */
class CallStage implements Stage
{
    /** Minimal-API route registrations, mapped to their HTTP verb. */
    private const ROUTE_METHODS = [
        'mapget' => 'GET',
        'mappost' => 'POST',
        'mapput' => 'PUT',
        'mapdelete' => 'DELETE',
        'mappatch' => 'PATCH',
        'maphead' => 'HEAD',
    ];

    public function __construct(private readonly LanguageProfile $profile) {}

    public function name(): ScanStage
    {
        return ScanStage::Calls;
    }

    public function run(ScanContext $context): array
    {
        $language = $context->language;
        $graph = $context->loadGraph();
        $symbols = $context->readArtifact('symbols');
        $callSites = $context->readArtifact('call_sites');

        $metrics = ['calls' => 0, 'resolved' => 0, 'unresolved' => 0, 'self' => 0, 'routes' => 0, 'constructors' => 0];
        $seen = [];

        // `tasks.All()` only makes sense once we know what `tasks` holds, and
        // the parser recorded the declared type of every member — so the field
        // and property types of each type are indexed here and consulted when a
        // receiver is not itself a type name.
        $memberTypes = $this->memberTypeIndex($graph);

        foreach ($callSites as $call) {
            $metrics['calls']++;

            $source = $this->resolveCaller($call, $symbols);
            $target = $this->resolveCallee($call, $symbols, $source, $memberTypes);

            if (($call['is_new'] ?? false) && $target !== null) {
                $metrics['constructors']++;
            }

            if ($source === null || $target === null) {
                $metrics['unresolved']++;

                continue;
            }

            if ($source === $target) {
                $metrics['self']++;

                continue;
            }

            $hash = $source.'|'.$target.'|'.strtolower((string) $call['name']);

            if (isset($seen[$hash])) {
                continue;
            }

            $seen[$hash] = true;

            $graph->edge($source, $target, EdgeKind::Calls, [
                'label' => (string) $call['name'].'()',
                'meta' => [
                    'call' => $call['name'],
                    'file' => $call['file'] ?? null,
                    'line' => $call['line'] ?? null,
                ],
            ]);

            $metrics['resolved']++;
        }

        if ($language === Language::CSharp) {
            $metrics['routes'] = $this->registerMinimalApiRoutes($graph, $callSites, $symbols);
        }

        $graph->pruneAndScore();
        $context->persistGraph($graph);

        $context->scan->refresh()->update(['metrics' => array_merge($context->scan->metrics ?? [], [
            'calls' => $metrics,
        ])]);

        $context->log(sprintf(
            'Followed %s call sites — %s resolved into edges (%s constructors, %s self-calls, %s unresolved)%s',
            number_format($metrics['calls']),
            number_format($metrics['resolved']),
            number_format($metrics['constructors']),
            number_format($metrics['self']),
            number_format($metrics['unresolved']),
            $metrics['routes'] > 0 ? sprintf(', %d routes', $metrics['routes']) : '',
        ));

        return [
            'summary' => sprintf('%s calls · %s edges · %s unresolved', number_format($metrics['calls']), number_format($metrics['resolved']), number_format($metrics['unresolved'])),
            'metrics' => $metrics,
        ];
    }

    /** The node the call is made from. */
    private function resolveCaller(array $call, array $symbols): ?string
    {
        $context = (string) ($call['context'] ?? '');

        if (str_contains($context, '::')) {
            [$owner] = explode('::', $context, 2);

            $key = $this->findType($owner, $symbols);

            if ($key !== null) {
                return $key;
            }
        }

        if ($context !== '' && $context !== 'global') {
            $key = $this->findType($context, $symbols);

            if ($key !== null) {
                return $key;
            }
        }

        return $call['primary'] ?? null;
    }

    /** @return array<string, array<string, string>> node key → member name → declared type */
    private function memberTypeIndex(GraphBuilder $graph): array
    {
        $index = [];

        foreach ($graph->nodes() as $key => $node) {
            foreach ($node['meta']['members'] ?? [] as $member) {
                $type = trim((string) ($member['type'] ?? ''));

                if ($type !== '') {
                    $index[$key][$member['name']] = $type;
                }
            }
        }

        return $index;
    }

    /** The node the call lands on. */
    private function resolveCallee(array $call, array $symbols, ?string $source, array $memberTypes = []): ?string
    {
        $name = (string) ($call['name'] ?? '');
        $receiver = (string) ($call['receiver'] ?? '');

        if ($name === '' || in_array(strtolower($name), ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch'], true)) {
            return null;
        }

        // A member call: `renderer.draw()`, `this.draw()`, `x->draw()`.
        if ($receiver !== '' && ! in_array(strtolower($receiver), ['this', 'self', 'base'], true)) {
            $owner = $this->findType($receiver, $symbols);

            if ($owner !== null) {
                return $owner;
            }
        }

        if ($receiver !== '') {
            // `this.draw()` / `base.Dispose()`: the owner is the caller itself.
            if (in_array(strtolower($receiver), ['this', 'self', 'base'], true)) {
                return $source;
            }

            // A field, property or parameter: `tasks.All()` where the caller
            // declares `ITaskService tasks`. This is what turns a controller
            // into a node with real arrows into its services.
            if ($source !== null) {
                $declared = $memberTypes[$source][$receiver] ?? null;

                if ($declared !== null) {
                    $owner = $this->findType($declared, $symbols);

                    if ($owner !== null) {
                        return $owner;
                    }
                }
            }
        }

        // A method of the caller itself, called without a receiver.
        if ($source !== null && isset($symbols['methods'])) {
            foreach ($symbols['methods'] as $signature => $key) {
                if ($key === $source && str_ends_with($signature, '::'.$name)) {
                    return $source;
                }
            }
        }

        // A qualified static call: `Renderer::create()`.
        $context = (string) ($call['context'] ?? '');

        if (str_contains($context, '::')) {
            [$owner] = explode('::', $context, 2);

            if (isset($symbols['methods'][$owner.'::'.$name])) {
                return $symbols['methods'][$owner.'::'.$name];
            }
        }

        // A free function, or a constructor written as `TaskService(...)`.
        foreach (($symbols['functions_by_name'][$name] ?? []) as $fqn) {
            return $symbols['functions'][$fqn];
        }

        $type = $this->findType($name, $symbols);

        if ($type !== null) {
            return $type;
        }

        // Any method of that name anywhere in the project — a weak but honest
        // link, and only used when nothing better matched.
        foreach ($symbols['methods'] as $signature => $key) {
            if (str_ends_with($signature, '::'.$name)) {
                return $key;
            }
        }

        return null;
    }

    private function findType(string $reference, array $symbols): ?string
    {
        $reference = Naming::cleanBase($reference);

        if ($reference === '') {
            return null;
        }

        if (isset($symbols['types'][$reference])) {
            return $symbols['types'][$reference];
        }

        if (isset($symbols['types_by_name'][$reference])) {
            return $symbols['types'][$symbols['types_by_name'][$reference][0]] ?? null;
        }

        foreach (array_keys($symbols['types']) as $fqn) {
            if (Naming::refersTo($reference, $fqn)) {
                return $symbols['types'][$fqn];
            }
        }

        return null;
    }

    /**
     * `app.MapGet("/api/health", () => …)` is a route registration. It is read
     * from the call site's string literal, so a minimal API gets the same
     * journey-capable Route nodes a controller-based one does.
     */
    private function registerMinimalApiRoutes(GraphBuilder $graph, array $callSites, array $symbols): int
    {
        $created = 0;

        foreach ($callSites as $call) {
            $verb = self::ROUTE_METHODS[strtolower((string) ($call['name'] ?? ''))] ?? null;
            $uri = $call['literal'] ?? null;

            if ($verb === null || ! is_string($uri) || ! str_starts_with($uri, '/')) {
                continue;
            }

            $uri = '/'.trim(preg_replace('#/+#', '/', $uri) ?: '', '/');

            if ($uri === '/') {
                continue;
            }

            $source = $this->resolveCaller($call, $symbols);

            if ($source === null) {
                continue;
            }

            $key = 'route:'.$verb.' '.$uri;

            $graph->node($key, NodeType::Route, trim($verb.' '.$uri), [
                'file' => $call['file'] ?? null,
                'line' => $call['line'] ?? null,
                'module' => str_starts_with($uri, '/api') ? 'API' : 'Web',
                'weight' => 88,
                'meta' => [
                    'uri' => $uri,
                    'method' => $verb,
                    'name' => null,
                    'action_type' => 'handler',
                    'controller' => null,
                    'action' => null,
                    'middleware' => [],
                    'is_api' => str_starts_with($uri, '/api'),
                    'framework' => 'aspnet-minimal',
                ],
            ]);

            $graph->edge($key, $source, EdgeKind::Http, ['label' => 'endpoint']);
            $created++;
        }

        return $created;
    }
}
