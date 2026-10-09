import { createApi } from './api.js';
import { Store } from './store.js';
import { AtlasScene } from './scene.js';
import { computeLayout } from './layouts.js';
import { createInspector } from './inspector.js';
import { createUi } from './ui.js';
import { createScanWatcher } from './scan.js';
import { computeJourney, stepLabel } from './trace.js';
import { createAi } from './ai.js';

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export async function boot(root) {
    const api = createApi(root);

    let store = null;
    let scene = null;
    let ui = null;
    let inspector = null;
    let trace = null;
    let ai = null;

    /* --------------------------------------------------------- scanning -- */

    const watcher = createScanWatcher({
        root,
        api,
        hasGraph: Boolean(root.dataset.hasGraph),
        onReady: async () => {
            await loadGraph({ animateIn: true });
        },
    });

    const initialStatus = root.dataset.scanStatus;

    if (initialStatus === 'queued' || initialStatus === 'running') {
        watcher.start();
    }

    /* ------------------------------------------------------------ graph -- */

    async function loadGraph({ animateIn = false } = {}) {
        let payload;

        try {
            payload = await api.graph();
        } catch (error) {
            console.error('[atlas] graph request failed', error);

            return;
        }

        if (!payload.ready) {
            if (!scene) watcher.start();

            return;
        }

        store = new Store(payload);

        if (!scene) {
            buildScene(animateIn);
        } else {
            scene.setGraph(payload);
            scene.setVisibility(store.visible, store.visibleEdges);
            scene.setLayout(computeLayout(store.layoutMode, store.nodes, store.edges, store.visible));
            scene.fitAll(true);
            ui?.refreshMetrics();
        }

        applyUrlState();
    }

    function buildScene(animateIn) {
        scene = new AtlasScene(root.querySelector('#scene'), {
            onPick: (key) => {
                store.select([key], { primary: key });
            },
            onHover: (node, position) => ui?.showTooltip(node, position),
            onBackgroundClick: () => {
                store.clearSelection();
                if (trace?.active) trace.exit();
            },
            onFrame: (fps) => {
                ui?.setFps(fps);
                watchPerformance(fps);
            },
            onLayoutProgress: reportLayoutProgress,
        });

        scene.setGraph(store.graph);
        scene.setVisibility(store.visible, store.visibleEdges);
        scene.setLayout(computeLayout(store.layoutMode, store.nodes, store.edges, store.visible));

        inspector = createInspector({
            root,
            api,
            store,
            scene,
            onSelect: (key, options) => select(key, options),
        });

        ui = createUi({
            root,
            store,
            scene,
            inspector,
            onSelect: (key, options) => select(key, options),
            onTrace: (key) => (key ? trace.run(key) : trace.exit()),
            // A preset is a deliberate "show me this" — reframe for what is left.
            onPreset: () => scene.fitAll(true),
            onAsk: () => ai?.toggle(),
        });

        trace = createTrace(root, store, scene);

        ai = createAi({
            root,
            store,
            scene,
            toast: (message, tone) => ui?.toast(message, tone),
            language: store.graph?.project?.stack?.language ?? 'php',
            // A citation is a pointer into the map: show the node there, and
            // give the inspector back to the reader so they can see its file.
            onShowNode: (key) => {
                select(key, { focus: true });
                ai?.close();
                inspector?.showTab('details');
            },
        });

        wireControls();
        wireStore();

        // Order matters: the view preset decides which nodes exist on screen,
        // and the camera is framed for *those* nodes and nothing else.
        ui.applyPreset(urlParam('view') ?? 'runtime');
        scene.setQuality(root.querySelector('#quality')?.value ?? 'high');

        if (animateIn) {
            scene.fitAll(false, { margin: 0.8 });
            scene.camera.position.sub(scene.controls.target).multiplyScalar(1.5).add(scene.controls.target);
        }

        scene.fitAll(true);

        inspector.renderInsights();
    }

    /**
     * A 183-node atlas with bloom is a lot to ask of an integrated GPU. If the
     * frame rate stays low the renderer steps itself down once, saying so —
     * reading the map should never depend on owning a fast machine.
     */
    let slowSamples = 0;
    let qualitySteppedDown = 0;
    let autoQuality = true;

    function watchPerformance(fps) {
        if (!autoQuality || !scene || qualitySteppedDown >= 2) return;

        if (fps >= 26) {
            slowSamples = Math.max(0, slowSamples - 1);

            return;
        }

        slowSamples++;

        if (slowSamples < 7) return;

        slowSamples = 0;
        qualitySteppedDown++;

        const next = scene.quality === 'high' ? 'balanced' : 'performance';

        scene.setQuality(next);

        const select = root.querySelector('#quality');
        if (select) select.value = next;

        ui?.toast(
            next === 'performance'
                ? 'Frame rate is low — switched to the performance renderer. Pick “High (bloom)” again from the Quality menu any time.'
                : 'Frame rate is low — switched to the balanced renderer.',
            { tone: 'warn', duration: 7000 }
        );
    }

    function select(key, options = {}) {
        if (!key) {
            store.clearSelection();

            return;
        }

        store.select(options.multi ? [...store.selection, key] : [key], { primary: key });

        if (options.focus) {
            scene.flyTo(key);
        }
    }

    /* ----------------------------------------------------------- wiring -- */

    function wireStore() {
        store.on('selection', ({ node, keys }) => {
            inspector?.show(node);
            scene.setHighlight(keys, store.primary);
            writeUrlState();
        });

        store.on('visibility', () => {
            scene.setVisibility(store.visible, store.visibleEdges);
            writeUrlState();
        });

        store.on('insight', (insight) => {
            if (insight?.nodes?.length) {
                scene.frameKeys(insight.nodes, { padding: 1.7 });

                if (trace?.active) trace.exit();
            }
        });
    }

    /* ---------------------------------------------------------- layout bar -- */

    const LAYOUT_LABELS = {
        layers: 'architecture layers',
        modules: 'modules',
        spiral: 'spiral',
    };

    // Only a user-driven switch reports progress; the layout that arrives with
    // the page is not something the user is waiting on.
    let layoutReporting = false;

    function layoutBar() {
        return {
            wrap: root.querySelector('#layout-progress'),
            bar: root.querySelector('#layout-progress-bar'),
            text: root.querySelector('#layout-progress-text'),
        };
    }

    function beginLayoutProgress(mode) {
        const { wrap, bar, text } = layoutBar();

        if (!wrap) return;

        layoutReporting = true;
        wrap.hidden = false;
        // No percentage exists yet — the engine is still working. The sweep
        // says that; a fake number would not.
        wrap.classList.add('layout-progress--busy');
        bar.style.width = '';
        text.textContent = `Building ${LAYOUT_LABELS[mode] ?? mode} layout…`;
    }

    /**
     * Driven by the scene: `progress` is the distance the nodes have actually
     * covered towards this layout, not a timer's guess at it.
     */
    function reportLayoutProgress(progress, moving) {
        if (!layoutReporting) return;

        const { wrap, bar, text } = layoutBar();

        if (!wrap) return;

        const percent = Math.round(progress * 100);

        wrap.classList.remove('layout-progress--busy');
        bar.style.width = `${Math.max(6, percent)}%`;
        text.textContent = moving ? `Settling nodes… ${percent}%` : 'Layout ready';

        if (!moving) {
            window.setTimeout(() => {
                if (!layoutReporting) return;
                layoutReporting = false;
                wrap.hidden = true;
            }, 460);
        }
    }

    /**
     * Switching layout is a rebuild plus a camera move: the engine runs first,
     * then the nodes travel. Both phases are shown, so the bar never reports a
     * duration it invented.
     */
    async function applyLayout(mode) {
        store.layoutMode = mode;
        beginLayoutProgress(mode);

        // Give the browser one paint with the bar on screen before the engines
        // take the main thread — otherwise it appears only after the work.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        scene.setLayout(computeLayout(mode, store.nodes, store.edges, store.visible));

        // Frame where the nodes are going: they are still in the old layout at
        // this point, so framing the current positions would aim the camera at
        // the layout the user just left.
        scene.fitAll(true, { useTarget: true });
        writeUrlState();
    }

    function wireControls() {
        const layoutSelect = root.querySelector('#layout-mode');
        const qualitySelect = root.querySelector('#quality');
        const rotateButton = root.querySelector('#toggle-rotate');
        const fitButton = root.querySelector('#fit-view');
        const railToggle = root.querySelector('#toggle-rail');
        const inspectorToggle = root.querySelector('#toggle-inspector');
        const labelsButton = root.querySelector('#toggle-labels');
        const focusButton = root.querySelector('#toggle-focus');

        layoutSelect?.addEventListener('change', () => {
            applyLayout(layoutSelect.value);
        });

        qualitySelect?.addEventListener('change', () => {
            scene.setQuality(qualitySelect.value);
        });

        rotateButton?.addEventListener('click', () => {
            scene.setAutoRotate(!scene.autoRotate);
            rotateButton.setAttribute('aria-pressed', String(scene.autoRotate));
        });

        labelsButton?.addEventListener('click', () => {
            scene.setLabels(!scene.labelsEnabled);
            labelsButton.setAttribute('aria-pressed', String(scene.labelsEnabled));
        });

        focusButton?.addEventListener('click', () => {
            const enabled = scene.setFocusEnabled(!scene.focusEnabled);
            focusButton.setAttribute('aria-pressed', String(enabled));
        });

        fitButton?.addEventListener('click', () => scene.fitAll(true));

        // Wide screens collapse the panels out of the grid; narrow screens
        // slide them in as overlays. One button, two mechanisms.
        const narrow = () => window.matchMedia('(max-width: 940px)').matches;

        const togglePanel = (button, panel) => {
            if (!button) return;

            const className = narrow()
                ? `is-${panel}-open`
                : `is-${panel}-collapsed`;

            const hidden = root.classList.toggle(className);
            const visible = narrow() ? hidden : !hidden;

            button.setAttribute('aria-pressed', String(visible));

            // Only one overlay at a time on small screens.
            if (narrow() && hidden) {
                const other = panel === 'rail' ? 'inspector' : 'rail';
                root.classList.remove(`is-${other}-open`);
                (other === 'rail' ? railToggle : inspectorToggle)?.setAttribute('aria-pressed', 'false');
            }
        };

        railToggle?.addEventListener('click', () => togglePanel(railToggle, 'rail'));
        inspectorToggle?.addEventListener('click', () => togglePanel(inspectorToggle, 'inspector'));

        // The assistant takes over the inspector column rather than adding a
        // fourth one: the map keeps its width, and the same button swaps back.
        const aiButton = root.querySelector('#toggle-ai');

        aiButton?.addEventListener('click', () => {
            ai?.toggle();
            aiButton.setAttribute('aria-pressed', String(Boolean(ai?.isOpen)));
        });

        root.addEventListener('ai:open', () => aiButton?.setAttribute('aria-pressed', String(Boolean(ai?.isOpen))));

        root.querySelector('#stage')?.addEventListener('click', (event) => {
            if (!narrow() || event.target.tagName !== 'CANVAS') return;

            root.classList.remove('is-rail-open', 'is-inspector-open');
            railToggle?.setAttribute('aria-pressed', 'false');
            inspectorToggle?.setAttribute('aria-pressed', 'false');
        });

        document.addEventListener('atlas:trace', (event) => {
            const key = event.detail?.key;
            if (key) trace.run(key);
        });
    }

    /* ------------------------------------------------------- trace bar -- */

    function createTrace(rootElement, storeRef, sceneRef) {
        const bar = rootElement.querySelector('#trace-bar');
        const stepsEl = rootElement.querySelector('#trace-steps');
        const exitButton = rootElement.querySelector('#trace-exit');
        const selectEl = rootElement.querySelector('#trace-select');

        const state = { active: false, path: [] };

        function run(key) {
            const journey = computeJourney(storeRef, key);

            if (journey.path.length < 2) {
                select(key, { focus: true });

                return;
            }

            state.active = true;
            state.path = journey.path;

            storeRef.select(journey.path, { primary: key });
            sceneRef.setTrace({
                path: journey.path,
                // The chain's own links — the scene lights these and dims every
                // other line that happens to touch a step.
                edges: journey.steps.map((step) => step.edge?.index).filter((i) => i !== undefined),
                color: '#7dd3fc',
            });
            sceneRef.frameKeys(journey.path, { padding: 1.9, duration: 1100 });

            const color = storeRef.node(key)?.color ?? '#7dd3fc';

            stepsEl.innerHTML = journey.path.map((stepKey, index) => {
                const node = storeRef.node(stepKey);
                const step = journey.steps[index - 1];

                return `
                    <button class="trace-step" data-step="${escapeHtml(stepKey)}" title="${escapeHtml(step ? step.kindLabel : 'entry point')}">
                        <span class="trace-step__n" style="color:${escapeHtml(node?.color ?? color)}">${index + 1}</span>
                        ${escapeHtml(stepLabel(node))}
                    </button>
                `;
            }).join('');

            stepsEl.querySelectorAll('[data-step]').forEach((button) => {
                button.addEventListener('click', () => {
                    select(button.dataset.step, { focus: true });
                });
            });

            bar.hidden = false;
            if (selectEl) selectEl.value = key;
        }

        function exit() {
            state.active = false;
            state.path = [];
            bar.hidden = true;
            sceneRef.setTrace(null);
            storeRef.clearSelection();
            if (selectEl) selectEl.value = '';
        }

        exitButton?.addEventListener('click', exit);

        selectEl?.addEventListener('change', () => {
            if (selectEl.value) {
                run(selectEl.value);
            } else {
                exit();
            }
        });

        return { run, exit, get active() { return state.active; } };
    }

    /* -------------------------------------------------------- url state -- */

    function urlParam(name) {
        return new URLSearchParams(window.location.search).get(name);
    }

    function applyUrlState() {
        const node = urlParam('node');
        const layout = urlParam('layout');

        // A `?layout=force` link predates this view being retired; anything the
        // picker does not offer falls back rather than leaving the select blank.
        const picker = root.querySelector('#layout-mode');

        if (layout && picker) {
            const known = [...picker.options].some((option) => option.value === layout);
            const mode = known ? layout : 'layers';

            picker.value = mode;
            store.layoutMode = mode;
            scene.setLayout(computeLayout(mode, store.nodes, store.edges, store.visible));
            scene.fitAll(false);
        }

        if (node && store.node(node)) {
            select(node, { focus: true });
        }

        const search = urlParam('q');
        if (search && root.querySelector('#search')) {
            root.querySelector('#search').value = search;
            store.filters.query = search.toLowerCase();
            store.setFilter({});
        }

        urlReady = true;
    }

    // Nothing may write the URL before the incoming one has been read: filters
    // settle (and `visibility` fires) while the scene is being built, and a
    // write at that moment would replace the deep link with the defaults —
    // wiping `?q=…&layout=…` before `applyUrlState()` ever saw it.
    let urlReady = false;
    let lastUrl = null;

    function writeUrlState() {
        if (!urlReady) return;

        const params = new URLSearchParams(window.location.search);

        if (store.primary) {
            params.set('node', store.primary);
        } else {
            params.delete('node');
        }

        params.set('layout', store.layoutMode);
        if (store.preset) params.set('view', store.preset);

        // `node` above is set *or* deleted; a query must be too, or clearing the
        // search leaves `?q=…` behind and a refresh brings the query back.
        if (store.filters.query) {
            params.set('q', store.filters.query);
        } else {
            params.delete('q');
        }

        const url = `${window.location.pathname}?${params.toString()}`;

        // Searching now writes the URL, so this runs on a debounce while someone
        // types. Two consequences: skip the call when the URL has not changed,
        // and never let a history write take the keystroke down with it — Safari
        // throttles `replaceState` and throws once they come too fast.
        if (url === lastUrl) return;

        lastUrl = url;

        try {
            window.history.replaceState({}, '', url);
        } catch {
            lastUrl = null;
        }
    }

    window.addEventListener('popstate', () => {
        if (!store) return;
        applyUrlState();
    });

    /* ------------------------------------------------------------- start -- */

    await loadGraph({ animateIn: true });

    document.body.dataset.atlasBooted = '1';

    // A console handle for power users: `__atlas.scene.camera` etc.
    root.__atlas = {
        api,
        journey: (key) => computeJourney(store, key),
        // Turn off the automatic renderer downgrade (used by the screenshots in
        // docs/ and handy when presenting from a slow machine).
        pauseAutoQuality: () => { autoQuality = false; },
        get store() { return store; },
        get scene() { return scene; },
        get ui() { return ui; },
        get inspector() { return inspector; },
        get trace() { return trace; },
        get ai() { return ai; },
    };
}
