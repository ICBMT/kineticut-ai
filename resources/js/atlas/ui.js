/**
 * The surrounding interface: filter rail, legend, tooltips, minimap, search
 * and the little quality-of-life keyboard shortcuts.
 */

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

import { discoverTrails, trailPlaceholder } from './trace.js';

export function createUi({ root, store, scene, inspector, onSelect, onTrace, onPreset, onAsk }) {
    const rail = {
        layers: root.querySelector('#layer-list'),
        types: root.querySelector('#type-list'),
        modules: root.querySelector('#module-list'),
        edges: root.querySelector('#edge-list'),
        metrics: root.querySelector('#metric-grid'),
        legend: root.querySelector('#legend'),
        presets: root.querySelector('#presets'),
        presetNote: root.querySelector('#preset-note'),
        summary: root.querySelector('#graph-summary'),
        statRelationships: root.querySelector('#stat-relationships'),
        statLayers: root.querySelector('#stat-layers'),
        statModules: root.querySelector('#stat-modules'),
        tooltip: root.querySelector('#tooltip'),
        minimap: root.querySelector('#minimap'),
        fps: root.querySelector('#fps-pill'),
        traceSelect: root.querySelector('#trace-select'),
        layerTotal: root.querySelector('#layer-total'),
        search: root.querySelector('#search'),
        searchClear: root.querySelector('#search-clear'),
    };

    const presetSets = {
        runtime: {
            layers: ['entry', 'http', 'application', 'domain', 'data', 'view'],
            edgeKinds: [],
            note: 'Runtime view hides scaffolding, tests and packages so the request journey stays legible.',
        },
        architecture: {
            layers: ['entry', 'http', 'application', 'domain', 'infrastructure', 'view'],
            edgeKinds: [],
            note: 'Code view adds providers and configuration, and hides the database tier.',
        },
        data: {
            layers: ['domain', 'data', 'application'],
            edgeKinds: ['belongs_to', 'owns', 'pivot', 'persists', 'migrates', 'relates_to', 'injects', 'uses'],
            note: 'Data view keeps models, relationships and schema — your ERD in 3D.',
        },
        all: { layers: [], edgeKinds: [], note: 'Everything the scanner found, including tests, directories and packages.' },
    };

    /* ------------------------------------------------------------- lists -- */

    function renderLegend() {
        rail.legend.innerHTML = store.graph.layers.map((layer) => `
            <span class="legend__item">
                <span class="legend__swatch" style="background:${layer.color}"></span>${escapeHtml(layer.label)}
            </span>
        `).join('');
    }

    function renderLayers() {
        const counts = store.counts().layers;

        rail.layers.innerHTML = store.graph.layers.map((layer) => {
            const active = store.filters.layers.has(layer.value);

            return `
                <div class="rail-item ${active ? 'is-active' : ''}" data-layer="${layer.value}" title="${escapeHtml(layer.description)}">
                    <span class="legend__swatch" style="background:${layer.color}"></span>
                    <span class="rail-item__label">${escapeHtml(layer.label)}</span>
                    <span class="rail-item__count">${counts[layer.value] ?? layer.count}</span>
                </div>
            `;
        }).join('');

        rail.layerTotal.textContent = `${store.graph.layers.length} decks`;
    }

    function renderTypes() {
        rail.types.innerHTML = store.graph.types.map((type) => {
            const active = store.filters.types.has(type.value);

            return `
                <div class="rail-item ${active ? 'is-active' : ''}" data-type="${type.value}">
                    <span class="badge badge--layer mono" style="background:${type.color}1f;color:${type.color}">${escapeHtml(type.glyph)}</span>
                    <span class="rail-item__label">${escapeHtml(type.label)}</span>
                    <span class="rail-item__count">${type.count}</span>
                </div>
            `;
        }).join('');
    }

    function renderModules() {
        const counts = store.counts().modules;
        const modules = Object.entries(counts).sort((a, b) => b[1] - a[1]);

        rail.modules.innerHTML = modules.map(([module, count]) => {
            const active = store.filters.modules.has(module);

            return `
                <div class="rail-item ${active ? 'is-active' : ''}" data-module="${escapeHtml(module)}">
                    <span class="rail-item__label">${escapeHtml(module)}</span>
                    <span class="rail-item__count">${count}</span>
                </div>
            `;
        }).join('');
    }

    function renderEdgeKinds() {
        rail.edges.innerHTML = store.graph.edge_kinds.map((kind) => {
            const active = store.filters.edgeKinds.has(kind.value);

            return `
                <div class="rail-item ${active ? 'is-active' : ''}" data-edge-kind="${kind.value}">
                    <span class="legend__swatch" style="background:${kind.color}"></span>
                    <span class="rail-item__label">${escapeHtml(kind.label)}</span>
                    <span class="rail-item__count">${kind.count}</span>
                </div>
            `;
        }).join('');
    }

    function renderMetrics() {
        const metrics = store.graph.metrics ?? {};
        const totals = store.countVisible();

        /*
         * A compiled codebase has no route table. Reporting "Routes 0" there is
         * technically true and practically useless, so the slot reports what
         * the project does have — the entry points a journey can start from.
         */
        const routes = store.nodes.filter((node) => node.type === 'route').length;
        const entryPoints = store.nodes.filter((node) => node.type === 'executable'
            || (node.type === 'function' && node.layer === 'entry')).length;

        const tiles = [
            ['Files', metrics.files ?? store.graph.project.file_count],
            // Laravel and ASP.NET report classes; native code reports types.
            ['Classes', metrics.classes ?? metrics.types],
            routes === 0 && metrics.routes === 0 && entryPoints > 0
                ? ['Entry points', entryPoints]
                : ['Routes', routes || metrics.routes],
            ['Models', metrics.models],
            ['Tables', metrics.tables],
            ['Migrations', metrics.migrations],
            ['Views', metrics.views],
            ['Tests', metrics.class_types?.test],
            ['Shown nodes', totals.nodes],
            ['Shown edges', totals.edges],
        ].filter(([, value]) => value !== undefined && value !== null);

        rail.metrics.innerHTML = tiles.map(([label, value]) => `
            <div class="metric">
                <div class="metric__value">${Number(value).toLocaleString()}</div>
                <div class="metric__label">${escapeHtml(label)}</div>
            </div>
        `).join('') + `
            <div class="metric">
                <div class="metric__value">${(metrics.insights?.total ?? 0)}</div>
                <div class="metric__label">Insights</div>
            </div>
            <div class="metric">
                <div class="metric__value">${(metrics.loc ?? store.graph.project.loc ?? 0).toLocaleString()}</div>
                <div class="metric__label">Lines of code</div>
            </div>
        `;

        /*
         * Guide numbers for the toolbar. These are project totals — the whole
         * graph, not the filtered view — because that is the question the
         * numbers answer: how big is this codebase and how is it organised.
         * What is *shown* after a filter is already reported by the rail's
         * "Shown nodes / Shown edges" tiles.
         */
        const set = (element, value) => {
            if (!element) return;

            element.textContent = Number(value ?? 0).toLocaleString();
        };

        set(rail.statRelationships, store.graph.edges.length);
        set(rail.statLayers, store.graph.layers.length);
        set(rail.statModules, store.graph.clusters.length);
    }

    function renderTraceOptions() {
        const select = rail.traceSelect;

        if (!select) return;

        /*
         * Laravel, Django, Flask and ASP.NET fill this from their route table.
         * A project with no route table — a compiled program, a console tool, a
         * Python script — gets its entry points instead, so the control is never
         * an empty list where "where does this start" has an answer.
         */
        const language = store.graph?.project?.stack?.language ?? select.dataset.language ?? 'php';
        const trails = discoverTrails(store, language);
        const entryPoints = trails.length > 0 && trails[0].kind !== 'route';

        select.innerHTML = `<option value="">${escapeHtml(trailPlaceholder(language, entryPoints))}</option>` + trails.map((trail) => `
            <option value="${escapeHtml(trail.key)}">${escapeHtml(trail.label)}${escapeHtml(trail.hint ? ` · ${trail.hint}` : '')}</option>
        `).join('');

        // Nothing to trace is a state the panel should admit to, not one it
        // should show a dead dropdown for.
        select.hidden = trails.length === 0;

        const note = select.closest('.rail-section')?.querySelector('.inset-note');

        if (note && trails.length === 0 && select.dataset.emptyNote) {
            note.textContent = select.dataset.emptyNote;
        }
    }

    /* ------------------------------------------------------------ events -- */

    rail.layers.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layer]');
        if (!item) return;

        const value = item.dataset.layer;
        store.filters.layers.has(value) ? store.filters.layers.delete(value) : store.filters.layers.add(value);
        renderLayers();
        store.setFilter({});
    });

    rail.types.addEventListener('click', (event) => {
        const item = event.target.closest('[data-type]');
        if (!item) return;

        const value = item.dataset.type;
        store.filters.types.has(value) ? store.filters.types.delete(value) : store.filters.types.add(value);
        renderTypes();
        store.setFilter({});
    });

    rail.modules.addEventListener('click', (event) => {
        const item = event.target.closest('[data-module]');
        if (!item) return;

        const value = item.dataset.module;
        store.filters.modules.has(value) ? store.filters.modules.delete(value) : store.filters.modules.add(value);
        renderModules();
        store.setFilter({});
    });

    rail.edges.addEventListener('click', (event) => {
        const item = event.target.closest('[data-edge-kind]');
        if (!item) return;

        const value = item.dataset.edgeKind;
        store.filters.edgeKinds.has(value) ? store.filters.edgeKinds.delete(value) : store.filters.edgeKinds.add(value);
        renderEdgeKinds();
        store.setFilter({});
    });

    rail.presets.addEventListener('click', (event) => {
        const button = event.target.closest('[data-preset]');
        if (!button) return;

        applyPreset(button.dataset.preset);
    });

    function applyPreset(name) {
        const preset = presetSets[name] ?? presetSets.runtime;

        store.filters.layers = new Set(preset.layers);
        store.filters.types = new Set();
        store.filters.modules = new Set();
        store.filters.edgeKinds = new Set(preset.edgeKinds);

        rail.presets.querySelectorAll('.chip').forEach((chip) => {
            chip.classList.toggle('is-active', chip.dataset.preset === name);
        });

        rail.presetNote.textContent = preset.note;
        store.preset = name;

        renderLayers();
        renderTypes();
        renderModules();
        renderEdgeKinds();
        store.setFilter({});

        // Reframe after the new set has been decided, so a preset switch always
        // hands the user a full, readable view rather than the old camera.
        requestAnimationFrame(() => onPreset?.());
    }

    /* ------------------------------------------------------------ search -- */

    let searchTimer = null;

    function applySearch() {
        store.filters.query = rail.search.value.trim().toLowerCase();
        store.setFilter({});
        renderMetrics();
    }

    // The button's visibility belongs to the field (see `.search__clear`), so
    // there is nothing to keep in sync here — including when a `?q=` deep link
    // writes `value` directly and no `input` event is ever fired.
    function clearSearch({ focus = true } = {}) {
        if (rail.search.value === '') return;

        clearTimeout(searchTimer);
        rail.search.value = '';
        applySearch();

        if (focus) rail.search.focus();
    }

    rail.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applySearch, 140);
    });

    rail.searchClear?.addEventListener('click', () => clearSearch());

    rail.search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            // Escape belongs to the field while it is focused: clear the query,
            // do not touch the selection.
            event.stopPropagation();
            clearSearch();

            return;
        }

        if (event.key !== 'Enter') return;

        const first = store.visibleNodes().sort((a, b) => b.weight - a.weight)[0];

        if (first) onSelect(first.key, { focus: true });
    });

    /* ---------------------------------------------------------- shortcuts -- */

    document.addEventListener('keydown', (event) => {
        if (event.target.matches('input, select, textarea')) return;

        switch (event.key) {
            case 'f':
                scene.fitAll();
                break;
            case 'l':
                scene.setLabels(!scene.labelsEnabled);
                break;
            case 'd': {
                const enabled = scene.setFocusEnabled(!scene.focusEnabled);
                root.querySelector('#toggle-focus')?.setAttribute('aria-pressed', String(enabled));
                break;
            }
            case 'r':
                scene.setAutoRotate(!scene.autoRotate);
                root.querySelector('#toggle-rotate')?.setAttribute('aria-pressed', String(scene.autoRotate));
                break;
            // Swap the right column between reading the graph and asking about it.
            case 'a':
                onAsk?.();
                root.querySelector('#toggle-ai')?.setAttribute('aria-pressed', String(Boolean(root.classList.contains('is-ai'))));
                break;
            case 'Escape':
                store.clearSelection();
                onTrace?.(null);
                break;
            case '/':
                event.preventDefault();
                rail.search.focus();
                break;
            default:
                break;
        }
    });

    /* ----------------------------------------------------------- tooltip -- */

    function showTooltip(node, position) {
        if (!node) {
            rail.tooltip.classList.remove('is-visible');

            return;
        }

        const stage = root.querySelector('#stage');
        const rect = stage.getBoundingClientRect();

        rail.tooltip.innerHTML = `
            <div class="tooltip__title">${escapeHtml(node.label)}</div>
            <div class="tooltip__meta">${escapeHtml(node.type_label)}${node.summary ? ' · ' + escapeHtml(node.summary) : ''}</div>
            ${node.file ? `<div class="tooltip__meta">${escapeHtml(node.file)}${node.line ? ':' + node.line : ''}</div>` : ''}
            <div class="tooltip__meta" style="margin-top:4px">${node.fan_in} in · ${node.fan_out} out · weight ${node.weight}</div>
        `;

        rail.tooltip.style.left = `${position.x}px`;
        rail.tooltip.style.top = `${position.y}px`;
        rail.tooltip.classList.add('is-visible');
    }

    /* ----------------------------------------------------------- minimap -- */

    const minimapContext = rail.minimap.getContext('2d');
    let minimapBounds = null;

    function computeBounds() {
        const points = scene.footprint();
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;

        points.forEach((point) => {
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minZ = Math.min(minZ, point.z);
            maxZ = Math.max(maxZ, point.z);
        });

        const padding = 40;
        const width = Math.max(1, maxX - minX) + padding * 2;
        const height = Math.max(1, maxZ - minZ) + padding * 2;

        minimapBounds = { minX: minX - padding, minZ: minZ - padding, width, height };
    }

    function drawMinimap() {
        requestAnimationFrame(drawMinimap);

        if (!minimapBounds) computeBounds();

        const { width: canvasWidth, height: canvasHeight } = rail.minimap;
        const { minX, minZ, width, height } = minimapBounds;
        const scale = Math.min(canvasWidth / width, canvasHeight / height);

        minimapContext.clearRect(0, 0, canvasWidth, canvasHeight);

        const toScreen = (x, z) => [
            (x - minX) * scale + (canvasWidth - width * scale) / 2,
            (z - minZ) * scale + (canvasHeight - height * scale) / 2,
        ];

        scene.footprint().forEach((point) => {
            if (!point.visible) return;

            const [x, y] = toScreen(point.x, point.z);
            const radius = 1.1 + Math.min(2.6, point.weight / 42);

            minimapContext.beginPath();
            minimapContext.arc(x, y, radius, 0, Math.PI * 2);
            minimapContext.fillStyle = point.color ?? '#7dd3fc';
            minimapContext.globalAlpha = 0.88;
            minimapContext.fill();
        });

        // camera marker
        const camera = scene.camera.position;
        const [cx, cy] = toScreen(camera.x, camera.z);

        minimapContext.globalAlpha = 1;
        minimapContext.beginPath();
        minimapContext.arc(cx, cy, 6, 0, Math.PI * 2);
        minimapContext.strokeStyle = '#ffffff';
        minimapContext.lineWidth = 1.4;
        minimapContext.stroke();

        const target = scene.controls.target;
        const [tx, ty] = toScreen(target.x, target.z);
        const angle = Math.atan2(ty - cy, tx - cx);

        minimapContext.beginPath();
        minimapContext.moveTo(cx, cy);
        minimapContext.lineTo(cx + Math.cos(angle) * 22, cy + Math.sin(angle) * 22);
        minimapContext.strokeStyle = 'rgba(255,255,255,.5)';
        minimapContext.stroke();
    }

    rail.minimap.addEventListener('click', (event) => {
        if (!minimapBounds) return;

        const rect = rail.minimap.getBoundingClientRect();
        const { minX, minZ, width, height } = minimapBounds;
        const canvasWidth = rail.minimap.width;
        const canvasHeight = rail.minimap.height;
        const scale = Math.min(canvasWidth / width, canvasHeight / height);

        const x = ((event.clientX - rect.left) / rect.width) * canvasWidth;
        const y = ((event.clientY - rect.top) / rect.height) * canvasHeight;

        const worldX = (x - (canvasWidth - width * scale) / 2) / scale + minX;
        const worldZ = (y - (canvasHeight - height * scale) / 2) / scale + minZ;

        scene.panTo?.(worldX, worldZ);
    });

    /* ------------------------------------------------------------ toasts -- */

    const stack = document.createElement('div');
    stack.className = 'toast-stack';
    root.querySelector('#stage')?.appendChild(stack);

    function toast(message, { tone = 'info', duration = 4200 } = {}) {
        const element = document.createElement('div');
        element.className = `toast${tone === 'warn' ? ' toast--warn' : ''}`;
        element.textContent = message;
        stack.appendChild(element);

        setTimeout(() => element.remove(), duration);
    }

    /* ------------------------------------------------------- tech stack -- */

    /**
     * The strip is rendered by the server so it is right on first paint; the
     * graph payload carries the same object, which keeps it correct for a page
     * that boots from the API and for a scan that has finished since.
     */
    function applyStack() {
        const stack = store.graph?.project?.stack;
        const element = document.querySelector('#stack');

        if (!element || !stack) return;

        element.style.setProperty('--stack-tint', stack.color ?? 'var(--accent)');

        const title = element.querySelector('.stack__title');
        const badge = element.querySelector('.stack__badge');

        if (title && stack.headline) title.textContent = stack.headline;
        if (badge && stack.language_short) badge.textContent = stack.language_short;
    }

    /* -------------------------------------------------------------- init -- */

    applyStack();
    renderLegend();
    renderLayers();
    renderTypes();
    renderModules();
    renderEdgeKinds();
    renderMetrics();
    renderTraceOptions();
    computeBounds();
    drawMinimap();

    store.on('visibility', () => {
        renderMetrics();
        minimapBounds = null;
    });

    return {
        applyPreset,
        toast,
        showTooltip,
        setFps: (fps) => { rail.fps.textContent = `${fps} fps`; },
        refreshMetrics: renderMetrics,
        focusSearch: () => rail.search.focus(),
        clearSearch,
    };
}
