/**
 * Client-side state: the graph, the active filters, the selection and the
 * request trace. Views subscribe to change events instead of polling.
 */
export class Store {
    constructor(graph) {
        this.graph = graph;
        this.nodes = graph.nodes;
        this.edges = graph.edges;

        this.indexByKey = new Map();
        this.nodes.forEach((node, index) => {
            node.index = index;
            this.indexByKey.set(node.key, node);
        });

        this.visible = new Uint8Array(this.nodes.length).fill(1);
        this.visibleEdges = new Uint8Array(this.edges.length).fill(1);

        this.filters = {
            layers: new Set(),
            types: new Set(),
            modules: new Set(),
            edgeKinds: new Set(),
            query: '',
            minWeight: 0,
        };

        this.selection = new Set();
        this.primary = null;
        this.trace = null;
        this.insight = null;
        this.layoutMode = 'layers';
        this.listeners = new Map();

        this.adjacency = new Map();
        this.edges.forEach((edge, index) => {
            edge.index = index;
            if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, []);
            this.adjacency.get(edge.source).push({ edge, index, direction: 'out' });
            if (!this.adjacency.has(edge.target)) this.adjacency.set(edge.target, []);
            this.adjacency.get(edge.target).push({ edge, index, direction: 'in' });
        });

        this.recomputeVisibility();
    }

    /* ------------------------------------------------------------ events -- */

    on(event, handler) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(handler);

        return () => this.listeners.get(event)?.delete(handler);
    }

    emit(event, payload) {
        this.listeners.get(event)?.forEach((handler) => handler(payload, this));
    }

    /* ----------------------------------------------------------- filters -- */

    matchesFilters(node) {
        const { layers, types, modules, query, minWeight } = this.filters;

        if (layers.size > 0 && !layers.has(node.layer)) return false;
        if (types.size > 0 && !types.has(node.type)) return false;
        if (modules.size > 0 && !modules.has(node.module)) return false;
        if (node.weight < minWeight) return false;

        if (query) {
            const haystack = `${node.label} ${node.fqcn ?? ''} ${node.file ?? ''} ${node.module ?? ''} ${node.key}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }

        return true;
    }

    /** Recompute which nodes/edges are drawn. Returns true when something changed. */
    recomputeVisibility() {
        let nodeChanges = 0;

        this.nodes.forEach((node) => {
            const visible = this.matchesFilters(node) ? 1 : 0;
            if (this.visible[node.index] !== visible) nodeChanges++;
            this.visible[node.index] = visible;
        });

        const kinds = this.filters.edgeKinds;

        this.edges.forEach((edge) => {
            const source = this.nodes[this.indexByKey.get(edge.source)?.index ?? -1];
            const target = this.nodes[this.indexByKey.get(edge.target)?.index ?? -1];

            const visible =
                source && target && this.visible[source.index] && this.visible[target.index] &&
                (kinds.size === 0 || kinds.has(edge.kind)) && !edge.hidden
                    ? 1
                    : 0;

            this.visibleEdges[edge.index] = visible;
        });

        return nodeChanges > 0;
    }

    visibleNodes() {
        return this.nodes.filter((node) => this.visible[node.index]);
    }

    countVisible() {
        let nodes = 0;
        let edges = 0;

        this.visible.forEach((value) => { nodes += value; });
        this.visibleEdges.forEach((value) => { edges += value; });

        return { nodes, edges };
    }

    /* --------------------------------------------------------- selection -- */

    select(keys, { primary = null, silent = false } = {}) {
        this.selection = new Set([].concat(keys ?? []));
        this.primary = primary ?? ([...this.selection][0] ?? null);

        if (!silent) this.emit('selection', this.selectionPayload());
        this.emit('highlight', { keys: this.selection, primary: this.primary });
    }

    toggleSelection(key) {
        if (this.selection.has(key)) {
            this.selection.delete(key);
            if (this.primary === key) this.primary = [...this.selection][0] ?? null;
        } else {
            this.selection.add(key);
            this.primary = key;
        }

        this.emit('selection', this.selectionPayload());
        this.emit('highlight', { keys: this.selection, primary: this.primary });
    }

    clearSelection() {
        this.select([], { primary: null });
    }

    selectionPayload() {
        return {
            keys: [...this.selection],
            primary: this.primary,
            node: this.primary ? this.indexByKey.get(this.primary) ?? null : null,
        };
    }

    /* -------------------------------------------------------------- misc -- */

    node(key) {
        return this.indexByKey.get(key) ?? null;
    }

    neighbours(key) {
        return this.adjacency.get(key) ?? [];
    }

    setFilter(patch, eventName = 'filters') {
        Object.assign(this.filters, patch);
        this.recomputeVisibility();
        this.emit(eventName, this.filters);
        this.emit('visibility');
    }

    counts() {
        const by = (list, key) => list.reduce((accumulator, item) => {
            const value = item[key];
            accumulator[value] = (accumulator[value] ?? 0) + 1;

            return accumulator;
        }, {});

        return {
            layers: by(this.nodes, 'layer'),
            types: by(this.nodes, 'type'),
            modules: by(this.nodes.filter((node) => node.module), 'module'),
        };
    }
}
