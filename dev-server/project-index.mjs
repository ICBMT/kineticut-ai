/**
 * Incremental project index + knowledge base for the dev server — mirrors
 * the Electron main process implementation (src/main/projectIndex.ts) so the
 * browser preview behaves identically: chunked scan, per-file metadata (via
 * the JS port of shared/fileMeta), disk cache, chokidar incremental updates,
 * and AI summary storage.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import chokidar from 'chokidar'
import { simpleGit } from 'simple-git'
import { extractFileMeta, isTextLike } from './file-meta.mjs'
import { derivePurpose } from './purpose.mjs'

const KEY_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'Dockerfile',
  'docker-compose.yml',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'Makefile',
])
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.idea',
  'release',
])
const MAX_FILES = 20000
const MAX_KEY_FILE_BYTES = 20000
const MAX_TREE_PATHS = 150
const MAX_META_BYTES = 16384

const indexes = new Map()

function cacheFile(root) {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12)
  return join(homedir(), `.kineticut-project-index-${hash}.json`)
}

const yieldToEventLoop = () => new Promise((r) => setImmediate(r))

async function readKeyExcerpt(path) {
  try {
    const buf = await fs.readFile(path)
    if (buf.length === 0 || buf.length > MAX_KEY_FILE_BYTES) return null
    const len = Math.min(buf.length, 4000)
    for (let i = 0; i < len; i++) if (buf[i] === 0) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

async function buildEntry(path, rel, size, mtime) {
  const entry = { path, rel, size, mtime, language: 'plaintext', symbols: [], imports: [] }
  try {
    entry.language = extractFileMeta(rel, '').language
    if (size > 0 && size <= MAX_META_BYTES && isTextLike(rel)) {
      const buf = await fs.readFile(path)
      if (!buf.includes(0)) {
        const full = extractFileMeta(rel, buf.toString('utf8'))
        entry.language = full.language
        entry.symbols = full.symbols
        entry.imports = full.imports
      }
    }
  } catch {}
  return entry
}

function isKeyFileName(name) {
  return KEY_FILES.has(name) || /^readme/i.test(name)
}

async function scan(state) {
  const { root } = state
  // Always start from a clean slate (the state may hold a persisted index).
  state.files = []
  state.byRel.clear()
  state.keyFiles = {}
  state.topLevel = []
  const queue = [root]
  let count = 0
  while (queue.length > 0) {
    const dir = queue.shift()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (dir === root) state.topLevel = entries.map((e) => e.name).sort()
    for (const entry of entries) {
      const p = join(dir, entry.name)
      const rel = relative(root, p)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(p)
        continue
      }
      if (!entry.isFile()) continue
      count++
      if (count > MAX_FILES) {
        queue.length = 0
        break
      }
      let size = 0
      let mtime = 0
      try {
        const st = await fs.stat(p)
        size = st.size
        mtime = st.mtimeMs
      } catch {}
      const file = await buildEntry(p, rel, size, mtime)
      state.files.push(file)
      state.byRel.set(rel, file)
      if (dir === root && isKeyFileName(entry.name)) {
        const excerpt = await readKeyExcerpt(p)
        if (excerpt) state.keyFiles[entry.name] = excerpt
      }
      if (count % 100 === 0) await yieldToEventLoop()
    }
  }
  state.scannedAt = Date.now()
}

async function persist(state) {
  try {
    await fs.writeFile(
      cacheFile(state.root),
      JSON.stringify({
        root: state.root,
        files: state.files,
        topLevel: state.topLevel,
        keyFiles: state.keyFiles,
        scannedAt: state.scannedAt,
      }),
    )
  } catch {}
}

function schedulePersist(state) {
  if (state.persistTimer) clearTimeout(state.persistTimer)
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null
    void persist(state)
  }, 2000)
}

async function loadPersisted(root) {
  try {
    const raw = await fs.readFile(cacheFile(root), 'utf8')
    const data = JSON.parse(raw)
    if (!data || data.root !== root || !Array.isArray(data.files)) return null
    return {
      root,
      files: data.files,
      byRel: new Map(data.files.map((f) => [f.rel, f])),
      topLevel: data.topLevel || [],
      keyFiles: data.keyFiles || {},
      scannedAt: data.scannedAt || 0,
      watcher: null,
      persistTimer: null,
      scanning: null,
    }
  } catch {
    return null
  }
}

function startWatching(state) {
  if (state.watcher) return
  try {
    state.watcher = chokidar.watch(state.root, {
      ignoreInitial: true,
      depth: 24,
      ignored: (p) => SKIP_DIRS.has(p.split(/[/\\]/).pop() || ''),
    })
    const upsert = async (p) => {
      const rel = relative(state.root, p)
      try {
        const st = await fs.stat(p)
        if (!st.isFile()) return
        const prev = state.byRel.get(rel)
        const file = await buildEntry(p, rel, st.size, st.mtimeMs)
        if (prev?.summary && prev.summaryAt && prev.mtime === st.mtimeMs) {
          file.summary = prev.summary
          file.summaryAt = prev.summaryAt
        }
        state.byRel.set(rel, file)
        if (prev) {
          const idx = state.files.findIndex((f) => f.rel === rel)
          if (idx >= 0) state.files[idx] = file
        } else {
          state.files.push(file)
        }
        if (rel.indexOf('/') < 0 && isKeyFileName(basename(p))) {
          const excerpt = await readKeyExcerpt(p)
          if (excerpt) state.keyFiles[basename(p)] = excerpt
          else delete state.keyFiles[basename(p)]
        }
        schedulePersist(state)
      } catch {}
    }
    const remove = (p) => {
      const rel = relative(state.root, p)
      state.byRel.delete(rel)
      state.files = state.files.filter((f) => f.rel !== rel)
      if (rel.indexOf('/') < 0) delete state.keyFiles[basename(p)]
      schedulePersist(state)
    }
    state.watcher.on('add', (p) => void upsert(p))
    state.watcher.on('change', (p) => void upsert(p))
    state.watcher.on('unlink', (p) => remove(p))
  } catch {}
}

async function getState(root) {
  const existing = indexes.get(root)
  if (existing) return existing
  const loaded = await loadPersisted(root)
  const state = loaded || {
    root,
    files: [],
    byRel: new Map(),
    topLevel: [],
    keyFiles: {},
    scannedAt: 0,
    watcher: null,
    persistTimer: null,
    scanning: null,
  }
  indexes.set(root, state)
  const newestMtime = state.files.reduce((max, f) => Math.max(max, f.mtime), 0)
  const stale =
    !loaded ||
    state.files.length === 0 ||
    state.files.length !== state.byRel.size ||
    newestMtime > state.scannedAt
  if (stale) {
    state.scanning = scan(state)
      .then(() => schedulePersist(state))
      .catch(() => {})
    await state.scanning
  }
  startWatching(state)
  return state
}

export async function projectIndexSnapshot(root) {
  const state = await getState(root)
  let packageJson
  const pj = state.keyFiles['package.json']
  if (pj) {
    try {
      packageJson = JSON.parse(pj)
    } catch {}
  }
  const readmeName = Object.keys(state.keyFiles).find((k) => /^readme/i.test(k))
  const readme = readmeName ? state.keyFiles[readmeName] : undefined
  let gitBranch = null
  try {
    gitBranch = (await simpleGit(root).status()).current
  } catch {}
  const treePaths = state.files
    .map((f) => f.rel)
    .sort((a, b) => {
      const da = a.split('/').length
      const db = b.split('/').length
      return da - db || a.localeCompare(b)
    })
    .slice(0, MAX_TREE_PATHS)
  return {
    folder: root,
    name: packageJson?.name || basename(root),
    fileCount: state.files.length,
    topLevel: state.topLevel,
    treePaths,
    keyFiles: state.keyFiles,
    packageJson,
    readme: readme?.slice(0, 2000),
    purpose: derivePurpose(packageJson, readme),
    gitBranch,
    scannedAt: state.scannedAt || Date.now(),
    entries: state.files,
  }
}

export async function setFileSummaries(root, items) {
  const state = indexes.get(root)
  if (!state) return
  for (const item of items) {
    const entry = state.byRel.get(item.rel)
    if (entry) {
      entry.summary = item.summary
      entry.summaryAt = item.summaryAt
    }
  }
  schedulePersist(state)
}

export async function rescanProjectIndex(root) {
  const state = indexes.get(root)
  if (state) {
    state.files = []
    state.byRel.clear()
    state.keyFiles = {}
    state.topLevel = []
    state.scanning = scan(state)
      .then(() => schedulePersist(state))
      .catch(() => {})
    await state.scanning
  }
  return projectIndexSnapshot(root)
}
