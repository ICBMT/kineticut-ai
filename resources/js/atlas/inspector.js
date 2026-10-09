/**
 * The right-hand inspector: details, connections, source code and insights.
 */

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function createInspector({ root, api, store, scene, onSelect }) {
    const panels = {
        details: root.querySelector('#panel-details'),
        links: root.querySelector('#panel-links'),
        source: root.querySelector('#panel-source'),
        insights: root.querySelector('#panel-insights'),
    };

    const tabs = [...root.querySelectorAll('.tab')];
    let activeTab = 'details';
    let current = null;
    let sourceCache = new Map();

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            activeTab = tab.dataset.tab;
            tabs.forEach((other) => other.classList.toggle('is-active', other === tab));
            Object.entries(panels).forEach(([name, panel]) => {
                panel.hidden = name !== activeTab;
            });

            if (activeTab === 'source' && current) loadSource(current);
            if (activeTab === 'insights') renderInsights();
        });
    });

    function showTab(name) {
        const tab = tabs.find((candidate) => candidate.dataset.tab === name);
        tab?.click();
    }

    /* --------------------------------------------------------- details -- */

    async function show(node) {
        current = node;

        if (!node) {
            panels.details.innerHTML = emptyState('Select a node in the atlas to inspect it.');
            panels.links.innerHTML = emptyState('Connections appear here once a node is selected.');
            panels.source.innerHTML = emptyState('Source appears here once a node is selected.');

            return;
        }

        panels.details.innerHTML = loadingState('Loading node detail…');
        showTab('details');

        let detail = null;

        try {
            detail = await api.node(node.key);
        } catch (error) {
            panels.details.innerHTML = emptyState('Could not load this node: ' + error.message);

            return;
        }

        current = { ...node, detail };

        renderDetails(node, detail);
        renderConnections(node, detail);

        if (activeTab === 'source') loadSource(current);
    }

    function renderDetails(node, detail) {
        const meta = detail.meta ?? {};
        const methods = meta.methods ?? [];
        // `$name` is the PHP spelling of a parameter; C, C# and Python write
        // theirs bare, so the dollar sign only appears where it means something.
        const sigil = ['python', 'cpp', 'csharp'].includes(meta.language) ? '' : '$';
        const columns = meta.columns ?? [];
        const relations = meta.relations ?? [];

        const rows = [
            ['Type', detail.type_label],
            ['Layer', detail.layer_label],
            ['Module', detail.module],
            detail.file ? ['File', detail.file + (detail.line ? ':' + detail.line : '')] : null,
            detail.loc ? ['Size', detail.loc + ' lines'] : null,
            ['Connections', `${detail.fan_in} in · ${detail.fan_out} out`],
            ['FQCN', detail.fqcn],
            meta.namespace ? ['Namespace', meta.namespace] : null,
            meta.extends ? ['Extends', meta.extends] : null,
            meta.table ? ['Table', meta.table] : null,
            meta.column_count !== undefined ? ['Columns', meta.column_count] : null,
            meta.method_count !== undefined ? ['Methods', meta.method_count] : null,
            meta.uri ? ['URI', `${meta.method ?? 'GET'} ${meta.uri}`] : null,
            meta.action_type ? ['Handler', meta.action_type] : null,
            meta.middleware?.length ? ['Middleware', meta.middleware.join(', ')] : null,
            meta.constraint ? ['Constraint', meta.constraint] : null,
            meta.usages ? ['Usages', meta.usages] : null,
        ].filter(Boolean);

        panels.details.innerHTML = `
            <div class="inspector-head">
                <div style="display:flex;align-items:center;gap:8px">
                    <span class="badge badge--layer" style="background:${detail.color}22;color:${detail.color}">${escapeHtml(detail.type_label)}</span>
                    <span class="badge badge--layer">${escapeHtml(detail.layer_label)}</span>
                    ${meta.deprecated ? '<span class="badge badge--status-failed">legacy</span>' : ''}
                </div>
                <div class="inspector-title">${escapeHtml(detail.label)}</div>
                ${detail.fqcn ? `<div class="inspector-sub">${escapeHtml(detail.fqcn)}</div>` : ''}
                ${node.summary ? `<div style="font-size:.85rem;color:var(--text-dim)">${escapeHtml(node.summary)}</div>` : ''}
                ${meta.doc ? `<div class="inset-note" style="margin-top:4px">${escapeHtml(meta.doc)}</div>` : ''}
            </div>

            <div style="display:flex;gap:8px;margin:14px 0">
                ${detail.file ? `<button class="btn btn--sm" data-action="source">Open source</button>` : ''}
                <button class="btn btn--sm btn--ghost" data-action="focus">Focus camera</button>
                <button class="btn btn--sm btn--ghost" data-action="trace">Trace from here</button>
            </div>

            <dl class="kv">${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>

            ${methods.length ? `
                <div class="panel-title" style="margin-top:18px">Methods</div>
                <div style="display:grid;gap:6px">
                    ${methods.map((method) => `
                        <div class="method-row">
                            <span>${escapeHtml(method.name)}(${(method.params ?? []).map((param) => escapeHtml((param.type ? param.type + ' ' : '') + sigil + param.name)).join(', ')})</span>
                            <small>${method.line ? 'L' + method.line : ''} ${method.visibility === 'public' ? '' : method.visibility}</small>
                        </div>
                    `).join('')}
                </div>
            ` : ''}

            ${columns.length ? `
                <div class="panel-title" style="margin-top:18px">Columns</div>
                <table class="table-simple">
                    <thead><tr><th>Name</th><th>Type</th><th>Flags</th></tr></thead>
                    <tbody>
                        ${columns.map((column) => `
                            <tr>
                                <td class="mono">${escapeHtml(column.name)}</td>
                                <td>${escapeHtml(column.type)}</td>
                                <td>${[column.nullable ? 'nullable' : null, column.unique ? 'unique' : null, column.primary ? 'pk' : null].filter(Boolean).join(' · ') || '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : ''}

            ${(meta.foreign_keys ?? []).length ? `
                <div class="panel-title" style="margin-top:18px">Foreign keys</div>
                <div style="display:grid;gap:6px">
                    ${meta.foreign_keys.map((foreign) => `
                        <div class="edge-row" data-goto="table:${escapeHtml(foreign.table)}">
                            <span class="edge-row__dot" style="background:#34d399"></span>
                            ${escapeHtml(foreign.column)} → ${escapeHtml(foreign.table)}.${escapeHtml(foreign.references ?? 'id')}
                            <span class="edge-row__kind">${escapeHtml(foreign.on_delete ?? '')}</span>
                        </div>
                    `).join('')}
                </div>
            ` : ''}

            ${relations.length ? `
                <div class="panel-title" style="margin-top:18px">Relationships</div>
                <div style="display:grid;gap:6px">
                    ${relations.map((relation) => `
                        <div class="edge-row" data-goto="${escapeHtml(relation.target_fqcn ? 'class:' + relation.target_fqcn : '')}">
                            <span class="edge-row__dot" style="background:#fbbf24"></span>
                            ${escapeHtml(relation.method)}() → ${escapeHtml(relation.target ?? '?')}
                            <span class="edge-row__kind">${escapeHtml(relation.type)}</span>
                        </div>
                    `).join('')}
                </div>
            ` : ''}

            ${(meta.fillable ?? []).length ? `
                <div class="panel-title" style="margin-top:18px">Mass assignable</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px">
                    ${meta.fillable.map((field) => `<span class="badge badge--layer mono">${escapeHtml(field)}</span>`).join('')}
                </div>
            ` : ''}
        `;

        panels.details.querySelectorAll('[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
                if (button.dataset.action === 'source') showTab('source');
                if (button.dataset.action === 'focus') scene.flyTo(node.key);
                if (button.dataset.action === 'trace') {
                    document.dispatchEvent(new CustomEvent('atlas:trace', { detail: { key: node.key } }));
                }
            });
        });
    }

    function renderConnections(node, detail) {
        const render = (list, direction) => {
            if (!list.length) return '<p class="inset-note">None recorded.</p>';

            return `<div class="edge-list">${list.map((edge) => `
                <div class="edge-row" data-goto="${escapeHtml(edge.key ?? '')}">
                    <span class="edge-row__dot" style="background:${escapeHtml(edge.color ?? '#7dd3fc')}"></span>
                    <span>${direction === 'in' ? '←' : '→'} ${escapeHtml(edge.label ?? edge.key)}</span>
                    <span class="edge-row__kind">${escapeHtml(edge.edge_label ?? edge.kind_label)}</span>
                </div>
            `).join('')}</div>`;
        };

        panels.links.innerHTML = `
            <div class="panel-title">Incoming (${detail.edges_in.length})</div>
            ${render(detail.edges_in, 'in')}
            <div class="panel-title" style="margin-top:18px">Outgoing (${detail.edges_out.length})</div>
            ${render(detail.edges_out, 'out')}
        `;

        panels.links.querySelectorAll('[data-goto]').forEach((row) => {
            row.addEventListener('click', () => {
                const key = row.dataset.goto;
                if (key && store.node(key)) onSelect(key, { focus: true });
            });
        });
    }

    /* ---------------------------------------------------------- source -- */

    async function loadSource(node) {
        if (!node?.detail?.file) {
            panels.source.innerHTML = emptyState('This node has no file on disk.');

            return;
        }

        const path = node.detail.file;
        const from = node.detail.line ?? 0;
        const to = from ? from + (node.detail.meta?.methods?.[0]?.loc ?? 40) : 0;
        const cacheKey = `${path}:${from}`;

        if (sourceCache.has(cacheKey)) {
            renderSource(sourceCache.get(cacheKey), from, to);
            return;
        }

        panels.source.innerHTML = loadingState('Reading ' + path + '…');

        try {
            const file = await api.file(path, Math.max(0, from - 3), to);
            sourceCache.set(cacheKey, file);
            renderSource(file, from, to);
        } catch (error) {
            panels.source.innerHTML = emptyState('Could not read that file: ' + error.message);
        }
    }

    function renderSource(file, from, to) {
        const lines = String(file.content ?? '').split('\n');
        const html = lines.map((line, index) => {
            const number = index + 1;
            const highlight = from > 0 && number >= from - 2 && number <= to;

            return `<div class="code__line ${highlight ? 'is-highlight' : ''}"><span class="code__ln">${number}</span><span>${escapeHtml(line) || '&nbsp;'}</span></div>`;
        }).join('');

        panels.source.innerHTML = `
            <div class="panel-title">
                <span class="mono" style="text-transform:none;letter-spacing:0">${escapeHtml(file.path)}</span>
                <span>${file.lines} lines</span>
            </div>
            <div class="code">${html}</div>
        `;

        const highlight = panels.source.querySelector('.code__line.is-highlight');
        highlight?.scrollIntoView({ block: 'center' });
    }

    /* -------------------------------------------------------- insights -- */

    function renderInsights() {
        const insights = store.graph.insights ?? [];

        if (!insights.length) {
            panels.insights.innerHTML = emptyState('No architectural findings for this project. Clean work.');

            return;
        }

        const order = { high: 0, medium: 1, low: 2 };

        panels.insights.innerHTML = `
            <div class="panel-title">
                <span>${insights.length} findings</span>
                <span>click to highlight</span>
            </div>
            <div style="display:grid;gap:10px">
                ${[...insights].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)).map((insight) => `
                    <article class="insight insight--${insight.severity}" data-insight="${escapeHtml(insight.id)}">
                        <div class="insight__cat">${escapeHtml(insight.category)} · ${escapeHtml(insight.severity)}</div>
                        <div class="insight__title">${escapeHtml(insight.title)}</div>
                        <div class="insight__body">${escapeHtml(insight.detail)}</div>
                        <div class="insight__action">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                            ${escapeHtml(insight.action)}
                        </div>
                    </article>
                `).join('')}
            </div>
        `;

        panels.insights.querySelectorAll('[data-insight]').forEach((element) => {
            element.addEventListener('click', () => {
                const insight = insights.find((candidate) => candidate.id === element.dataset.insight);

                if (!insight) return;

                panels.insights.querySelectorAll('.insight').forEach((other) => other.classList.remove('is-active'));
                element.classList.add('is-active');

                store.select(insight.nodes ?? [], { primary: (insight.nodes ?? [])[0] ?? null });
                store.insight = insight;
                store.emit('insight', insight);
            });
        });
    }

    const emptyState = (message) => `<div class="empty"><div>${escapeHtml(message)}</div></div>`;
    const loadingState = (message) => `<div class="empty"><div class="loading-dots">${escapeHtml(message)}<span>.</span><span>.</span><span>.</span></div></div>`;

    return {
        show,
        showTab,
        renderInsights,
        clear: () => show(null),
        setStore: (next) => { store = next; },
    };
}
