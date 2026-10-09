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
import { createCodebaseIndex } from '../src/shared/codebaseIndex.mjs'

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

await fs.rm(cacheDir, { recursive: true, force: true })
const failed = checks.filter(([, ok]) => !ok)
console.log(failed.length ? `\nFAILED (${failed.length})` : '\nCODEBASE SMOKE PASSED')
process.exit(failed.length ? 1 : 0)
