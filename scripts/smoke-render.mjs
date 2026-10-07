#!/usr/bin/env node
/**
 * Runtime smoke test: actually RENDER the app headlessly.
 *
 * Loads the real renderer entry (src/renderer/main.tsx) through Vite's SSR
 * module runner inside a jsdom window, with relative fetches pointed at the
 * dev API server — so the full boot path runs (settings → providers → mock
 * Ollama → folder open → file tree → git status) and React renders the shell.
 *
 * Prerequisites: `npm run dev:web` must be running (API on :4890, mock
 * Ollama on :11434).
 *
 *   npm run smoke
 */
import { createServer } from 'vite'
import { JSDOM, VirtualConsole } from 'jsdom'

const API = 'http://127.0.0.1:4890'

/* ------------------------------ jsdom globals ------------------------------ */

const virtualConsole = new VirtualConsole()
const jsdomErrors = []
virtualConsole.on('jsdomError', (e) => {
  const msg = String(e?.message || e)
  if (/css|Could not load/i.test(msg)) return
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
  const url =
    typeof input === 'string' && input.startsWith('/') ? API + input : input
  return realFetch(url, init)
}
dom.window.fetch = g.fetch

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
      noExternal: [
        /^monaco-editor/,
        /^@monaco-editor/,
        /^@xterm/,
        /^xterm/,
        /^@fontsource/,
      ],
    },
  })

  try {
    await server.ssrLoadModule('/main.tsx')
  } catch (err) {
    console.error('✗ Failed to load the app:')
    console.error(err)
    process.exit(1)
  }

  // Let boot + React settle.
  await new Promise((r) => setTimeout(r, 3000))

  const text = dom.window.document.body.textContent || ''
  const html = dom.window.document.body.innerHTML || ''
  const doc = dom.window.document

  // jsdom's unimplemented canvas is a known environment limitation.
  const realErrors = jsdomErrors.filter((e) => !/Not implemented: HTMLCanvasElement/i.test(e))

  const checks = [
    ['title bar renders (Kineticut AI)', /Kineticut\s*AI/.test(text)],
    [
      'activity bar renders (5 items)',
      doc.querySelectorAll('.activity-item').length >= 5,
    ],
    ['welcome screen renders (Open Folder)', /Open Folder/.test(text)],
    ['explorer file tree renders (fs.list via API)', doc.querySelectorAll('.tree-row').length > 5],
    ['status bar shows a model from mock Ollama', /kinetic-coder:7b/.test(text)],
    ['settings loaded (theme applied)', doc.documentElement.dataset.theme === 'dark'],
    ['no runtime errors', realErrors.length === 0],
  ]

  let failed = 0
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed++
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
