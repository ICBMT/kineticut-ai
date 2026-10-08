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

  // Wait for boot (settings + system + folder restore).
  for (let i = 0; i < 40 && !useAppStore.getState().ready; i++) await sleep(250)
  // Let React settle and the initial render land.
  await sleep(1500)

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
    ['welcome screen renders (Open Folder)', /Open Folder/.test(text)],
    ['explorer file tree renders (fs.list via API)', doc.querySelectorAll('.tree-row').length > 5],
    ['status bar shows a model from mock Ollama', /kinetic-coder:7b/.test(text)],
    ['settings loaded (theme applied)', doc.documentElement.dataset.theme === 'dark'],
    ['on-demand AI project brief generated', !!brief && brief.text.length > 20],
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
      !!snap.keyFiles['package.json'] &&
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
  try {
    const knowledge = await server.ssrLoadModule('/lib/projectKnowledge.ts')
    await knowledge.prescanProject({ maxFiles: 8 })
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
    retrievalOk = hits.slice(0, 3).some((h) => /TerminalPanel|main\/ipc/.test(h.entry.rel))

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

    // Infrastructure detection: stack + package manager.
    const infra = knowledge.detectInfra(snap2)
    infraOk =
      infra.stack.includes('TypeScript') &&
      infra.stack.includes('Electron') &&
      infra.packageManager === 'npm'

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
  checks.push(['infrastructure detected (TypeScript / Electron / npm)', infraOk])
  checks.push(['explicit file mention resolves for content injection', mentionOk])
  checks.push(['knowledge context block built for chat prompts', contextBlockOk])
  checks.push(['project index derives the app purpose (optimized, no AI)', purposeOk])
  checks.push(['"what is this app for" gets purpose + identity files from the index', metaQueryOk])

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
