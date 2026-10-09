/**
 * Codebase index smoke test, plain Node (no browser). Checks the lexical search
 * on this repository, that stored embeddings survive a restart from disk, and
 * that vectors for a different model are ignored.
 *
 *   node scripts/smoke-codebase.mjs
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCodebaseIndex, chunkText } from '../src/shared/codebaseIndex.mjs'
import { scanProject } from '../src/shared/projectMemory.mjs'
import http from 'node:http'
import { fetchPageText, htmlToText, searchWeb } from '../src/shared/webFetch.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-web', 'out', 'build'])

async function walk(dir, out = []) {
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

const DIM = 8
function embed(text) {
  const v = new Array(DIM).fill(0)
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 0
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0
    v[h % DIM]++
  }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-codebase-'))
const checks = []
const check = (name, ok) => {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}

const idx = createCodebaseIndex({ cacheDir, projectIndex })
await idx.build(root, { force: true })

const lex = await idx.search(root, 'persist vectors serialise Map', { k: 3 })
check('lexical search ranks the index module first, with no AI call', lex.hits[0]?.rel === 'src/shared/codebaseIndex.mjs' && lex.semantic === false)

const pend = await idx.pending(root, { model: 'smoke-embed', limit: 100000 })
const stored = await idx.setVectors(root, {
  model: 'smoke-embed',
  items: pend.items.map((c) => ({ id: c.id, hash: c.hash, vector: embed(c.text) })),
})
check('embeddings are stored per chunk', stored.stored === pend.total && pend.total > 0)
const sem = await idx.search(root, 'persist', { k: 3, queryVector: embed('persist'), model: 'smoke-embed' })
const other = await idx.search(root, 'persist', { k: 3, queryVector: embed('persist'), model: 'other-model' })
check('hybrid search uses vectors only for the matching model', sem.semantic === true && other.semantic === false)

// The debounced persist runs after ~1.5s; wait for it, then reload from disk.
await new Promise((r) => setTimeout(r, 2500))
const reloaded = createCodebaseIndex({ cacheDir, projectIndex })
const after = await reloaded.search(root, 'persist', { k: 3, queryVector: embed('persist'), model: 'smoke-embed' })
check('stored embeddings survive a restart', after.semantic === true)

// Ignore rules: .gitignore and .cursorignore keep files out of the scan and the index.
const ignoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-ignore-'))
await fs.mkdir(path.join(ignoreRoot, 'secret'), { recursive: true })
await fs.mkdir(path.join(ignoreRoot, 'src'), { recursive: true })
await fs.writeFile(path.join(ignoreRoot, '.gitignore'), 'secret/\n*.log\n')
await fs.writeFile(path.join(ignoreRoot, '.cursorignore'), 'src/private.ts\n')
await fs.writeFile(path.join(ignoreRoot, 'secret', 'key.ts'), 'export const key = 1\n')
await fs.writeFile(path.join(ignoreRoot, 'debug.log'), 'noise\n')
await fs.writeFile(path.join(ignoreRoot, 'src', 'private.ts'), 'export const hidden = 2\n')
await fs.writeFile(path.join(ignoreRoot, 'src', 'public.ts'), 'export function visible() { return 3 }\n')
const scanned = await scanProject(ignoreRoot)
const scannedRels = [...scanned.files.keys()].sort()
check('.gitignore and .cursorignore exclude files from the scan', JSON.stringify(scannedRels) === JSON.stringify(['.cursorignore', '.gitignore', 'src/public.ts']))
// The index is fed by the real scanner, as in the app, so the same rules apply.
const realProjectIndex = {
  async snapshot(r) {
    const s = await scanProject(r)
    return { entries: [...s.files.values()].map((rec) => ({ path: rec.path, rel: rec.rel, size: rec.size, mtime: rec.mtime })) }
  },
  async file(r, rel) {
    return { content: await fs.readFile(path.join(r, rel), 'utf8'), binary: false }
  },
}
const ignoreIdx = createCodebaseIndex({ cacheDir: await fs.mkdtemp(path.join(os.tmpdir(), 'kc-ignore-cache-')), projectIndex: realProjectIndex })
await ignoreIdx.build(ignoreRoot, { force: true })
const leak = await ignoreIdx.search(ignoreRoot, 'hidden key', { k: 5 })
const visible = await ignoreIdx.search(ignoreRoot, 'visible return', { k: 5 })
check('ignored files never appear in search results', leak.hits.length === 0 && visible.hits.some((h) => h.rel === 'src/public.ts'))
await fs.rm(ignoreRoot, { recursive: true, force: true })

// Content hashes: touching a file without changing its text re-chunks nothing.
const touchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-touch-'))
await fs.writeFile(path.join(touchRoot, 'a.ts'), 'export function one() {\n  return 1\n}\n')
const touchIdx = createCodebaseIndex({ cacheDir: await fs.mkdtemp(path.join(os.tmpdir(), 'kc-touch-cache-')), projectIndex })
await touchIdx.build(touchRoot, { force: true })
const later = new Date(Date.now() + 60_000)
await fs.utimes(path.join(touchRoot, 'a.ts'), later, later)
const touched = await touchIdx.build(touchRoot, { force: true })
check('a save with the same text re-chunks nothing', touched.changed === 0)
await fs.writeFile(path.join(touchRoot, 'a.ts'), 'export function one() {\n  return 2\n}\n')
const edited = await touchIdx.build(touchRoot, { force: true })
check('a real edit re-chunks the file', edited.changed === 1)
await fs.rm(touchRoot, { recursive: true, force: true })

// Syntax-aware chunks: declarations stay whole and carry their name.
const sample = 'import x from "y"\n\n// adds two numbers\nexport function add(a, b) {\n  return a + b\n}\n\nexport class Box {\n  get() {\n    return 1\n  }\n}\n'
const sampleChunks = chunkText(sample)
check('chunks start at declarations and carry the symbol', sampleChunks.some((c) => c.symbol === 'add') && sampleChunks.every((c) => c.endLine - c.startLine < 60))

// Web pages for the agent: HTML becomes text, scripts are dropped, only http(s) is read.
const html = htmlToText('<html><head><title>Docs &amp; Guide</title><script>var x = 1</script></head><body><h1>Install</h1><p>Run&nbsp;npm&nbsp;ci</p></body></html>')
check('html becomes text: title, entities, no scripts', html.title === 'Docs & Guide' && html.text.includes('Install') && html.text.includes('Run npm ci') && !html.text.includes('var x'))
const pageServer = http.createServer((req, res) => {
  if (req.url === '/doc') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<title>API</title><p>fetch(url) returns a Response.</p>')
  } else if (req.url === '/image') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end('x')
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('missing')
  }
})
await new Promise((r) => pageServer.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${pageServer.address().port}`
const page = await fetchPageText(`${base}/doc`)
check('fetchPageText reads an html page as text', page.status === 200 && page.title === 'API' && page.text.includes('returns a Response'))
const refused = await fetchPageText('file:///etc/passwd').then(() => 'read', (e) => e.message)
check('non-http schemes are refused', /Only http and https/.test(refused))
const notText = await fetchPageText(`${base}/image`).then(() => 'read', (e) => e.message)
check('binary responses are refused', /Not a text page/.test(notText))
const missing = await fetchPageText(`${base}/nope`).then(() => 'read', (e) => e.message)
check('HTTP errors are reported', missing === 'HTTP 404 Not Found')
pageServer.close()

// Web search: the key goes in a header, results are cleaned and capped.
let seen = null
const searchServer = http.createServer((req, res) => {
  seen = { url: req.url, key: req.headers['x-subscription-token'] }
  if (req.headers['x-subscription-token'] === 'bad') {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end('{}')
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  const results = Array.from({ length: 8 }, (_, i) => ({
    title: `<strong>Result</strong> ${i}`,
    url: `https://example.com/${i}`,
    description: `Snippet <b>${i}</b>`,
  }))
  res.end(JSON.stringify({ web: { results } }))
})
await new Promise((r) => searchServer.listen(0, '127.0.0.1', r))
const searchBase = `http://127.0.0.1:${searchServer.address().port}/search`
const found = await searchWeb('vite preview', 'key-123', { baseUrl: searchBase, count: 3 })
check('web search: sends the query and key, returns cleaned results', seen.url.includes('q=vite+preview') && seen.key === 'key-123' && found.length === 3 && found[0].title === 'Result 0' && found[0].description === 'Snippet 0')
const noKey = await searchWeb('x', null, { baseUrl: searchBase }).then(() => 'ran', (e) => e.message)
check('web search: says so when no key is set', /No web search key is set/.test(noKey))
const refusedKey = await searchWeb('x', 'bad', { baseUrl: searchBase }).then(() => 'ran', (e) => e.message)
check('web search: a refused key gets a readable error', /key was refused/.test(refusedKey))
searchServer.close()

await fs.rm(cacheDir, { recursive: true, force: true })
const failed = checks.filter(([, ok]) => !ok)
console.log(failed.length ? `\nFAILED (${failed.length})` : '\nCODEBASE SMOKE PASSED')
process.exit(failed.length ? 1 : 0)
