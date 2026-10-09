/**
 * The request tracer.
 *
 * Given a starting node (usually a route) it walks the most meaningful
 * outgoing relationship at each step and returns a single readable chain:
 *
 *   POST /tasks → auth middleware → StoreTaskRequest → TaskController@store
 *               → CreateTaskAction → TaskService → Task → tasks table
 */

const FLOW_KINDS = new Set([
    'http', 'guards', 'validates', 'authorizes', 'injects', 'uses', 'invokes',
    'dispatches', 'queue', 'persists', 'pivot', 'owns', 'relates_to',
    'belongs_to', 'renders', 'includes', 'listens', 'notifies', 'schedules',
    /*
     * Compiled code has no transport between its steps: `main()` calls a
     * function, that function calls another. Without these two hops a C++ or
     * C# journey stopped dead at its first node, which is why tracing a
     * compiled project looked broken rather than merely different.
     */
    'calls', 'imports',
]);

// Lower index = followed first. The order mirrors how a request actually
// travels: transport, guards, then the objects the handler reaches for, and
// finally the storage layer. Presentation sits near the end because rendering
// is where a request finishes rather than where it continues.
const KIND_PRIORITY = [
    'http', 'guards', 'validates', 'authorizes', 'injects', 'uses', 'invokes',
    'dispatches', 'queue', 'persists', 'pivot', 'owns', 'relates_to',
    'belongs_to', 'calls', 'imports', 'renders', 'includes', 'listens',
    'notifies', 'schedules',
];

const PRESENTATION_TYPES = new Set(['view', 'component', 'livewire']);

/**
 * Node kinds that end a request rather than continue it. A journey that reaches
 * the table it writes to, or the view it renders, has arrived — walking on from
 * there just wanders the model graph.
 */
const TERMINAL_TYPES = new Set(['table', 'view']);

/**
 * Where execution starts in a compiled project.
 *
 * A C++ or C# codebase has no route table, but it does have entry points, and
 * "what runs when this program starts" is the same question a Laravel user
 * answers with `GET /dashboard`. Executables come first because they are the
 * artefact; `main` functions are what the loader actually calls.
 */
const ENTRY_FUNCTION_NAMES = new Set([
    'main', 'wmain', 'tmain', 'winmain', 'wwinmain', 'dllmain',
    'maincrtstartup', 'program', 'startup',
]);

/**
 * The journeys the tracer offers for the loaded graph.
 *
 * Laravel, Django, Flask and ASP.NET answer with their route table. A project
 * that has no routes — a compiled program, a console tool, a Python script —
 * answers with its entry points, which is the only honest equivalent, and never
 * an empty list as long as the scan found something that runs.
 *
 * @returns {Array<{key:string,label:string,kind:string,hint:?string}>}
 */
export function discoverTrails(store, language = 'php') {
    const routes = store.nodes
        .filter((node) => node.type === 'route')
        .sort((a, b) => (a.summary ?? a.label).localeCompare(b.summary ?? b.label))
        .map((route) => ({ key: route.key, label: route.summary || route.label, kind: 'route', hint: null }));

    if (routes.length > 0) {
        return routes;
    }

    const entries = store.nodes.filter((node) => {
        if (node.type === 'executable') return true;

        // `main` is classified onto the entry layer by the scan, but a project
        // can spell it differently — fall back to the name.
        if (node.type === 'function' && node.layer === 'entry') return true;

        const name = (node.label ?? '').toLowerCase().replace(/^.*::/, '');

        return node.type === 'function' && ENTRY_FUNCTION_NAMES.has(name);
    });

    const functions = entries.filter((node) => node.type !== 'executable');
    const executables = entries.filter((node) => node.type === 'executable');

    const byLabel = (a, b) => String(a.label ?? a.key).localeCompare(String(b.label ?? b.key));

    return [
        ...functions.sort(byLabel).map((node) => ({
            key: node.key,
            label: `${node.label}()`,
            kind: 'function',
            hint: 'entry point',
        })),
        ...executables.sort(byLabel).map((node) => ({
            key: node.key,
            label: node.label,
            kind: 'executable',
            hint: language === 'cpp' ? 'target' : 'entry point',
        })),
    ];
}

/**
 * What the tracer calls each starting point, for the option list.
 *
 * `hasEntries` is passed in because the answer is a property of the loaded
 * graph, not of the language: a Python web app is traced from its routes, a
 * Python script from its entry point.
 */
