/**
 * Incremental project index + knowledge base (main process).
 *
 * A persistent, incrementally-maintained index of a workspace. Each indexed
 * file carries lightweight metadata (language, declared symbols, imports —
 * extracted by the shared fileMeta module, so any code type is understood)
 * plus an optional AI-generated one-line summary written back by the
 * renderer's prescan. Built with chunked async scans so the main process
 * stays responsive, persisted to userData so restarts load instantly, and
 * kept fresh by a chokidar watcher.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join, relative } from 'node:path'
import chokidar from 'chokidar'
import { simpleGit } from 'simple-git'
import { extractFileMeta, isTextLike } from '../shared/fileMeta'
import { derivePurpose } from '../shared/purpose'
import type { ProjectIndexEntry, ProjectIndexSnapshot } from '../shared/types'

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
/** Files up to this size get full metadata extraction during the scan. */
const MAX_META_BYTES = 16384

interface IndexedFile extends ProjectIndexEntry {}

interface IndexState {
  root: string
  files: IndexedFile[]
  byRel: Map<string, IndexedFile>
  topLevel: string[]
  keyFiles: Record<string, string>
  scannedAt: number
  watcher: chokidar.FSWatcher | null
  persistTimer: NodeJS.Timeout | null
  scanning: Promise<void> | null
}

const indexes = new Map<string, IndexState>()

function cacheFile(root: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), `project-index-${hash}.json`)
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r))

async function readKeyExcerpt(path: string): Promise<string | null> {
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

/** Read + extract metadata for a file (capped; binaries skipped). */
async function buildEntry(path: string, rel: string, size: number, mtime: number): Promise<IndexedFile> {
  const entry: IndexedFile = {
    path,
    rel,
    size,
    mtime,
    language: 'plaintext',
    symbols: [],
    imports: [],
  }
  try {
    const meta = extractFileMeta(rel, '')
    entry.language = meta.language
    if (size > 0 && size <= MAX_META_BYTES && isTextLike(rel)) {
      const buf = await fs.readFile(path)
      if (!buf.includes(0)) {
        const full = extractFileMeta(rel, buf.toString('utf8'))
        entry.language = full.language
        entry.symbols = full.symbols
        entry.imports = full.imports
      }
    }
  } catch {
    /* keep defaults */
  }
  return entry
}

function isKeyFileName(name: string): boolean {
  return KEY_FILES.has(name) || /^readme/i.test(name)
}

/** Chunked breadth-first scan; yields to the event loop every 100 files. */
async function scan(state: IndexState): Promise<void> {
  const { root } = state
  // Always start from a clean slate (the state may hold a persisted index).
  state.files = []
  state.byRel.clear()
  state.keyFiles = {}
  state.topLevel = []
  const queue: string[] = [root]
  let count = 0
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries: Dirent[]
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
      } catch {
        /* ignore */
      }
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

async function persist(state: IndexState): Promise<void> {
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
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
  } catch {
    /* ignore */
  }
}

function schedulePersist(state: IndexState): void {
  if (state.persistTimer) clearTimeout(state.persistTimer)
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null
    void persist(state)
  }, 2000)
}

async function loadPersisted(root: string): Promise<IndexState | null> {
  try {
    const raw = await fs.readFile(cacheFile(root), 'utf8')
    const data = JSON.parse(raw)
    if (!data || data.root !== root || !Array.isArray(data.files)) return null
    return {
      root,
      files: data.files,
      byRel: new Map<string, IndexedFile>(data.files.map((f: IndexedFile) => [f.rel, f])),
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

function startWatching(state: IndexState): void {
  if (state.watcher) return
  try {
    state.watcher = chokidar.watch(state.root, {
      ignoreInitial: true,
      depth: 24,
      ignored: (p: string) => SKIP_DIRS.has(p.split(/[/\\]/).pop() || ''),
    })
    const upsert = async (p: string) => {
      const rel = relative(state.root, p)
      try {
        const st = await fs.stat(p)
        if (!st.isFile()) return
        // Preserve any existing summary when the file content is unchanged.
        const file = await buildEntry(p, rel, st.size, st.mtimeMs)
        // Read `prev` AFTER the await: two watcher events (add + change) for the
        // same file can race here, and reading earlier pushed the file twice.
        const prev = state.byRel.get(rel)
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
      } catch {
        /* ignore */
      }
    }
    const remove = (p: string) => {
      const rel = relative(state.root, p)
      state.byRel.delete(rel)
      state.files = state.files.filter((f) => f.rel !== rel)
      if (rel.indexOf('/') < 0) delete state.keyFiles[basename(p)]
      schedulePersist(state)
    }
    state.watcher.on('add', (p) => void upsert(p))
    state.watcher.on('change', (p) => void upsert(p))
    state.watcher.on('unlink', (p) => remove(p))
  } catch {
    /* ignore */
  }
}

async function getState(root: string): Promise<IndexState> {
  const existing = indexes.get(root)
  if (existing) return existing

  const loaded = await loadPersisted(root)
  const state: IndexState = loaded || {
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

  // Rescan when there is no persisted index, or when files changed on disk
  // after the last scan (cheap mtime check over the newest indexed file).
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

/** Build a snapshot for the AI (fast path: everything cached). */
/** One entry per relative path (guards against duplicates from older caches). */
function uniqueByRel<T extends { rel: string }>(files: T[]): T[] {
  const seen = new Set<string>()
  return files.filter((f) => {
    if (seen.has(f.rel)) return false
    seen.add(f.rel)
    return true
  })
}

export async function projectIndexSnapshot(root: string): Promise<ProjectIndexSnapshot> {
  const state = await getState(root)

  let packageJson: any
  const pj = state.keyFiles['package.json']
  if (pj) {
    try {
      packageJson = JSON.parse(pj)
    } catch {
      /* ignore */
    }
  }
  const readmeName = Object.keys(state.keyFiles).find((k) => /^readme/i.test(k))
  const readme = readmeName ? state.keyFiles[readmeName] : undefined

  let gitBranch: string | null = null
  try {
    gitBranch = (await simpleGit(root).status()).current
  } catch {
    /* ignore */
  }

  // Shallow paths first — the most useful structure for a brief.
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
    entries: uniqueByRel(state.files),
  }
}

/** Batch-upsert AI file summaries (called by the renderer's prescan). */
export async function setFileSummaries(
  root: string,
  items: { rel: string; summary: string; summaryAt: number }[],
): Promise<void> {
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

/** Force a full rescan (used by the "rescan" action). */
export async function rescanProjectIndex(root: string): Promise<ProjectIndexSnapshot> {
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
