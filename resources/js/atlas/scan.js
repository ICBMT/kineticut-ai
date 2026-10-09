/**
 * The live scanning overlay.
 *
 * While a scan runs the atlas can already be open: this module streams the
 * pipeline stages and the event log, then hands control back to the renderer
 * the moment the graph is ready.
 */

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export function createScanWatcher({ root, api, onReady, hasGraph = false }) {
    const overlay = root.querySelector('#scan-overlay');
    const stagesEl = root.querySelector('#scan-stages');
    const logEl = root.querySelector('#scan-log');
    const progressEl = root.querySelector('#scan-progress');
    const percentEl = root.querySelector('#scan-percent');
    const stageLabelEl = root.querySelector('#scan-stage-label');
    const titleEl = root.querySelector('#scan-title');
    const hintEl = root.querySelector('#scan-hint');
    const reloadButton = root.querySelector('#scan-reload');

    let timer = null;
    let lastEventId = 0;
    let stagesRendered = false;

    const show = () => { overlay.hidden = false; };
    const hide = () => { overlay.hidden = true; };

    function renderStages(stages = []) {
        if (stagesRendered && stages.length === 0) return;

        stagesEl.innerHTML = stages.map((stage, index) => `
            <div class="stage ${stage.status === 'done' ? 'is-done' : stage.status === 'running' ? 'is-running' : stage.status === 'failed' ? 'is-failed' : 'is-pending'}">
                <span class="stage__dot">${stage.status === 'done' ? '✓' : String(index + 1).padStart(2, '0')}</span>
                <span>${escapeHtml(stage.label)}</span>
                <span class="stage__ms">${stage.ms ? stage.ms + 'ms' : ''}</span>
                ${stage.summary ? `<span class="stage__summary">${escapeHtml(typeof stage.summary === 'string' ? stage.summary : '')}</span>` : ''}
            </div>
        `).join('');

        stagesRendered = true;
    }

    async function pollEvents() {
        try {
            const payload = await api.events(lastEventId);

            (payload.events ?? []).forEach((event) => {
                lastEventId = Math.max(lastEventId, event.id);

                const line = document.createElement('div');
                line.className = `log__line log__line--${event.level}`;
                line.innerHTML = `<b>${new Date(event.at ?? Date.now()).toLocaleTimeString()}</b> ${escapeHtml(event.message)}`;
                logEl.appendChild(line);
            });

            while (logEl.children.length > 120) logEl.removeChild(logEl.firstChild);
            logEl.scrollTop = logEl.scrollHeight;
        } catch {
            /* polling is best-effort */
        }
    }

    async function tick() {
        let state;

        try {
            state = await api.status();
        } catch {
            return;
        }

        progressEl.style.width = `${state.progress ?? 0}%`;
        percentEl.textContent = `${state.progress ?? 0}%`;
        stageLabelEl.textContent = state.stage_label ?? 'Working…';
        renderStages(state.stages ?? []);

        // A scan sits in the queue until a worker picks it up, which looks
        // like a freeze — so say so, and say how to fix it.
        const waiting = state.status === 'queued';

        hintEl.hidden = !waiting;

        if (waiting) {
            hintEl.textContent = 'No queue worker has picked this scan up yet. Run “php artisan queue:work --queue=atlas” — or set ATLAS_SYNC_SCANS=true to scan inline.';
        }

        await pollEvents();

        if (state.status === 'completed') {
            titleEl.textContent = 'Scan complete';
            stageLabelEl.textContent = 'Loading the atlas…';
            progressEl.style.width = '100%';
            percentEl.textContent = '100%';
            reloadButton.hidden = false;

            stop();

            setTimeout(async () => {
                hide();
                await onReady();
            }, 550);

            return;
        }

        if (state.status === 'failed') {
            titleEl.textContent = 'Scan failed';
            stageLabelEl.textContent = state.error ?? 'Unknown error';
            stop();

            return;
        }

        if (state.stage === 'queued' && !stagesRendered && (state.stages ?? []).length) {
            renderStages(state.stages);
        }
    }

    function start() {
        show();

        // A rescan of an already-mapped project must not hold the atlas
        // hostage: the old graph is right there behind the overlay.
        if (hasGraph) reloadButton.hidden = false;

        tick();
        timer = setInterval(tick, 850);
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    reloadButton?.addEventListener('click', async () => {
        hide();
        await onReady();
    });

    return { start, stop, hide, show, pollEvents };
}