export function trailPlaceholder(language = 'php', hasEntries = false) {
    if (hasEntries) {
        return 'Choose an entry point…';
    }

    return language === 'cpp' ? 'Choose an entry point…' : 'Choose a route…';
}

export function computeJourney(store, startKey, options = {}) {
    /*
     * The cap used to be 7, which silently cut 23 of TaskFlow's 27 journeys off
     * at exactly 8 nodes — the bar was showing a truncated chain, not the end of
     * one. 16 is a runaway guard now, not a description of how deep a request
     * goes; the walk stops on its own when it reaches a terminal or a dead end.
     */
    const maxDepth = options.maxDepth ?? 16;
    const path = [startKey];
    const steps = [];
    const visited = new Set([startKey]);

    let current = startKey;
    let kind = 'start';

    for (let depth = 0; depth < maxDepth; depth++) {
        const candidates = store
            .neighbours(current)
            .filter(({ edge, direction }) => {
                if (direction !== 'out') return false;
                if (!FLOW_KINDS.has(edge.kind)) return false;

                const other = edge.source === current ? edge.target : edge.source;
                if (visited.has(other)) return false;

                const node = store.node(other);

                return node && store.visible[node.index] === 1;
            })
            .map(({ edge }) => {
                const other = edge.source === current ? edge.target : edge.source;
                const node = store.node(other);
                const priority = KIND_PRIORITY.indexOf(edge.kind);

                // A journey should keep moving: dead ends and side-stages such
                // as middleware or policies are only taken when nothing more
                // interesting continues the chain.
                const continuations = store
                    .neighbours(other)
                    .filter(({ edge: next, direction }) => direction === 'out'
                        && next.source === other
                        && FLOW_KINDS.has(next.kind)
                        && !visited.has(next.target))
                    .length;

                let penalty = 0;

                /*
                 * "Keep moving" must not apply to a destination that is an end
                 * in itself: a table never has a next step by definition, so
                 * penalising it for being a dead end made the walk prefer a
                 * relation to another *model* over the table the request writes
                 * to. That is how journeys ended up wandering the model graph.
                 */
                if (continuations === 0 && !TERMINAL_TYPES.has(node?.type)) penalty += 40;
                // A request does not hop into a different endpoint: without this
                // a visit to one controller happily continued into another route.
                if (node?.type === 'route') penalty += 45;
                if (node?.type === 'middleware') penalty += 26;
                if (node?.type === 'policy') penalty += 18;
                if (node?.type === 'test') penalty += 60;

                /*
                 * `uses` is a structural "mentions this class" edge, and between
                 * two models it is noise: it made a journey leave the model it had
                 * just reached for a neighbouring model instead of walking on to
                 * the table. From a service or controller `uses` is exactly the
                 * right hop, so the penalty is only for model → model.
                 */
                const fromModel = store.node(current)?.type === 'model';

                if (edge.kind === 'uses' && fromModel && node?.type === 'model') penalty += 70;

                // Rendering is a valid end of the line, but while a handler
                // still has services, actions or models to visit the journey
                // should follow those first.
                if (PRESENTATION_TYPES.has(node?.type) && (edge.kind === 'renders' || edge.kind === 'includes')) {
                    penalty += 22;
                }

                return {
                    edge,
                    key: other,
                    score: (priority === -1 ? 99 : priority) * 10 - Math.min(9, edge.hits) - edge.weight * 0.4 + penalty,
                };
            })
            .sort((a, b) => a.score - b.score);

        if (candidates.length === 0) break;

        const chosen = candidates[0];
        const node = store.node(chosen.key);

        if (!node) break;

        steps.push({
            from: current,
            to: chosen.key,
            kind: chosen.edge.kind,
            kindLabel: chosen.edge.kind_label ?? chosen.edge.kind,
            // The edge itself, not just its label: the renderer lights the
            // journey by edge index, so a step without one leaves the whole
            // chain unlit.
            edge: chosen.edge,
            node,
        });

        path.push(chosen.key);
        visited.add(chosen.key);
        current = chosen.key;
        kind = chosen.edge.kind;

        // Stop where the request stops.
        if (TERMINAL_TYPES.has(node.type)) {
            break;
        }
    }

    return { start: startKey, path, steps };
}

export function stepLabel(node) {
    if (!node) return '—';

    if (node.type === 'route') {
        return node.summary || node.label;
    }

    return node.label;
}
