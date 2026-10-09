#!/usr/bin/env node
/**
 * Runtime smoke test: actually RENDER the app headlessly.
 *
 * Loads the real renderer entry (src/renderer/main.tsx) through Vite's SSR
 * module runner inside a jsdom window, with relative fetches pointed at the
 * dev API server — so the full boot path runs (settings → providers → mock
 * Ollama → folder open → file tree → git status → AI project brief) and React
 * renders the shell.
 *
 * Also regression-tests the "files appear empty" bug: the editor library can
 * create an EMPTY Monaco model before ensureModel runs; ensureModel must fill
 * it with the file content.
 *
 * Prerequisites: `npm run dev:web` must be running (API on :4890, mock
 * Ollama on :11434).
 *
 *   npm run smoke
 */
import { createServer } from 'vite'
import { JSDOM, VirtualConsole } from 'jsdom'

const API = 'http://127.0.0.1:4890'
const TEST_FILE = '/home/user/kineticut-ai/package.json'
const REPO = '/home/user/kineticut-ai'

/* ------------------------------ jsdom globals ------------------------------ */

const virtualConsole = new VirtualConsole()
const jsdomErrors = []
virtualConsole.on('jsdomError', (e) => {
  const msg = String(e?.message || e)
  // Known jsdom limitations, not app errors.
  if (/css|Could not load|Not implemented: HTMLCanvasElement/i.test(msg)) return
  jsdomErrors.push(msg.slice(0, 300))
})
virtualConsole.on('error', (...args) => {
  jsdomErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 300))
})
virtualConsole.on('warn', () => {})

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
  virtualConsole,
})

// jsdom has no canvas. Monaco measures text and pixel ratio through a 2D context,
// so give it a stand-in context (the real app runs in a browser with a canvas).
{
  const fakeCtx = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'webkitBackingStorePixelRatio') return 1
        if (key === 'measureText') return () => ({ width: 8 })
        return () => undefined
      },
      set: () => true,
    },
  )
  dom.window.HTMLCanvasElement.prototype.getContext = () => fakeCtx
}

const g = globalThis
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in g) continue
  try {
    g[key] = dom.window[key]
  } catch {
    /* non-configurable */
  }
}
g.window = dom.window
g.self = dom.window
g.document = dom.window.document
g.globalThis = g

// Node's globalThis is not an EventTarget — bind the window's event methods
// (Monaco and React expect them on the global object).
const boundWindowEvents = {
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window),
  dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
}
for (const [method, bound] of Object.entries(boundWindowEvents)) {
  g[method] = bound
}
if (!g.requestAnimationFrame) {
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
  g.cancelAnimationFrame = (id) => clearTimeout(id)
}

// jsdom does not implement the legacy command API Monaco probes for.
if (!dom.window.document.queryCommandSupported) {
  dom.window.document.queryCommandSupported = () => false
}
if (!dom.window.document.execCommand) {
  dom.window.document.execCommand = () => false
}

// jsdom does not implement matchMedia (Monaco probes the OS color scheme).
if (!dom.window.matchMedia) {
  const matchMediaStub = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
  })
  dom.window.matchMedia = matchMediaStub
  g.matchMedia = matchMediaStub
}

/* --------------------------------- stubs ----------------------------------- */

