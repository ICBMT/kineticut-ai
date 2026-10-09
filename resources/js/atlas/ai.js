/**
 * The assistant panel.
 *
 * One conversation per project, kept in the browser so a reload does not lose
 * it. Every answer arrives as a stream (newline-delimited JSON from
 * `POST /ai/ask`) and is rendered as it is written; the `[[key]]` citations the
 * model was asked to use become buttons that fly the map to that node.
 *
 * The panel never talks to the model runtime itself — see AiController. It
 * talks to Laravel, which talks to 127.0.0.1:11434.
 */
import { renderMarkdown, escapeHtml } from './markdown.js';

const STORAGE_PREFIX = 'atlas:ai:';
const MAX_TURNS = 40;

export function createAi({ root, store, scene, onShowNode, toast, language }) {
    const panel = root.querySelector('#ai-panel');
    const log = root.querySelector('#ai-log');
    const form = root.querySelector('#ai-form');
    const input = root.querySelector('#ai-input');
    const send = root.querySelector('#ai-send');
    const stopButton = root.querySelector('#ai-stop');
    const clearButton = root.querySelector('#ai-clear');
    const statusCard = root.querySelector('#ai-status');
    const modelSelect = root.querySelector('#ai-model');
    const modelLabel = root.querySelector('#ai-model-label');

    const statusUrl = root.dataset.aiStatusUrl;
    const askUrl = root.dataset.aiAskUrl;
    const csrf = root.dataset.csrf ?? '';
    const projectId = root.dataset.project;

    const state = {
        messages: [],
        model: null,
        status: null,
        busy: false,
        controller: null,
        open: false,
        hintTimer: null,
    };

    /** What the panel says while it waits for the model's first words. */
    const WAITING_HINTS = [
        'Searching the graph for the code your question is about…',
        'Reading the matching files…',
        'Assembling the prompt…',
        'Waiting for the model to start writing…',
    ];

    /* ---------------------------------------------------------- storage -- */

    function storageKey() {
        return `${STORAGE_PREFIX}${projectId}`;
    }

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey()) ?? 'null');

            if (saved && Array.isArray(saved.messages)) {
                state.messages = saved.messages.slice(-MAX_TURNS);
                state.model = saved.model ?? null;
            }
        } catch {
            state.messages = [];
        }
    }

    function persist() {
        try {
            // Only what is worth keeping: the words. Steps, reasoning and
            // streaming flags describe a request that is over.
            const messages = state.messages.slice(-MAX_TURNS).map((message) => ({
                role: message.role,
                content: message.content,
                citations: message.citations ?? [],
                ...(message.error ? { error: message.error } : {}),
            }));

            localStorage.setItem(storageKey(), JSON.stringify({ messages, model: state.model }));
        } catch {
            // A full or blocked localStorage must not break the conversation.
        }
    }

    /* ------------------------------------------------------------ input -- */

    function suggestions() {
        const trails = store?.nodes?.filter((node) => node.type === 'route') ?? [];
        const entries = store?.nodes?.filter((node) => node.type === 'executable'
            || (node.type === 'function' && node.layer === 'entry')) ?? [];

        if (language === 'cpp') {
            const entry = entries[0];

            return [
                'What does this program do when it starts?',
                entry ? `Explain ${entry.label}()` : 'Explain the entry points',
                'How are the classes organised into layers?',
                'Which files would I change to add a feature?',
            ];
        }

        if (language === 'csharp') {
            const route = trails[0];

            return [
                'What does this API do?',
                route ? `Explain ${route.summary || route.label}` : 'Explain the routes',
                'How does a request reach the database?',
                'Which controllers and services are the busiest?',
            ];
        }

        // Python is two projects in one question: a web app has routes, a
        // script has an entry point, and the suggestions should not lie about
        // which of the two is loaded.
        if (language === 'python') {
            if (trails.length > 0) {
                const route = trails[0];

                return [
                    'What does this application do?',
                    route ? `Explain ${route.summary || route.label}` : 'Explain the routes',
                    'How does a request reach the database?',
                    'Where are the models defined and what do they store?',
                ];
            }

            const entry = entries[0];

            return [
                'What does this script do when it runs?',
                entry ? `Explain ${entry.label}` : 'Explain the entry points',
                'How are the modules organised?',
                'Which files would I change to add a feature?',
            ];
        }

        const route = trails.find((node) => (node.summary || '').includes('dashboard')) ?? trails[0];

        return [
            'What does this application do?',
            route ? `Explain ${route.summary || route.label}` : 'Explain the main routes',
            'Which models and tables does it use?',
            'Where would I add a new feature?',
        ];
    }

    /** The suggestion block's host element, created on first use. */
    function introHost() {
        let host = log.querySelector('#ai-suggestions');

        if (!host) {
            host = document.createElement('div');
            host.className = 'ai__intro';
            host.id = 'ai-suggestions';
            log.appendChild(host);
        }

        return host;
    }

    function renderSuggestions() {
        if (state.messages.length) return;

        const intro = introHost();

        intro.innerHTML = `
            <div class="ai__intro-title">Ask about this project</div>
            <div class="ai__chips">
                ${suggestions().map((text) => `
                    <button class="ai__chip" type="button" data-ask="${escapeHtml(text)}">${escapeHtml(text)}</button>
                `).join('')}
            </div>
        `;

        intro.querySelectorAll('[data-ask]').forEach((chip) => {
            chip.addEventListener('click', () => ask(chip.dataset.ask));
        });
    }

    /* ----------------------------------------------------------- status -- */

    async function refreshStatus() {
        if (!statusUrl) return null;

        try {
            const response = await fetch(statusUrl, { headers: { Accept: 'application/json' } });
            state.status = await response.json();
        } catch {
            state.status = { available: false, error: 'The atlas could not check for a local model.', installed: [], suggested: {} };
        }

        renderStatus();

        return state.status;
    }

    function renderStatus() {
        const status = state.status;

        if (!status || !statusCard) return;

        const usable = status.enabled && status.available;

        statusCard.hidden = usable;
        input.disabled = !usable;
        send.disabled = !usable;

        // The model picker only exists when there is something to pick.
        if (modelSelect) {
            modelSelect.hidden = !usable || (status.installed ?? []).length < 2;

            // The picker already says which model; the label would just repeat it.
            if (modelLabel) modelLabel.hidden = !modelSelect.hidden;

            if (usable) {
                const installed = status.installed ?? [];
                modelSelect.innerHTML = installed.map((model) => `
                    <option value="${escapeHtml(model)}"${model === (state.model ?? status.model) ? ' selected' : ''}>${escapeHtml(model)}</option>
                `).join('');

                state.model = state.model ?? status.model ?? installed[0] ?? null;
            }
        }

        if (modelLabel) {
            modelLabel.textContent = usable ? (state.model ?? status.model ?? '') : '';
        }

        if (usable) {
            renderSuggestions();
            return;
        }

        const setup = status.setup ?? {};
        const steps = setup.steps ?? {};
        const missing = setup.missing_model;
        const installed = status.installed ?? [];

        statusCard.innerHTML = `
            <div class="ai__setup">
                <div class="ai__setup-title">${missing ? 'The model is not downloaded yet' : 'No local model is answering'}</div>
                <p class="ai__setup-text">
                    ${missing
                        ? `The endpoint is up, but <code>${escapeHtml(setup.model ?? '')}</code> has not been pulled. One command fixes that:`
                        : `The assistant runs entirely on this machine. It could not reach <code>${escapeHtml(status.endpoint ?? '')}</code> — nothing is listening there yet.${status.error ? ` <span class="ai__setup-error">${escapeHtml(status.error)}</span>` : ''}`}
                </p>
                <div class="ai__setup-steps">
                    ${!missing ? `<div class="ai__step"><span>1</span><code>${escapeHtml(steps.install ?? 'Install Ollama')}</code></div>` : ''}
                    <div class="ai__step"><span>${missing ? '1' : '2'}</span><code>${escapeHtml(steps.pull ?? '')}</code></div>
                    <div class="ai__step"><span>${missing ? '2' : '3'}</span><code>${escapeHtml(steps.serve ?? '')}</code></div>
                </div>
                ${installed.length ? `<div class="ai__setup-note">Already installed: ${installed.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')}</div>` : ''}
                <div class="ai__setup-actions">
                    <button class="btn btn--sm btn--primary" type="button" data-ai-retry>Check again</button>
                    <span class="ai__setup-note">Answers never leave this machine.</span>
                </div>
            </div>
        `;

        statusCard.querySelector('[data-ai-retry]')?.addEventListener('click', async (event) => {
            event.currentTarget.textContent = 'Checking…';
            await refreshStatus();
        });
    }

    /* ------------------------------------------------------------- chat -- */

    function renderMessage(message, index) {
        const citations = message.citations ?? [];

        if (message.role === 'user') {
            return `
                <div class="ai__msg ai__msg--user" data-index="${index}">
                    <div class="ai__bubble">${escapeHtml(message.content)}</div>
                </div>
            `;
        }

        // An answer still being worked on gets the full live shell; one that is
        // finished (or restored from an earlier visit) is just the words.
        if (message.live) {
            return `
                <div class="ai__msg ai__msg--bot ai__msg--live" data-index="${index}">
                    <div class="ai__bubble" data-live="1">
                        <details class="ai__live">
                            <summary class="ai__live-summary">
                                <span class="ai__live-caret"></span>
                                <span class="ai__live-summary-text"></span>
                            </summary>
                            <div class="ai__live-body">
                                <div class="ai__bar"><i></i></div>
                                <div class="ai__trail"></div>
                                <div class="ai__thoughts" hidden>
                                    <div class="ai__thoughts-title">Reasoning</div>
                                    <div class="ai__thoughts-body"></div>
                                </div>
                            </div>
                        </details>
                        <div class="ai__answer"></div>
                        <div class="ai__waiting" hidden>
                            <span class="ai__thinking"><i></i><i></i><i></i></span>
                            <span class="ai__live-hint"></span>
                        </div>
                        <div class="ai__error" hidden></div>
                        <div class="ai__citations"></div>
                        <span class="ai__stream-caret" hidden></span>
                    </div>
                </div>
            `;
        }

        return `
            <div class="ai__msg ai__msg--bot" data-index="${index}">
                <div class="ai__bubble">
                    ${message.content
                        ? renderMarkdown(message.content)
                        : '<span class="ai__thinking"><i></i><i></i><i></i></span>'}
                    ${message.error ? `<div class="ai__error">${escapeHtml(message.error)}</div>` : ''}
                    ${citations.length && !message.error ? renderCitations(citations) : ''}
                </div>
            </div>
        `;
    }

    /* ------------------------------------------------- the live answer ---- */

    /**
     * Keep one in-flight answer in sync with what has arrived so far.
     *
     * Everything here updates in place rather than re-rendering the bubble.
     * That matters for two reasons: the caret at the end of the text keeps
     * blinking (a replaced element restarts its animation), and a reader who
     * opened the activity trail keeps it open instead of having it snapped
     * shut every 45 ms.
     */
    function syncLive(index, { force = false } = {}) {
        const message = state.messages[index];
        const element = log.querySelector(`.ai__msg[data-index="${index}"]`);

        if (!message || !element) return;

        const bubble = element.querySelector('.ai__bubble');
        const stick = force || nearBottom();
        const finished = !message.live;

        syncSteps(element, message, finished);
        syncThoughts(element, message);
        syncSummary(element, message, finished);
        syncWaiting(element, message, finished);
        paintAnswer(element, message, finished);
        syncError(element, message);
        syncCitations(element, message, finished);

        bubble.classList.toggle('is-streaming', !!message.streaming);
        element.classList.toggle('is-finished', finished);

        if (stick) scrollToEnd();
    }

    /** The list of things the atlas did before the model could start. */
    function syncSteps(element, message, finished) {
        const host = element.querySelector('.ai__trail');

        if (!host) return;

        const steps = message.steps ?? [];
        const signature = finished
            ? `final:${steps.length}:${(steps.at(-1)?.files ?? []).length}`
            : steps.map((step) => `${step.stage}:${step.label}:${(step.files ?? []).length}`).join('|');

        if (host.dataset.signature === signature) return;

        host.dataset.signature = signature;

        host.innerHTML = steps.map((step, position) => {
            const done = finished || position < steps.length - 1;

            return `
                <div class="ai__trail-step ${done ? 'ai__trail-step--done' : 'ai__trail-step--active'}">
                    <span class="ai__trail-mark">${done ? '✓' : ''}</span>
                    <span class="ai__trail-text">${escapeHtml(step.label ?? '')}</span>
                </div>
                ${renderStepFiles(step.files ?? [])}
            `;
        }).join('');
    }

    /**
     * The files the question was answered from, revealed one after another so
     * the trail reads as work rather than as a list that was always there.
     */
    function renderStepFiles(files) {
        if (!files.length) return '';

        const shown = files.slice(0, 4);
        const extra = files.length - shown.length;

        return `
            <div class="ai__trail-files">
                ${shown.map((file, position) => `
                    <span class="ai__trail-file" style="--i:${position}" title="${escapeHtml(file.path)}">
                        <span class="ai__trail-file-name">${escapeHtml(file.path.split('/').pop())}</span>
                        <span class="ai__trail-file-dir">${escapeHtml(parentPath(file.path))}</span>
                    </span>
                `).join('')}
                ${extra > 0 ? `<span class="ai__trail-file ai__trail-file--more">+${extra} more</span>` : ''}
            </div>
        `;
    }

    function parentPath(path) {
        const cut = path.lastIndexOf('/');

        return cut === -1 ? '' : path.slice(0, cut + 1);
    }

    /** A reasoning model's notes, shown as they are written. */
    function syncThoughts(element, message) {
        const box = element.querySelector('.ai__thoughts');

        if (!box) return;

        const thought = message.thought ?? '';

        box.hidden = thought === '';

        if (!thought) return;

        const body = box.querySelector('.ai__thoughts-body');
        const title = box.querySelector('.ai__thoughts-title');

        // textContent, in place: this arrives many times a second and must not
        // disturb the scroll position of a long thought.
        if (body.textContent !== thought) {
            body.textContent = thought;
            body.scrollTop = body.scrollHeight;
        }

        const label = `${thought.length} chars`;
        if (title.dataset.label !== label) {
            title.dataset.label = label;
            title.innerHTML = `Reasoning <span>${label}</span>`;
        }
    }

    function liveSummary(message, finished) {
        // While the atlas is still collecting, the line says what it is doing
        // right now. Once words are arriving that status is stale — the model is
        // writing, not searching — so the line becomes the recap of what was
        // read, which is also what it will still say when the answer is done.
        if (!finished && !message.streaming) {
            return message.statusLabel ?? 'Working…';
        }

        const steps = message.steps ?? [];
        const files = steps.flatMap((step) => step.files ?? []);
        const parts = [];

        if (files.length) parts.push(`${files.length} file${files.length === 1 ? '' : 's'} read`);
        if (message.citations?.length) parts.push(`${message.citations.length} nodes cited`);
        if (message.contextChars) parts.push(`${(message.contextChars / 1000).toFixed(1)} kB of context`);

        return parts.join(' · ') || 'What the assistant did';
    }

    function syncSummary(element, message, finished) {
        const details = element.querySelector('.ai__live');
        const text = element.querySelector('.ai__live-summary-text');

        if (details && text) {
            const summary = liveSummary(message, finished);

            if (text.textContent !== summary) text.textContent = summary;
        }

        element.classList.toggle('has-steps', (message.steps ?? []).length > 0);
    }

    function syncWaiting(element, message, finished) {
        const waiting = element.querySelector('.ai__waiting');

        if (!waiting) return;

        const show = !finished && message.content === '' && !message.error;

        waiting.hidden = !show;

        if (show && !waiting.classList.contains('is-on')) {
            waiting.classList.add('is-on');
        }
    }

    /**
     * The reply, typed out. Only rewritten when the text actually changed, so
     * a quiet moment in the stream costs nothing.
     */
    function paintAnswer(element, message, finished) {
        const host = element.querySelector('.ai__answer');

        if (!host) return;

        const caret = element.querySelector('.ai__stream-caret');

        if (!caret) return;

        caret.hidden = finished || !message.streaming;

        // The caret follows the text, which means the repaint below would wipe
        // it out. Lift it out first, then put it back where the next word goes —
        // an element that keeps its identity keeps its place at the end of the
        // sentence instead of vanishing on the first paint.
        caret.remove();

        if (host.dataset.content !== (message.content ?? '')) {
            host.dataset.content = message.content ?? '';
            host.innerHTML = message.content ? renderMarkdown(message.content) : '';
            decorate(host);
        }

        if (caret.hidden) {
            // Parked outside the answer, where a rewrite cannot reach it.
            const bubble = element.querySelector('.ai__bubble');

            if (bubble && caret.parentElement !== bubble) bubble.appendChild(caret);
        } else {
            (host.lastElementChild ?? host).appendChild(caret);
        }
    }

    function syncError(element, message) {
        const box = element.querySelector('.ai__error');

        if (!box) return;

        box.hidden = !message.error;

        if (message.error) box.textContent = message.error;
    }

    function syncCitations(element, message, finished) {
        const box = element.querySelector('.ai__citations');

        if (!box || !finished) return;

        const citations = message.citations ?? [];

        if (box.dataset.signature === String(citations.length)) return;

        box.dataset.signature = String(citations.length);
        box.innerHTML = citations.length && !message.error ? renderCitations(citations) : '';
    }

    function renderCitations(citations) {
        const known = citations.filter((citation) => store?.node(citation.key));

        if (!known.length) return '';

        return `
            <div class="ai__citations">
                <span class="ai__citations-label">read for this answer</span>
                ${known.map((citation) => `
                    <button class="ai__cite" type="button" data-key="${escapeHtml(citation.key)}" title="${escapeHtml(citation.file ?? citation.key)}">
                        <span class="ai__cite-dot" style="background:${escapeHtml(store.node(citation.key)?.color ?? '#56b8ff')}"></span>
                        ${escapeHtml(citation.label)}
                    </button>
                `).join('')}
            </div>
        `;
    }

    /**
     * Fill in the `[[key]]` citations the model wrote.
     *
     * A key that exists becomes the node's own label — a chip that opens it in
     * the atlas; a key the model made up stays visible as plain code, which is
     * the honest way to show a citation that points at nothing.
     */
    function decorate(scope) {
        scope.querySelectorAll('[data-cite]').forEach((element) => {
            const key = element.dataset.cite;
            const node = store?.node(key);

            if (!node) {
                element.outerHTML = `<code title="not in this graph">${escapeHtml(key)}</code>`;
                return;
            }

            element.dataset.key = key;
            element.title = node.file ? `${node.type_label ?? node.type} · ${node.file}${node.line ? ':' + node.line : ''}` : key;
            element.innerHTML = `<span class="ai__cite-dot" style="background:${escapeHtml(node.color ?? '#56b8ff')}"></span>${escapeHtml(node.label)}`;
        });
    }

    function renderLog() {
        if (state.messages.length === 0) {
            log.innerHTML = '';
            introHost();
            renderSuggestions();
        } else {
            log.innerHTML = state.messages.map(renderMessage).join('');
        }

        decorate(log);

        // A live answer is a shell until it is filled; wire up the one that was
        // just rendered (a reload mid-question, or the first render after the
        // question was asked).
        const index = state.messages.length - 1;

        if (state.messages[index]?.live) {
            wireLive(index);
            syncLive(index, { force: true });
        }

        scrollToEnd();
    }

    /**
     * Attach the behaviour that only exists on a live answer: the trail starts
     * open, and once the reader has opened or closed it themselves the panel
     * stops folding it on their behalf.
     */
    function wireLive(index) {
        const element = log.querySelector(`.ai__msg[data-index="${index}"]`);
        const details = element?.querySelector('.ai__live');

        if (!details || details.dataset.wired === '1') return;

        details.dataset.wired = '1';
        details.open = !(state.messages[index]?.streaming);

        details.addEventListener('click', () => {
            state.messages[index].touched = true;
        });
    }

    function nearBottom() {
        return log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    }

    function scrollToEnd() {
        log.scrollTop = log.scrollHeight;
    }

    async function ask(question) {
        if (state.busy || !question.trim()) return;

        if (!state.status?.available) {
            await refreshStatus();

            if (!state.status?.available) return;
        }

        // Only the first question carries the opening suggestions away.
        if (state.messages.length === 0) {
            log.innerHTML = '';
        }

        const history = state.messages
            .filter((message) => !message.error)
            .slice(-6)
            .map((message) => ({ role: message.role, content: message.content }));

        state.messages.push({ role: 'user', content: question });
        state.messages.push({
            role: 'assistant',
            content: '',
            citations: [],
            live: true,
            steps: [],
            thought: '',
            streaming: false,
            state: 'collecting',
            statusLabel: 'Finding the part of the project that matters',
        });

        const index = state.messages.length - 1;

        state.busy = true;
        input.value = '';
        resize();
        send.hidden = true;
        stopButton.hidden = false;
        renderLog();
        persist();
        startHints(index);

        state.controller = new AbortController();
        const element = log.querySelector(`.ai__msg[data-index="${index}"]`);

        try {
            const response = await fetch(askUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/x-ndjson',
                    'X-CSRF-TOKEN': csrf,
                },
                body: JSON.stringify({ question, model: state.model, history }),
                signal: state.controller.signal,
            });

            if (!response.ok || !response.body) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.error ?? `The assistant answered with ${response.status}.`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let lastPaint = 0;

            while (true) {
                const { value, done } = await reader.read();

                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let breakAt;

                while ((breakAt = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, breakAt).trim();
                    buffer = buffer.slice(breakAt + 1);

                    if (!line) continue;

                    let event;

                    try {
                        event = JSON.parse(line);
                    } catch {
                        continue;
                    }

                    const current = state.messages[index];

                    if (event.type === 'status') {
                        current.state = event.state ?? current.state;
                        current.statusLabel = event.label ?? current.statusLabel;
                    } else if (event.type === 'step') {
                        current.steps.push(event);
                        current.statusLabel = event.label ?? current.statusLabel;
                    } else if (event.type === 'meta') {
                        current.citations = event.citations ?? [];
                        current.contextChars = event.context_chars ?? null;
                    } else if (event.type === 'thinking') {
                        current.thought += event.text ?? '';
                    } else if (event.type === 'delta') {
                        current.content += event.text ?? '';

                        if (!current.streaming) {
                            current.streaming = true;
                            stopHints();

                            // Words are arriving: fold the trail away, unless
                            // the reader has taken it over.
                            const details = element?.querySelector('.ai__live');

                            if (details && !current.touched) details.open = false;
                        }
                    } else if (event.type === 'error') {
                        current.error = event.message ?? 'The assistant stopped.';
                    }

                    // Repaint at most every 45 ms: typing-speed updates
                    // without re-rendering markdown hundreds of times a second.
                    const now = performance.now();
                    const urgent = event.type !== 'delta' && event.type !== 'thinking';

                    if (urgent || now - lastPaint > 45) {
                        lastPaint = now;
                        syncLive(index);
                    }
                }
            }
        } catch (error) {
            const current = state.messages[index];

            if (error.name === 'AbortError') {
                current.stopped = true;

                if (!current.content) current.content = '_Stopped._';
            } else {
                current.error = error.message;
            }
        } finally {
            stopHints();

            const current = state.messages[index];

            // The answer is over: no more caret, no more progress bar, and the
            // trail folds into a summary of what was read.
            current.live = false;
            current.streaming = false;

            state.busy = false;
            state.controller = null;
            send.hidden = false;
            stopButton.hidden = true;
            syncLive(index, { force: true });
            persist();
        }
    }

    /**
     * A line of text under the answer while nothing has been written yet.
     *
     * It changes every couple of seconds so a slow model reads as working
     * rather than as a hang, and past eight seconds it starts counting, which
     * is the point at which "this model is too big for this machine" is worth
     * saying out loud.
     */
    function startHints(index) {
        stopHints();

        const startedAt = performance.now();
        let step = 0;

        const tick = () => {
            const hint = log.querySelector(`.ai__msg[data-index="${index}"] .ai__live-hint`);

            if (!hint) return;

            const seconds = Math.round((performance.now() - startedAt) / 1000);
            const base = WAITING_HINTS[Math.min(step, WAITING_HINTS.length - 1)];

            hint.textContent = seconds >= 8 ? `${base} ${seconds}s…` : base;
            step++;
        };

        tick();
        state.hintTimer = setInterval(tick, 2600);
    }

    function stopHints() {
        if (state.hintTimer) {
            clearInterval(state.hintTimer);
            state.hintTimer = null;
        }
    }

    /* ----------------------------------------------------------- events -- */

    function resize() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    }

    form?.addEventListener('submit', (event) => {
        event.preventDefault();
        ask(input.value.trim());
    });

    input?.addEventListener('input', resize);

    input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            ask(input.value.trim());
        }
    });

    stopButton?.addEventListener('click', () => {
        state.controller?.abort();
    });

    clearButton?.addEventListener('click', () => {
        state.messages = [];
        persist();
        renderLog();
    });

    modelSelect?.addEventListener('change', () => {
        state.model = modelSelect.value;
        persist();

        if (modelLabel) modelLabel.textContent = state.model;
    });

    // Citation chips: the whole point of citing keys is that the map can show
    // the node, so a click selects it, flies the camera there and hands the
    // inspector back its Details tab.
    log?.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-key]');

        if (!chip) return;

        const key = chip.dataset.key;

        if (store?.node(key)) onShowNode?.(key);
    });

    /* ------------------------------------------------------------- open -- */

    load();
    renderLog();

    /*
     * Plain functions rather than methods on the returned object: a `get open()`
     * accessor and an `open()` method would collide on the same key.
     */
    function openPanel() {
        state.open = true;
        panel.hidden = false;
        root.classList.add('is-ai');
        refreshStatus();

        if (state.messages.length === 0) renderSuggestions();

        setTimeout(() => input?.focus(), 60);
    }

    function closePanel() {
        state.open = false;
        panel.hidden = true;
        root.classList.remove('is-ai');
        stopHints();
        state.controller?.abort();
    }

    return {
        open: openPanel,
        close: closePanel,
        toggle: () => (state.open ? closePanel() : openPanel()),
        ask,
        get isOpen() {
            return state.open;
        },
        /** A question handed in from elsewhere in the UI (a node, an insight). */
        prompt(question) {
            if (!state.open) openPanel();
            setTimeout(() => ask(question), 30);
        },
    };
}