class EventSourceStub {
  constructor() {
    this.readyState = 0
  }
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
class WebSocketStub {
  constructor() {
    this.readyState = 0
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
for (const [name, stub] of [
  ['EventSource', EventSourceStub],
  ['WebSocket', WebSocketStub],
  ['ResizeObserver', ResizeObserverStub],
]) {
  g[name] = stub
  dom.window[name] = stub
}

// Relative fetches (the HTTP API transport) go to the dev server.
const realFetch = g.fetch.bind(g)
g.fetch = (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? API + input : input
  return realFetch(url, init)
}
dom.window.fetch = g.fetch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Late module requests can race server.close() during teardown — ignore those.
process.on('unhandledRejection', (err) => {
  if (err && String(err.message || err).includes('transport was disconnected')) return
  console.error('unhandled rejection:', err)
})

// Monaco schedules render and worker timers that throw under jsdom (no real
// canvas, no worker URL resolver) once the event loop yields after the editor
// was tested. Errors raised from inside monaco-editor are counted and reported;
// any other uncaught exception still fails the run.
process.on('uncaughtException', (err) => {
  const stack = String(err?.stack || err)
  if (stack.includes('node_modules/monaco-editor/')) {
    monacoWorkerNoise++
    return
  }
  console.error('uncaught exception:', err)
  process.exit(1)
})
let monacoWorkerNoise = 0

/* ---------------------------------- run ------------------------------------ */

async function main() {
  // Check the dev stack is up.
  try {
    const health = await realFetch(API + '/api/health')
    if (!health.ok) throw new Error('bad health')
  } catch {
    console.error('✗ Dev stack not reachable on :4890 — start it first with `npm run dev:web`.')
    process.exit(1)
  }

  const server = await createServer({
    configFile: 'vite.config.ts',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    ssr: {
      // Bundle browser-only packages through Vite (monaco-editor, xterm and
      // the font CSS have no Node entry point to externalize to). React and
      // friends stay external so Node's CJS interop handles them.
      noExternal: [/^monaco-editor/, /^@monaco-editor/, /^@xterm/, /^xterm/, /^@fontsource/],
    },
  })

  let loadError = null
  try {
    await server.ssrLoadModule('/main.tsx')
  } catch (err) {
    loadError = err
  }

  const appStoreMod = await server.ssrLoadModule('/store/app.ts')
  const editorStoreMod = await server.ssrLoadModule('/store/editor.ts')
  const monacoLib = await server.ssrLoadModule('/lib/monaco.ts')
  const apiMod = await server.ssrLoadModule('/api/index.ts')
  const { useAppStore } = appStoreMod
  const { useEditorStore } = editorStoreMod

  // Wait for boot (settings + system).
  for (let i = 0; i < 40 && !useAppStore.getState().ready; i++) await sleep(250)
  // Let React settle and the initial render land.
  await sleep(1500)

  // Every launch starts empty: no folder and no file is opened automatically.
  const launchedEmpty =
    !useAppStore.getState().folder && useEditorStore.getState().groups.every((g) => g.tabs.length === 0)
  const welcomeOk = launchedEmpty && /Open Folder/.test(dom.window.document.body.textContent || '')

  // The project is opened explicitly, the way a user opens it.
  useAppStore.getState().setFolder(REPO)
  await sleep(1200)

  // Project scanning is ON DEMAND — trigger it explicitly and wait for the brief.
  const briefMod = await server.ssrLoadModule('/lib/projectBrief.ts')
  void briefMod.refreshProjectBrief()
  let brief = null
  for (let i = 0; i < 60; i++) {
    brief = useAppStore.getState().projectBrief
    if (brief?.text) break
    await sleep(250)
  }

  const text = dom.window.document.body.textContent || ''
  const html = dom.window.document.body.innerHTML || ''
  const doc = dom.window.document

  // jsdom's unimplemented canvas is a known environment limitation.
  const realErrors = jsdomErrors.filter((e) => !/Not implemented: HTMLCanvasElement/i.test(e))

  const checks = [
    ['app module loaded without errors', !loadError],
    ['title bar renders (Kineticut AI)', /Kineticut\s*AI/.test(text)],
    ['activity bar renders (5 items)', doc.querySelectorAll('.activity-item').length >= 5],
    ['launches empty: welcome screen, no folder or file opened', welcomeOk],
    ['explorer file tree renders (fs.list via API)', doc.querySelectorAll('.tree-row').length > 5],
    ['status bar shows a model from mock Ollama', /kinetic-coder:7b/.test(text)],
    ['settings loaded (theme applied)', doc.documentElement.dataset.theme === 'dark'],
    ['on-demand AI project brief generated', !!brief && brief.text.length > 20],
    [
      'accessibility: activity bar buttons have names and toggle state',
      [...doc.querySelectorAll('.activity-item')].every(
        (b) => b.getAttribute('aria-label') && b.hasAttribute('aria-pressed') === (b.getAttribute('aria-pressed') !== null),
      ) && doc.querySelectorAll('.activity-item[aria-pressed]').length >= 4,
    ],
    [
      'accessibility: status bar model chip is a keyboard-reachable button',
      [...doc.querySelectorAll('.statusbar button')].some((b) => /kinetic-coder/.test(b.getAttribute('aria-label') || '')),
    ],
    [
      'accessibility: every rendered button has an accessible name',
      [...doc.querySelectorAll('button')].filter(
        (b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'),
      ).length === 0,
    ],
  ]

  // The main-process project index backs the brief.
  let indexOk = false
  try {
    const snap = await apiMod.api.projectIndex.get(
      useAppStore.getState().folder || '/home/user/kineticut-ai',
    )
    indexOk =
      snap.fileCount > 50 &&
      Array.isArray(snap.topLevel) &&
      snap.topLevel.includes('src') &&
      snap.entries.some((e) => e.rel === 'package.json') &&
      snap.name === 'kineticut-ai'
  } catch {
    /* ignore */
  }
  checks.push(['project index snapshot works (files, key files, name)', indexOk])

  // Dual sidebars: project sidebar + AI chat sidebar visible at the same time,
  // and the same-side collision rule keeps both visible.
  let sidebarsOk = false
  try {
    useAppStore.getState().setSidebarView('chat')
    await sleep(400)
    const two = doc.querySelectorAll('.sidebar').length === 2
    const settingsMod = await server.ssrLoadModule('/store/settings.ts')
    settingsMod.useSettingsStore.getState().set('chatPosition', 'left') // collides with project side
    await sleep(400)
    sidebarsOk = two && doc.querySelectorAll('.sidebar').length === 2
  } catch {
    /* ignore */
  }
  checks.push(['project + AI chat sidebars visible simultaneously (left/right, collision-safe)', sidebarsOk])

  // Live activity: a real chat turn and an agent turn record what the assistant
  // did (phases, files read, reasoning, tool calls, timing) for the UI to show.
  let activityOk = false
  try {
    const activityLib = await server.ssrLoadModule('/lib/activity.ts')
    const aiMod = await server.ssrLoadModule('/store/ai.ts')
    const pure =
      activityLib.toolLabel('{"path":"src/a.ts"}') === 'src/a.ts' &&
      activityLib.summarizeToolResult('read_file', 'a\nb\nc', false) === '3 lines' &&
      activityLib.phaseLabel({
        ...activityLib.createActivity('m'),
        phase: 'tool',
        currentTool: { id: '1', name: 'read_file', label: 'x', startedAt: 0 },
      }) === 'Running read_file'
    const ai = aiMod.useAIStore
    ai.getState().newSession('chat')
    await ai.getState().send('why does the terminal work this way? explain your reasoning')
    const chatMsg = ai.getState().activeSession()?.messages.at(-1)
    const ca = chatMsg?.activity
    const chatOk =
      !!ca &&
      ca.phase === 'done' &&
      !chatMsg.pending &&
      !chatMsg.error &&
      ca.endedAt >= ca.startedAt &&
      ca.trail.length >= 3 &&
      ca.chars > 0 &&
      ca.contextFiles.length > 0 &&
      (chatMsg.reasoning || '').length > 0 &&
      chatMsg.content.length > 0

    ai.getState().newSession('agent')
    await ai.getState().send('read package.json and tell me what it is')
    const agentMsg = ai.getState().activeSession()?.messages.at(-1)
    const aa = agentMsg?.activity
    const agentOk =
      !!aa &&
      aa.phase === 'done' &&
      !agentMsg.pending &&
      aa.tools >= 1 &&
      aa.step >= 2 &&
      aa.touchedFiles.includes('package.json') &&
      aa.trail.some((t) => t.kind === 'tool') &&
      !agentMsg.pending
    activityOk = pure && chatOk && agentOk
    if (!activityOk) {
      console.log('  (activity debug:', JSON.stringify({ pure, chatOk, agentOk, ca: ca && { phase: ca.phase, trail: ca.trail.length, chars: ca.chars, ctx: ca.contextFiles.length }, aa: aa && { phase: aa.phase, tools: aa.tools, step: aa.step, touched: aa.touchedFiles } }).slice(0, 400), ')')
    }
  } catch (err) {
    console.log('  (activity checks error:', String(err).slice(0, 160), ')')
  }
  checks.push(['live activity: a turn records phases, files read, reasoning, tool calls & timing', activityOk])

  // Editor: one save path (write + clean + snapshot), autosave after a delay,
  // breadcrumbs and language labels.
  let editorOk = false
  const autoFile = '/home/user/kineticut-ai/.smoke-autosave.txt'
  try {
    const fsNode = await import('node:fs')
    const saveMod = await server.ssrLoadModule('/lib/saveFile.ts')
    const crumbsMod = await server.ssrLoadModule('/lib/breadcrumbs.ts')
    const langsMod = await server.ssrLoadModule('/lib/languages.ts')
    const editorMod = await server.ssrLoadModule('/store/editor.ts')
    const es = editorMod.useEditorStore
    fsNode.writeFileSync(autoFile, 'original')
    editorMod.setSnapshot(autoFile, 'original')
    es.getState().markDirty(autoFile, true)
    await saveMod.persistTab(autoFile, 'saved text')
    const manualOk =
      fsNode.readFileSync(autoFile, 'utf8') === 'saved text' &&
      !es.getState().isDirty(autoFile) &&
      editorMod.getSnapshot(autoFile) === 'saved text'
    // Autosave: the latest content is written once typing pauses.
    const fakeModel = { value: 'typed later', getValue() { return this.value }, isDisposed: () => false }
    es.getState().markDirty(autoFile, true)
    saveMod.scheduleAutoSave(autoFile, fakeModel, 150)
    await sleep(60)
    fakeModel.value = 'typed latest'
    saveMod.scheduleAutoSave(autoFile, fakeModel, 150) // restarts the timer
    await sleep(400)
    const autoOk = fsNode.readFileSync(autoFile, 'utf8') === 'typed latest' && !es.getState().isDirty(autoFile)
    const crumbs = crumbsMod.breadcrumbs('/home/user/kineticut-ai/src/renderer/App.tsx', '/home/user/kineticut-ai')
    const crumbsOk =
      crumbs.map((c) => c.label).join('/') === 'src/renderer/App.tsx' &&
      crumbs[crumbs.length - 1].isFile === true &&
      crumbs[0].path === '/home/user/kineticut-ai/src'
    editorOk = manualOk && autoOk && crumbsOk && langsMod.languageLabel('typescript') === 'TypeScript'
    if (!editorOk) console.log('  (editor debug:', JSON.stringify({ manualOk, autoOk, crumbsOk }), ')')
  } catch (err) {
    console.log('  (editor checks error:', String(err).slice(0, 200), ')')
  } finally {
    try {
      const fsNode = await import('node:fs')
      fsNode.rmSync(autoFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  checks.push(['editor: one save path, autosave after a pause, breadcrumbs & language labels', editorOk])

  // Git "Show changes": HEAD vs working file, path-safe, read-only diff modal.
  let gitShowOk = false
  const gitRoot = '/home/user/kineticut-ai'
  const gitProbe = '.smoke-gitshow.txt'
  try {
    const fsNode = await import('node:fs')
    fsNode.writeFileSync(`${gitRoot}/${gitProbe}`, 'probe line\n')
    const d = await apiMod.api.git.show(gitRoot, gitProbe)
    let escaped = false
    try {
      await apiMod.api.git.show(gitRoot, '../../etc/passwd')
    } catch {
      escaped = true
    }
    let missing = false
    try {
      await apiMod.api.git.show(gitRoot, '.smoke-does-not-exist.ts')
    } catch {
      missing = true
    }
    const gitMod = await server.ssrLoadModule('/lib/gitChanges.ts')
    await gitMod.showGitChanges(gitRoot, gitProbe)
    const req = useAppStore.getState().diffRequest
    const readOnlyOk = !!req && !req.onApply && req.title === 'New file (not in HEAD)'
    useAppStore.getState().clearDiff()
    gitShowOk =
      d.status === 'added' && d.original === '' && d.modified === 'probe line\n' && escaped && missing && readOnlyOk
    if (!gitShowOk)
      console.log('  (git debug:', JSON.stringify({ status: d.status, escaped, missing, readOnlyOk }), ')')
  } catch (err) {
    console.log('  (git checks error:', String(err).slice(0, 200), ')')
  } finally {
    try {
      const fsNode = await import('node:fs')
      fsNode.rmSync(`${gitRoot}/${gitProbe}`, { force: true })
    } catch {
      /* ignore */
    }
  }
  checks.push(['git: show changes diffs HEAD vs working file (read-only, path-safe)', gitShowOk])

  // Discoverability: shortcuts reference is derived from the live bindings.
  let shortcutsOk = false
  try {
    const kb = await server.ssrLoadModule('/lib/shortcuts.ts')
    const cmds = await server.ssrLoadModule('/commands.ts')
    const rows = kb.shortcutRows()
    const bound = cmds.KEYBINDINGS.some((b) => b.combo === 'mod+alt+/' && b.commandId === 'help.shortcuts')
    useAppStore.getState().setShortcutsOpen(true)
    const openNow = useAppStore.getState().shortcutsOpen
    useAppStore.getState().setShortcutsOpen(false)
    shortcutsOk =
      kb.formatCombo('mod+alt+l') === 'Ctrl+Alt+L' &&
      kb.formatCombo('mod+shift+p') === 'Ctrl+Shift+P' &&
      rows.some((r) => r.commandId === 'ai.focusChat' && r.combo === 'Ctrl+Alt+L') &&
      rows.length >= 10 &&
      kb.hintFor(['view.quickOpen', 'file.save']).length === 2 &&
      bound &&
      openNow === true
  } catch (err) {
    console.log('  (shortcuts checks error:', String(err).slice(0, 200), ')')
  }
  checks.push(['keyboard shortcuts reference lists live bindings (Ctrl+Alt+/)', shortcutsOk])

  // Chat ergonomics: slash commands and @file mentions are pure helpers; regenerate
  // and edit-and-resend re-run the real turn pipeline on the same session.
  let chatActionsOk = false
  try {
    const slash = await server.ssrLoadModule('/lib/slashCommands.ts')
    const mentions = await server.ssrLoadModule('/lib/mentions.ts')
    const aiStore = (await server.ssrLoadModule('/store/ai.ts')).useAIStore
    const review = slash.expandSlash('/review')
    const steps = await server.ssrLoadModule('/lib/agentSteps.ts')
    const stepsOk =
      steps.describeStep('read_file', '{"path":"a.ts","start_line":3,"end_line":9}', 'done').verb === 'Read' &&
      steps.describeStep('read_file', '{"path":"a.ts","start_line":3,"end_line":9}', 'done').detail === 'lines 3–9' &&
      steps.describeStep('run_command', '{"command":"npm test"}', 'running').verb === 'Running' &&
      steps.describeStep('edit_file', '{"path":"x.ts"}', 'done').kind === 'edit' &&
      steps.describeStep('mystery_tool', '', 'done').verb === 'mystery tool' &&
      steps.resultHint('a\nb\n') === '2 lines'
    const pureOk =
      stepsOk &&
      slash.slashQuery('/ex') === 'ex' &&
      slash.slashQuery('/explain now') === null &&
      slash.filterSlash('ex')[0]?.name === 'explain' &&
      review?.kind === 'prompt' &&
      review.needsCode === true &&
      slash.expandSlash('/review focus on auth')?.text.includes('Additional instructions: focus on auth') &&
      slash.expandSlash('/clear')?.kind === 'clear' &&
      slash.expandSlash('/nosuchcommand') === null &&
      mentions.activeMention('look at @src/ap', 16)?.query === 'src/ap' &&
      mentions.activeMention('no mention here', 10) === null &&
      mentions.insertMention('look at @src/ap', { start: 8, end: 16, query: 'src/ap' }, 'src/app.tsx').text ===
        'look at @src/app.tsx ' &&
      mentions.rankMentions({ files: ['docs/readme.md', 'src/app.tsx', 'src/apple.ts'], folders: [], symbols: [] }, 'app')[0]?.value === 'src/app.tsx'
    aiStore.getState().newSession('chat')
    await aiStore.getState().send('explain the terminal fallback in one line')
    const before = aiStore.getState().activeSession().messages
    await aiStore.getState().regenerate()
    const afterRegen = aiStore.getState().activeSession().messages
    const regenOk =
      before.length === 2 &&
      afterRegen.length === 2 &&
      afterRegen[0].content === before[0].content &&
      afterRegen[1].id !== before[1].id &&
      afterRegen[1].activity?.phase === 'done' &&
      !afterRegen[1].pending
    await aiStore.getState().editAndResend(afterRegen[0].id, 'why is the terminal fallback used? explain your reasoning')
    const edited = aiStore.getState().activeSession().messages
    const editOk =
      edited.length === 2 &&
      edited[0].content.startsWith('why is the terminal fallback used') &&
      edited[1].activity?.phase === 'done' &&
      !edited[1].pending
    chatActionsOk = pureOk && regenOk && editOk
    if (!chatActionsOk) console.log('  (chat actions debug:', JSON.stringify({ pureOk, regenOk, editOk, n: edited.length }), ')')
  } catch (err) {
    console.log('  (chat actions error:', String(err).slice(0, 200), ')')
  }
  checks.push(['chat: slash commands, @file mentions, regenerate & edit-and-resend', chatActionsOk])

  // The activity panel renders both states: live (phase, stages, reasoning,
  // files) and finished ("Worked for …" summary).
  let panelOk = false
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { ActivityPanel } = await server.ssrLoadModule('/components/ChatActivity.tsx')
    const { createActivity } = await server.ssrLoadModule('/lib/activity.ts')
    const base = createActivity('kinetic-coder:7b')
    const liveMsg = {
      id: 'live',
      role: 'assistant',
      content: '',
      pending: true,
      createdAt: Date.now(),
      reasoning: 'Let me look at the terminal code first',
      activity: {
        ...base,
        phase: 'tool',
        step: 2,
        maxSteps: 8,
        chars: 120,
        tools: 1,
        currentTool: { id: '1', name: 'read_file', label: 'src/x.ts', startedAt: Date.now() },
        contextFiles: ['src/a.ts'],
        touchedFiles: ['package.json'],
        trail: [{ at: Date.now(), text: 'Searching the project knowledge base', kind: 'info' }],
      },
    }
    const liveHtml = renderToStaticMarkup(createElement(ActivityPanel, { message: liveMsg }))
    const doneHtml = renderToStaticMarkup(
      createElement(ActivityPanel, {
        message: { ...liveMsg, pending: false, activity: { ...liveMsg.activity, phase: 'done', endedAt: Date.now() + 100 } },
      }),
    )
    panelOk =
      liveHtml.includes('Running read_file') &&
      liveHtml.includes('Thinking out loud') &&
      liveHtml.includes('src/a.ts') &&
      liveHtml.includes('package.json') &&
      liveHtml.includes('Write') &&
      doneHtml.includes('Worked for') &&
      doneHtml.includes('Reasoning') &&
      !doneHtml.includes('Thinking out loud')
  } catch (err) {
    console.log('  (activity panel render error:', String(err).slice(0, 200), ')')
  }
  checks.push(['activity panel renders live and finished states', panelOk])

  // Prescan: the AI gets a one-line understanding of every file.
  let prescanOk = false
  let retrievalOk = false
  let infraOk = false
  let mentionOk = false
  let contextBlockOk = false
  let purposeOk = false
  let metaQueryOk = false
  let recallOk = false
  let connectOk = false
  try {
    const knowledge = await server.ssrLoadModule('/lib/projectKnowledge.ts')
    await knowledge.buildUnderstanding({ maxFiles: 8 })
    for (let i = 0; i < 80; i++) {
      const ks = knowledge.useKnowledgeStore.getState()
      if (!ks.scanning && ks.total > 0 && ks.done >= ks.total) break
      await sleep(250)
    }
    const snap2 = await apiMod.api.projectIndex.get(
      useAppStore.getState().folder || '/home/user/kineticut-ai',
    )
    const entries = snap2.entries || []
    const withSummaries = entries.filter((e) => e.summary).length
    prescanOk = withSummaries >= 5 && entries.length > 50

    // Retrieval: a question about the terminal should surface terminal files.
    const hits = knowledge.retrieveRelevantFiles(entries, 'how does the terminal panel work over websocket', 5)
    // Any terminal file counts (the terminal store, its panel, or the main-process IPC).
    retrievalOk = hits.slice(0, 3).some((h) => /terminal|main\/ipc/i.test(h.entry.rel))

    if (!prescanOk || !retrievalOk) {
      const ks = knowledge.useKnowledgeStore.getState()
      console.log(
        '  debug:',
        JSON.stringify({
          status: { scanning: ks.scanning, done: ks.done, total: ks.total, summarized: ks.summarized },
          entries: entries.length,
          withSummaries,
          sampleSummary: entries.find((e) => e.summary)?.summary?.slice(0, 60),
          topHits: hits.slice(0, 4).map((h) => `${h.entry.rel} (${h.score.toFixed(1)})`),
        }),
      )
    }

    // Code profile (read from the code, not from scripts): languages and frameworks.
    const profile = knowledge.codeProfileLine(snap2)
    infraOk = /TypeScript/.test(profile) && /Electron/.test(profile)

    // Every file is retrievable from project memory, by path or by name.
    const recPath = await knowledge.recallFile(REPO, 'src/renderer/App.tsx')
    const recName = await knowledge.recallFile(REPO, 'ipc.ts')
    const recMiss = await knowledge.recallFile(REPO, 'src/does/not/exist.ts')
    // Relationships: relative imports resolve to project files (incl. .js → .ts and index files).
    const byRel = new Map(entries.map((e) => [e.rel, e]))
    connectOk =
      knowledge.resolveImport('src/renderer/App.tsx', './components/ShortcutsModal', byRel) ===
        'src/renderer/components/ShortcutsModal.tsx' &&
      knowledge.resolveImport('src/renderer/lib/x.ts', '../store/app.js', byRel) === 'src/renderer/store/app.ts' &&
      knowledge.resolveImport('src/renderer/App.tsx', 'react', byRel) === null &&
      knowledge.relationLines(entries, ['src/renderer/App.tsx']).length > 0
    recallOk =
      recPath.ok &&
      recPath.file.content.includes('export function App') &&
      recName.ok &&
      /ipc\.ts$/.test(recName.file.rel) &&
      !recMiss.ok

    // Explicit file mention resolves to that file.
    const mention = knowledge.findMentionedFile(
      'explain src/renderer/App.tsx to me',
      entries,
    )
    mentionOk = mention?.rel === 'src/renderer/App.tsx'

    // The chat context block is built from the knowledge base.
    const block = await knowledge.retrieveRelevantFilesForQuery('how does the terminal work?')
    contextBlockOk = !!block && block.includes('Relevant files')

    // The app purpose is derived in the optimized index (package.json/README, no AI).
    purposeOk = typeof snap2.purpose === 'string' && snap2.purpose.length > 20
    // "What is this app for?" gets the purpose + identity files from the index.
    const metaBlock = await knowledge.retrieveRelevantFilesForQuery(
      'what is this app for? what does it do?',
    )
    metaQueryOk =
      !!metaBlock &&
      metaBlock.includes('About the open project') &&
      /README excerpt|package\.json/.test(metaBlock)
  } catch (err) {
    console.log('  (knowledge checks error:', String(err).slice(0, 160), ')')
  }
  checks.push(['prescan gives the AI a summary of every file', prescanOk])
  checks.push(['retrieval surfaces the right files for a question', retrievalOk])
  checks.push(['code profile detected (TypeScript / Electron)', infraOk])
  checks.push(['every file retrievable from memory (by path or name, misses reported)', recallOk])
  checks.push(['connections: relative imports resolve to project files and relationships are listed', connectOk])
  checks.push(['explicit file mention resolves for content injection', mentionOk])
  checks.push(['knowledge context block built for chat prompts', contextBlockOk])
  checks.push(['project index derives the app purpose (optimized, no AI)', purposeOk])
  checks.push(['"what is this app for" gets purpose + identity files from the index', metaQueryOk])

  // Chat history: chats are tagged with their project and kept within the
  // storage budget; the History panel lists projects and chats.
  let historyOk = false
  let historyUiOk = false
  try {
    const aiHist = await server.ssrLoadModule('/store/ai.ts')
    const fake = Array.from({ length: 250 }, (_, i) => ({
      id: 's' + i,
      title: 't' + i,
      mode: 'chat',
      messages: [{ id: 'm', role: 'user', content: 'x'.repeat(2000), createdAt: i }],
      createdAt: i,
      folder: REPO,
    }))
    const kept = aiHist.trimForStorage(fake)
    aiHist.useAIStore.getState().newSession('chat')
    historyOk =
      kept.length === 200 &&
      JSON.stringify(kept).length <= 3_600_000 &&
      kept[0].folder === REPO &&
      aiHist.useAIStore.getState().activeSession()?.folder === REPO
    aiHist.useAIStore.setState({ sessions: aiHist.useAIStore.getState().sessions.slice(1) })

    useAppStore.getState().setHistoryOpen(true)
    // The modal renders on the next React commit; give it time on a busy machine.
    for (let i = 0; i < 20 && !/Chats \(\d+\)/.test(doc.body.textContent || ''); i++) await sleep(150)
    historyUiOk = /Chats \(\d+\)/.test(doc.body.textContent || '') && /Projects \(\d+\)/.test(doc.body.textContent || '')
    useAppStore.getState().setHistoryOpen(false)
  } catch (err) {
    console.log('  (history checks error:', String(err).slice(0, 160), ')')
  }
  checks.push(['history: chats tagged by project, capped to the storage budget', historyOk])
  checks.push(['history panel lists chats and projects', historyUiOk])

  // Activity bar: clicking the active view's button toggles the sidebar closed
  // (the first/files button fix); clicking again reopens it.
  let toggleOk = false
  try {
    useAppStore.getState().setSidebarView('explorer')
    const shown =
      useAppStore.getState().sidebarVisible && useAppStore.getState().sidebarView === 'explorer'
    useAppStore.getState().toggleSidebarView('explorer')
    const hiddenAfterClick = !useAppStore.getState().sidebarVisible
    useAppStore.getState().toggleSidebarView('explorer')
    const reshown = useAppStore.getState().sidebarVisible
    useAppStore.getState().toggleSidebarView('search')
    const switched =
      useAppStore.getState().sidebarVisible && useAppStore.getState().sidebarView === 'search'
    toggleOk = shown && hiddenAfterClick && reshown && switched
    useAppStore.getState().setSidebarView('explorer') // restore
  } catch {
    /* ignore */
  }
  checks.push(['activity bar: clicking the active files button toggles the sidebar', toggleOk])

  // Regression: the editor lib can create an EMPTY model before ensureModel
  // runs — ensureModel must fill it (this was the "files appear empty" bug).
  let emptyModelFilled = false
  try {
    const monaco = await server.ssrLoadModule('monaco-editor')
    const uri = monaco.Uri.file(TEST_FILE)
    monaco.editor.getModels().forEach((m) => m.dispose())
    monaco.editor.createModel('', 'json', uri) // simulate the lib's empty model
    const res = await monacoLib.ensureModel(TEST_FILE)
    emptyModelFilled = !!res.model && res.model.getValue().includes('"kineticut-ai"')
    if (!emptyModelFilled) {
      const direct = await apiMod.api.fs.read(TEST_FILE).catch((e) => ({ error: String(e) }))
      console.log(
        '  debug:',
        JSON.stringify({
          hasModel: !!res.model,
          binary: res.binary,
          len: res.model?.getValue().length,
          snapshotBefore: editorStoreMod.getSnapshot(TEST_FILE)?.length ?? null,
          directRead: direct.error
            ? { error: direct.error.slice(0, 120) }
            : { len: direct.content?.length, binary: direct.binary },
        }),
      )
    }
    res.model?.dispose()
  } catch (err) {
    console.log('  (empty-model regression check skipped:', String(err).slice(0, 200), ')')
  }
  checks.push(['ensureModel fills a pre-created empty model (empty-file regression)', emptyModelFilled])

  // Regression (found in the browser): the editor creates the file's model WHILE
  // ensureModel awaits the read. ensureModel must fill that model, not throw
  // "Cannot add model because it already exists" (which showed the file as binary).
  let raceFilled = false
  try {
    const monaco = await server.ssrLoadModule('monaco-editor')
    const uri = monaco.Uri.file(TEST_FILE)
    monaco.editor.getModels().forEach((m) => m.dispose())
    const pending = monacoLib.ensureModel(TEST_FILE)
    monaco.editor.createModel('', 'json', uri) // created after ensureModel started
    const res = await pending
    raceFilled = !!res.model && !res.binary && res.model.getValue().includes('"kineticut-ai"')
  } catch (err) {
    console.log('  (race check error:', String(err).slice(0, 200), ')')
  }
  checks.push(['ensureModel survives a model created during its read (no false binary)', raceFilled])

  // Split-editor groups: the store supports multiple groups with tabs.
  // (Store-level only — mounting a real Monaco editor needs canvas APIs that
  // jsdom does not implement; the editor itself is exercised in real browsers.)
  let groupsWork = false
  try {
    const store = useEditorStore.getState()
    const before = store.groups.length
    const newId = store.splitGroup()
    store.openTab(TEST_FILE, newId)
    const after = useEditorStore.getState()
    groupsWork =
      after.groups.length === before + 1 &&
      after.groups.find((g) => g.id === newId)?.tabs.some((t) => t.path === TEST_FILE) === true
  } catch {
    /* ignore */
  }
  checks.push(['split editor groups work (store)', groupsWork])

  // Agent exact-text edits (edit_file) and file creation (create_file): the
  // pure edit rules and the tool surface the model is offered.
  let editRulesOk = false
  try {
    const { applyTextEdit } = await server.ssrLoadModule('/lib/textEdit.ts')
    const { AGENT_TOOLS } = await server.ssrLoadModule('/ai/agent.ts')
    const names = AGENT_TOOLS.map((t) => t.name)
    const unique = applyTextEdit('a\nb\nc', 'b', 'B')
    const missing = applyTextEdit('a\nb', 'zzz', 'y')
    const ambiguous = applyTextEdit('x\nx', 'x', 'y')
    const all = applyTextEdit('x\nx', 'x', 'y', true)
    const crlf = applyTextEdit('a\r\nb\r\n', 'a\nb', 'a\nc')
    const empty = applyTextEdit('abc', '', 'y')
    const same = applyTextEdit('abc', 'b', 'b')
    editRulesOk =
      names.includes('edit_file') &&
      names.includes('create_file') &&
      unique.ok && unique.content === 'a\nB\nc' && unique.replacements === 1 &&
      !missing.ok && /not found/.test(missing.reason) &&
      !ambiguous.ok && /matches 2 places/.test(ambiguous.reason) &&
      all.ok && all.content === 'y\ny' && all.replacements === 2 &&
      crlf.ok && crlf.content === 'a\r\nc\r\n' &&
      !empty.ok && !same.ok
  } catch (err) {
    console.log('  (edit-rule check failed:', String(err).slice(0, 200), ')')
  }
  checks.push(['edit_file/create_file: exact-text edit rules + tool surface', editRulesOk])

  // Cursor-style workflow: agent checkpoints (undo a turn), project rules, and
  // inline edit (Ctrl+K). The rules are pure, so each is checked directly.
  let workflowOk = false
  try {
    const cp = await server.ssrLoadModule('/lib/checkpoints.ts')
    const rl = await server.ssrLoadModule('/lib/rules.ts')
    const ie = await server.ssrLoadModule('/lib/inlineEdit.ts')
    const cmds = await server.ssrLoadModule('/commands.ts')

    // Checkpoints: the first write keeps the original; undo restores or removes.
    let changes = cp.recordWrite([], { path: '/p/a.ts', before: 'v0', after: 'v1' }, 1)
    changes = cp.recordWrite(changes, { path: '/p/a.ts', before: 'v1', after: 'v2' }, 2)
    changes = cp.recordWrite(changes, { path: '/p/new.ts', before: null, after: 'n1' }, 3)
    const liveFiles = { '/p/a.ts': 'v2', '/p/new.ts': 'n1' }
    const plan = cp.planUndo(changes, (p) => liveFiles[p] ?? null)
    const restoreOk = plan.ops.some((o) => o.op.kind === 'restore' && o.op.path === '/p/a.ts' && o.op.content === 'v0')
    const removeOk = plan.ops.some((o) => o.op.kind === 'remove' && o.op.path === '/p/new.ts')
    // The user edits a.ts after the agent: that file is kept, not overwritten.
    const edited = cp.planUndo(changes, (p) => (p === '/p/a.ts' ? 'user edit' : liveFiles[p] ?? null))
    const keptOk = edited.kept.some((c) => c.path === '/p/a.ts') && !edited.ops.some((o) => o.change.path === '/p/a.ts')
    // Too large to store: reported as unavailable, never restored as "created".
    const big = cp.recordWrite([], { path: '/p/big.ts', before: 'x'.repeat(cp.MAX_CHECKPOINT_CHARS + 1), after: 'y' }, 4)
    const bigPlan = cp.planUndo(big, () => 'y')
    const unavailableOk = bigPlan.unavailable.length === 1 && bigPlan.ops.length === 0
    const summaryOk = cp.describeChanges(changes) === '2 files: 1 edited, 1 created'
    const hashOk = cp.hashContent('abc') === cp.hashContent('abc') && cp.hashContent('abc') !== cp.hashContent('abd')
    // Deletes: undo brings the file back only while it is still missing.
    const del = cp.recordWrite([], { path: '/p/gone.ts', before: 'keep me', after: null }, 5)
    const delPlan = cp.planUndo(del, () => null)
    const deleteOk =
      delPlan.ops.length === 1 && delPlan.ops[0].op.kind === 'restore' && delPlan.ops[0].op.content === 'keep me' &&
      cp.planUndo(del, () => 'user recreated it').kept.length === 1
    // Renames are a delete plus a create: undo removes the new name, then restores the old one.
    const moved = cp.recordWrite(
      cp.recordWrite([], { path: '/p/old.ts', before: 'body', after: null }, 6),
      { path: '/p/new.ts', before: null, after: 'body' },
      7,
    )
    const renameOk =
      cp.planUndo(moved, (p) => (p === '/p/new.ts' ? 'body' : null)).ops
        .map((o) => `${o.op.kind}:${o.op.path}`).join(',') === 'remove:/p/new.ts,restore:/p/old.ts'

    // Rules: priority order, relative paths from the index, and truncation.
    const tree = {
      name: 'p', path: '/p', type: 'directory', size: 0, mtime: 0,
      children: [
        { name: 'AGENTS.md', path: '/p/AGENTS.md', type: 'file', size: 1, mtime: 0 },
        { name: 'src', path: '/p/src', type: 'directory', size: 0, mtime: 0, children: [
          { name: 'a.ts', path: '/p/src/a.ts', type: 'file', size: 1, mtime: 0 },
        ] },
        { name: 'rules.md', path: '/p/.kineticut/rules.md', type: 'file', size: 1, mtime: 0 },
      ],
    }
    const rel = rl.relativeFilePaths(tree, '/p')
    const rulesOk =
      rel.has('src/a.ts') && rel.has('AGENTS.md') &&
      rl.pickRuleFile(rel) === '.kineticut/rules.md' &&
      rl.pickRuleFile(new Set(['AGENTS.md'])) === 'AGENTS.md' &&
      rl.pickRuleFile(new Set(['src/a.ts'])) === null &&
      rl.clampRules('a\n'.repeat(6000), 100).truncated === true &&
      rl.clampRules('short', 100).text === 'short'

    // Inline edit: the prompt carries the selection, the instruction and the rules;
    // a stale selection is never applied; context windows stay bounded.
    const msgs = ie.buildInlineEditMessages({
      instruction: 'add comments', path: '/p/a.ts', language: 'typescript',
      selection: 'const x = 1', before: 'above', after: 'below', rules: 'Project rules from AGENTS.md: be terse',
    })
    const inlineOk =
      msgs[0].role === 'system' && /Project rules from AGENTS.md/.test(msgs[0].content) &&
      /<selection>\nconst x = 1\n<\/selection>/.test(msgs[1].content) &&
      /Instruction: add comments/.test(msgs[1].content) &&
      ie.canApplyInlineEdit('same', 'same') && !ie.canApplyInlineEdit('changed', 'same') &&
      ie.contextWindow('z'.repeat(10000), 'before').length <= ie.INLINE_CONTEXT_CHARS

    const ids = cmds.COMMANDS.map((c) => c.id)
    const commandsOk = ['ai.inlineEdit', 'ai.createRules', 'ai.undoLastChanges'].every((id) => ids.includes(id))

    workflowOk = restoreOk && removeOk && keptOk && unavailableOk && summaryOk && hashOk && deleteOk && renameOk && rulesOk && inlineOk && commandsOk
    if (!workflowOk) {
      console.log('  (workflow parts:', JSON.stringify({ restoreOk, removeOk, keptOk, unavailableOk, summaryOk, hashOk, rulesOk, inlineOk, commandsOk }), ')')
    }
  } catch (err) {
    console.log('  (workflow check failed:', String(err).slice(0, 300), ')')
  }
  checks.push(['agent checkpoints undo a turn, project rules load, inline edit guards', workflowOk])

  // Batch review, mentions, next-edit and background runs: pure logic checks.
  let reviewOk = false
  try {
    const dh = await server.ssrLoadModule('/lib/diffHunks.ts')
    const mx = await server.ssrLoadModule('/lib/mentions.ts')
    const mc = await server.ssrLoadModule('/lib/mentionContext.ts')
    const ne = await server.ssrLoadModule('/lib/nextEdit.ts')
    const rv = await server.ssrLoadModule('/store/review.ts')

    // Hunks: one replaced line; accept/reject decisions rebuild exactly the chosen file.
    const h1 = dh.computeHunks('a\nb\nc', 'a\nX\nc')
    const hunksOk =
      h1.length === 1 && h1[0].oldStart === 1 && h1[0].oldLines[0] === 'b' && h1[0].newLines[0] === 'X' &&
      dh.applyHunkDecisions('a\nb\nc', h1, [true]) === 'a\nX\nc' &&
      dh.applyHunkDecisions('a\nb\nc', h1, [false]) === 'a\nb\nc' &&
      dh.computeHunks('same', 'same').length === 0 &&
      dh.computeHunks('', 'new\nfile').length === 1

    // Randomised round trip: accepting every hunk always gives the proposed file.
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const pick = () => ['a', 'b', 'c', 'd', ''][Math.floor(rnd() * 5)]
    let roundTripOk = true
    for (let i = 0; i < 300 && roundTripOk; i++) {
      const A = Array.from({ length: Math.floor(rnd() * 12) }, pick)
      const B = Array.from({ length: Math.floor(rnd() * 12) }, pick)
      const orig = A.join('\n')
      const prop = B.join('\n')
      const hs = dh.computeHunks(orig, prop)
      if (dh.applyHunkDecisions(orig, hs, hs.map(() => true)) !== prop) roundTripOk = false
      if (dh.applyHunkDecisions(orig, hs, hs.map(() => false)) !== orig) roundTripOk = false
    }

    // Staging keeps the first original and moves only the staged text.
    rv.useReviewStore.setState({ pending: {} })
    rv.useReviewStore.getState().stage({ path: '/p/x.ts', before: 'one', after: 'two', sessionId: 's', messageId: 'm' })
    rv.useReviewStore.getState().stage({ path: '/p/x.ts', before: 'two', after: 'three', sessionId: 's', messageId: 'm' })
    const staged = rv.useReviewStore.getState().pending['/p/x.ts']
    const stageOk =
      staged.original === 'one' && staged.staged === 'three' && rv.stagedContent('/p/x.ts') === 'three' &&
      staged.decisions.length === dh.computeHunks('one', 'three').length
    rv.useReviewStore.setState({ pending: {} })

    // Mentions: tokens, kinds and symbol search.
    const toks = mx.parseMentionTokens('see @src/a.ts, then @symbol:foo. and @lib/ @src/a.ts')
    const index = {
      files: ['src/a.ts', 'src/lib/b.ts'],
      folders: mx.folderCounts(['src/a.ts', 'src/lib/b.ts']),
      symbols: [{ name: 'foo', rel: 'src/a.ts' }, { name: 'fooBar', rel: 'src/lib/b.ts' }],
    }
    const ranked = mx.rankMentions(index, 'lib')
    const symRanked = mx.rankMentions(index, 'symbol:foo')
    const mentionsOk =
      toks.join('|') === 'src/a.ts|symbol:foo|lib/' &&
      mx.folderCounts(['src/a.ts', 'src/lib/b.ts']).some((d) => d.path === 'src' && d.count === 2) &&
      ranked.some((r) => r.kind === 'folder' && r.value === 'src/lib/') &&
      symRanked.every((r) => r.kind === 'symbol') && symRanked[0].value === 'symbol:foo' &&
      mx.insertMention('hi @sr', { start: 3, end: 6, query: 'sr' }, 'src/a.ts').text === 'hi @src/a.ts '

    // Definition lookup for symbol mentions.
    const defLines = ['const x = 1', 'export function render(a: number) {', '  return a', '}']
    const methodLines = ['class A {', '  async load(id: string) {', '  }', '}']
    const defOk = mc.definitionLine(defLines, 'render') === 1 && mc.definitionLine(methodLines, 'load') === 1 &&
      mc.definitionLine(defLines, 'missing') === -1

    // Next-edit: cleaning, cache, import signatures and the prompt.
    const cleanOk =
      ne.cleanCompletion('    bar\n\n', '    ') === 'bar' &&
      ne.cleanCompletion('line1\nline2\n', 'x') === 'line1\nline2' &&
      ne.cleanCompletion('x'.repeat(5000), '').length <= ne.COMPLETION_MAX_CHARS
    const cache = new ne.CompletionCache(2)
    cache.set('a', '1'); cache.set('b', '2'); cache.get('a'); cache.set('c', '3')
    const cacheOk = cache.get('a') === '1' && cache.get('b') === undefined && cache.get('c') === '3'
    const imps = ne.parseImports("import { a, b as c } from './x'\nimport d from './y'")
    const sigs = ne.signaturesOf('export function a() {\nexport const z = 1\nexport function b(x) {', ['a'])
    const nextOk =
      imps.length === 2 && imps[0].spec === './x' && imps[0].names.join(',') === 'a,b' &&
      sigs.join('|') === 'export function a()' &&
      ne.buildInlinePrompt({ path: '/p/a.ts', prefix: 'p', suffix: 's', recent: [{ line: 3, inserted: 'Q', removed: 0, at: 0 }], related: '' }).includes('<recent_edits>')

    // Background runs: per-session run map, abort per chat.
    const ai = (await server.ssrLoadModule('/store/ai.ts')).useAIStore
    const runsOk = typeof ai.getState().isRunning === 'function' && ai.getState().isRunning(null) === false &&
      typeof ai.getState().stop === 'function'

    reviewOk = hunksOk && roundTripOk && stageOk && mentionsOk && defOk && cleanOk && cacheOk && nextOk && runsOk
    if (!reviewOk) {
      console.log('  (review parts:', JSON.stringify({ hunksOk, roundTripOk, stageOk, mentionsOk, defOk, cleanOk, cacheOk, nextOk, runsOk }), ')')
    }
  } catch (err) {
    console.log('  (review check failed:', String(err).slice(0, 300), ')')
  }
  checks.push(['batch review, mentions, next-edit and background runs', reviewOk])

  // Codebase index (Cursor-style): lexical search with no AI call, optional
  // embeddings stored per model, and Cursor rules. Restart persistence is in smoke-codebase.mjs.
  let codebaseOk = false
  try {
    const { pathToFileURL } = await import('node:url')
    const fs = (await import('node:fs')).promises
    const os = await import('node:os')
    const path = await import('node:path')
    const ci = await import(pathToFileURL(path.resolve('src/shared/codebaseIndex.mjs')).href)
    const rl = await server.ssrLoadModule('/lib/rules.ts')
    const root = path.resolve('.')
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'dist-web'])
    const walk = async (dir, out = []) => {
      for (const d of await fs.readdir(dir, { withFileTypes: true })) {
        if (SKIP.has(d.name)) continue
        const p = path.join(dir, d.name)
        if (d.isDirectory()) await walk(p, out)
        else if (/\.(ts|tsx|mjs)$/.test(d.name)) out.push(p)
      }
      return out
    }
    const projectIndex = {
      async snapshot(r) {
        const entries = []
        for (const f of await walk(r)) {
          const st = await fs.stat(f)
          entries.push({ path: f, rel: path.relative(r, f), size: st.size, mtime: st.mtimeMs })
        }
        return { entries }
      },
      async file(r, rel) {
        return { content: await fs.readFile(path.join(r, rel), 'utf8'), binary: false }
      },
    }
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-smoke-cb-'))
    const idx = ci.createCodebaseIndex({ cacheDir, projectIndex })
    await idx.build(root, { force: true })
    const lex = await idx.search(root, 'persist vectors serialise Map', { k: 3 })
    const lexicalOk = lex.hits.length > 0 && lex.hits[0].rel === 'src/shared/codebaseIndex.mjs' && lex.semantic === false

    // Embeddings: a stand-in vector per chunk, stored for one model only.
    const DIM = 8
    const embed = (t) => {
      const v = new Array(DIM).fill(0)
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        let h = 0
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0
        v[h % DIM]++
      }
      const n = Math.hypot(...v) || 1
      return v.map((x) => x / n)
    }
    const pend = await idx.pending(root, { model: 'smoke-embed', limit: 100000 })
    const stored = await idx.setVectors(root, {
      model: 'smoke-embed',
      items: pend.items.map((c) => ({ id: c.id, hash: c.hash, vector: embed(c.text) })),
    })
    const semanticOk =
      stored.stored === pend.total &&
      (await idx.search(root, 'persist', { k: 3, queryVector: embed('persist'), model: 'smoke-embed' })).semantic === true &&
      (await idx.search(root, 'persist', { k: 3, queryVector: embed('persist'), model: 'other-model' })).semantic === false

    // Cursor rules: frontmatter, glob matching against the open file, and always-on rules.
    const ruleA = rl.parseCursorRule('.cursor/rules/ts.mdc', '---\ndescription: TS style\nglobs: src/**/*.ts, *.tsx\nalwaysApply: false\n---\nUse const.\n')
    const ruleB = rl.parseCursorRule('.cursor/rules/all.mdc', '---\nalwaysApply: true\n---\nBe terse.')
    const ruleC = rl.parseCursorRule('.cursor/rules/ask.mdc', '---\ndescription: How to add a route\n---\nSteps.')
    const globOk = rl.globToRegExp('src/**/*.ts').test('src/a/b.ts') && !rl.globToRegExp('src/**/*.ts').test('lib/x.ts') && rl.globToRegExp('*.tsx').test('a.tsx') && !rl.globToRegExp('*.tsx').test('x/a.tsx')
    const ruleSel = rl.rulesFor([ruleA, ruleB, ruleC], 'src/app/main.ts')
    const ruleSelOther = rl.rulesFor([ruleA, ruleB, ruleC], 'docs/readme.md')
    const rulesCursorOk =
      ruleA.globs.length === 2 && ruleB.alwaysApply && ruleA.body === 'Use const.' && globOk &&
      ruleSel.always.map((r) => r.path).join() === '.cursor/rules/ts.mdc,.cursor/rules/all.mdc' &&
      ruleSel.requested.map((r) => r.path).join() === '.cursor/rules/ask.mdc' &&
      ruleSelOther.always.map((r) => r.path).join() === '.cursor/rules/all.mdc'

    // Agent tools match Cursor's set: semantic, grep and file search, plus read_file ranges.
    const agentMod = await server.ssrLoadModule('/ai/agent.ts')
    const toolNames = agentMod.AGENT_TOOLS.map((t) => t.name)
    const toolsOk =
      ['codebase_search', 'grep_search', 'file_search', 'read_file'].every((n) => toolNames.includes(n)) &&
      !toolNames.includes('search_code') &&
      ['delete_file', 'rename_file'].every((n) => toolNames.includes(n))

    // File search ranks exact and prefix name matches above fuzzy ones.
    const scoreOk =
      agentMod.fileNameScore('codebase', 'src/lib/codebase.ts') > agentMod.fileNameScore('codebase', 'src/lib/recodebase.ts') &&
      agentMod.fileNameScore('agnt', 'src/ai/agent.ts') > 0 &&
      agentMod.fileNameScore('zzz', 'src/ai/agent.ts') === 0

    // Embedding models are found by name and kept out of the chat model choices.
    const em = await server.ssrLoadModule('/lib/embeddingModels.ts')
    const embedOk =
      em.pickEmbeddingModel(['llama3:8b', 'nomic-embed-text:latest', 'bge-m3']) === 'nomic-embed-text:latest' &&
      em.pickEmbeddingModel(['llama3:8b']) === null &&
      em.isEmbeddingModel('mxbai-embed-large') && !em.isEmbeddingModel('llama3:8b')

    // Automatic detection: the mock Ollama lists an embedding model, so search by meaning is on by default.
    const cb = await server.ssrLoadModule('/lib/codebase.ts')
    const detected = await cb.detectEmbeddingModel(true)
    const autoOk = detected === 'nomic-embed-text:latest'

    // Agent mode gets no pre-injected snippets: the agent searches with its tools.
    const cc = await server.ssrLoadModule('/lib/cursorContext.ts')
    const agentCtx = await cc.cursorContextFor(path.resolve('.'), 'how is the codebase index built', { retrieve: false })
    const chatCtx = await cc.cursorContextFor(path.resolve('.'), 'how is the codebase index built', { retrieve: true })
    const retrievalOk = agentCtx.files.length === 0 && !/Relevant code from the codebase index/.test(agentCtx.block ?? '') && chatCtx.files.length > 0

    codebaseOk = lexicalOk && semanticOk && rulesCursorOk && toolsOk && scoreOk && embedOk && autoOk && retrievalOk
    if (!codebaseOk) console.log('  (auto/retrieval:', JSON.stringify({ autoOk, retrievalOk, detected }), ')')
    if (!codebaseOk) {
      console.log('  (codebase parts:', JSON.stringify({ lexicalOk, semanticOk, rulesCursorOk, toolsOk, scoreOk, embedOk }), ')')
    }
  } catch (err) {
    console.log('  (codebase check failed:', String(err).slice(0, 300), ')')
  }
  checks.push(['codebase index: search, embeddings, cursor rules, agent search tools', codebaseOk])

  if (monacoWorkerNoise) console.log(`  (ignored ${monacoWorkerNoise} jsdom timer error(s) raised inside monaco-editor)`)
  checks.push(['no runtime errors', realErrors.length === 0])

  let failed = 0
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed++
  }
  if (loadError) {
    console.log('\nload error:')
    console.error(loadError)
  }
  if (realErrors.length > 0) {
    console.log('\ncaptured errors:')
    for (const e of realErrors.slice(0, 5)) console.log('  -', e)
  }
  console.log(`\nrendered DOM size: ${(html.length / 1024).toFixed(0)} kB`)
  console.log(failed === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failed} checks)`)
  await server.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
