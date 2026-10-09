/**
 * Project memory — the single, dependency-light core of Kineticut's project
 * understanding. Used by the Electron main process (src/main/projectIndex.ts)
 * and by the browser-preview dev server (dev-server/project-index.mjs), so both
 * behave identically.
 *
 * How it understands a project (no package scripts, no run/build/test guesses):
 *
 *   1. SCAN TOP-DOWN — breadth-first from the project root, so the root, the
 *      first directory level and the entry modules are read before deeper code.
 *      Every text file is read once: its language, symbols and imports are
 *      extracted from the code itself, and its content is held in a bounded
 *      in-memory cache so any file can be recalled instantly.
 *   2. DIRECTORY DIGESTS — each directory is summarized from what is inside it
 *      (file counts, languages, declared symbols, AI summaries when present).
 *   3. CODE PROFILE — languages by file count, frameworks inferred from the
 *      imports in the code, and likely entry-point modules.
 *   4. PURPOSE — "what is this app for" from the README lead or the manifest
 *      description, read during the scan (no extra reads, no AI at query time).
 *   5. KEEP FRESH — a watcher updates records and cached contents on change.
 *
 * Summaries are written separately (by the renderer's understanding builder)
 * and persisted alongside the metadata.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import chokidar from 'chokidar'
import { isIgnoreFile, loadIgnoreRules } from './ignoreRules.mjs'
import { simpleGit } from 'simple-git'

/* --------------------------------- limits ---------------------------------- */

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', '.next', '.turbo', 'target', '__pycache__',
  '.venv', 'venv', '.cache', 'coverage', '.idea', 'release', 'build',
])
/** Hard cap on files indexed per project. */
export const MAX_FILES = 20000
/** Files larger than this are indexed by metadata only (content is not held). */
export const MAX_TEXT_BYTES = 256 * 1024
/** Bounded memory for file contents (LRU; shallow files are kept first). */
export const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024
/** Largest slice returned by a single recall (protects the model's context). */
export const MAX_RECALL_CHARS = 60000
const README_BYTES = 8000
const YIELD_EVERY = 100

/* ----------------------------- language & text ----------------------------- */

const EXT_LANG = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.mdx': 'markdown',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.py': 'python', '.rs': 'rust',
  '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.rb': 'ruby', '.php': 'php', '.html': 'html', '.htm': 'html', '.css': 'css',
  '.scss': 'scss', '.less': 'less', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell', '.bat': 'batch', '.sql': 'sql', '.xml': 'xml', '.svg': 'xml',
  '.vue': 'vue', '.svelte': 'svelte', '.prisma': 'prisma', '.graphql': 'graphql',
  '.proto': 'protobuf', '.ini': 'ini', '.txt': 'plaintext', '.log': 'plaintext',
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz',
  '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2',
  '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.class', '.jar', '.pyc', '.pyo', '.o', '.a',
  '.lock',
])

/** Languages that describe documents or config rather than programming. */
const NON_CODE = new Set([
  'markdown', 'json', 'yaml', 'toml', 'ini', 'xml', 'plaintext', 'dotenv', 'dockerfile',
  'makefile', 'cmake', 'html', 'css', 'scss', 'less', 'csv', 'graphql', 'protobuf', 'prisma',
])

/** Map a path to a language id (by name first, then extension). */
export function languageForPath(path) {
  const base = path.split(/[/\\]/).pop() || ''
  const lower = base.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === '.env' || lower.startsWith('.env.')) return 'dotenv'
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  if (lower === 'cmakelists.txt') return 'cmake'
  if (lower === 'rakefile' || lower === 'gemfile' || lower === 'vagrantfile') return 'ruby'
  const m = /\.[^./\\]+$/.exec(lower)
  return (m && EXT_LANG[m[0]]) || 'plaintext'
}

/** True for extensions we read as text (extensionless files such as Dockerfile count). */
export function isTextLike(path) {
  const m = /\.[^./\\]+$/.exec(path.toLowerCase())
  if (!m) return true
  return !BINARY_EXT.has(m[0])
}

/** A NUL byte in the first 8 KB means binary. */
export function looksBinary(buf) {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true
  return false
}

/* ------------------------------ code metadata ------------------------------ */

const IMPORT_RE =
  /(?:from\s*|require\(\s*|import\s*\(\s*|#include\s*[<"]|use\s+|mod\s+|import\s+)(['"]?)([\w./@-]+)\1/g

const SYMBOL_PATTERNS = [
  /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)?/g,
  /def\s+([a-zA-Z_]\w*)\s*\(/g,
  /pub\s+(?:fn|struct|enum|mod|trait|type)\s+([a-zA-Z_]\w*)/g,
  /func\s+(?:\([^)]*\)\s*)?([A-Z]\w*|main)\s*\(/g,
  /^(?:class|struct|interface|trait)\s+([A-Z]\w*)/gm,
  /^#{1,4}\s+(.+)$/gm, // markdown headings
]

/** Symbols and imports declared in a file's text. Pure string processing. */
export function extractFileMeta(path, content) {
  const language = languageForPath(path)
  const symbols = []
  const imports = []
  if (!content) return { language, symbols, imports }
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(content)) && imports.length < 40) {
    const spec = m[2]
    if (spec && !imports.includes(spec)) imports.push(spec)
  }
  for (const re of SYMBOL_PATTERNS) {
    re.lastIndex = 0
    while ((m = re.exec(content)) && symbols.length < 40) {
      const name = (m[1] || '').trim()
      if (name && !symbols.includes(name)) symbols.push(name)
    }
  }
  return { language, symbols, imports }
}

/* ------------------------------ content memory ----------------------------- */

/**
 * Bounded, least-recently-used cache of file contents. `add` never evicts
 * (used by the top-down scan, so shallow files are kept first); `set` evicts
 * the least recently used entries (used for fresh reads).
 */
export class ContentCache {
  constructor(budget = MEMORY_BUDGET_BYTES) {
    this.budget = budget
    this.map = new Map()
    this.bytes = 0
  }

  get size() {
    return this.map.size
  }

  has(rel) {
    return this.map.has(rel)
  }

  /** Returns { text, mtime } and refreshes recency. */
  get(rel) {
    const entry = this.map.get(rel)
    if (!entry) return undefined
    this.map.delete(rel)
    this.map.set(rel, entry)
    return entry
  }

  add(rel, text, mtime) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (this.bytes - (this.map.get(rel)?.bytes ?? 0) + bytes > this.budget) return false
    this.delete(rel)
    this.map.set(rel, { text, mtime, bytes })
    this.bytes += bytes
    return true
  }

  set(rel, text, mtime) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.budget) return false
    this.delete(rel)
    while (this.bytes + bytes > this.budget && this.map.size > 0) {
      this.delete(this.map.keys().next().value)
    }
    this.map.set(rel, { text, mtime, bytes })
    this.bytes += bytes
    return true
  }

  delete(rel) {
    const entry = this.map.get(rel)
    if (!entry) return
    this.bytes -= entry.bytes
    this.map.delete(rel)
  }

  deletePrefix(prefix) {
    for (const rel of [...this.map.keys()]) if (rel.startsWith(prefix)) this.delete(rel)
  }

  clear() {
    this.map.clear()
    this.bytes = 0
  }
}

/* ------------------------------ file records ------------------------------- */

const yieldToEventLoop = () => new Promise((r) => setImmediate(r))

function parentOf(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function makeRecord(root, rel, size, mtime) {
  return {
    path: join(root, rel),
    rel,
    name: basename(rel),
    dir: parentOf(rel),
    depth: rel.split('/').length,
    size,
    mtime,
    text: false,
    language: languageForPath(rel),
    symbols: [],
    imports: [],
  }
}

/** Read a file as text when it is small, text-like and not binary. */
async function readText(fullPath, size) {
  if (size === 0 || size > MAX_TEXT_BYTES) return null
  try {
    const buf = await fs.readFile(fullPath)
    if (looksBinary(buf)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function applyText(record, text) {
  const meta = extractFileMeta(record.rel, text)
  record.language = meta.language
  record.symbols = meta.symbols
  record.imports = meta.imports
  record.text = true
}

/* --------------------------------- scanning -------------------------------- */

/**
 * Top-down scan: breadth-first, so shallow files (root, manifests, entry
 * modules) are read first. Returns the file records, the top-level listing
 * and the content memory filled in that same order.
 */
export async function scanProject(root, { budget = MEMORY_BUDGET_BYTES } = {}) {
  const files = new Map()
  const contents = new ContentCache(budget)
  const topLevel = []
  const queue = [{ dir: root, rel: '' }]
  const ignore = await loadIgnoreRules(root)
  let count = 0
  let capped = false
  while (queue.length > 0 && !capped) {
    const { dir, rel: dirRel } = queue.shift()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    if (dir === root) topLevel.push(...entries.map((e) => e.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !ignore.ignores(rel, true)) queue.push({ dir: full, rel })
        continue
      }
      if (!entry.isFile()) continue
      if (ignore.ignores(rel, false)) continue
      if (++count > MAX_FILES) {
        capped = true
        break
      }
      let st
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      const record = makeRecord(root, rel, st.size, st.mtimeMs)
      if (isTextLike(rel)) {
        const text = await readText(full, st.size)
        if (text !== null) {
          applyText(record, text)
          contents.add(rel, text, st.mtimeMs)
        }
      }
      files.set(rel, record)
      if (count % YIELD_EVERY === 0) await yieldToEventLoop()
    }
  }
  return { files, topLevel, contents, scannedAt: Date.now(), ignore }
}

/* ------------------------------- derivations ------------------------------- */

/** First meaningful prose of a README (headings, badges and links stripped). */
function readmeLead(text) {
  const parts = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) {
      if (parts.length > 0) break
      continue
    }
    if (line.startsWith('#')) continue
    if (/^[!<]/.test(line)) continue
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    line = line.replace(/[*_`>]+/g, '').trim()
    if (!line) continue
    parts.push(line)
    if (parts.join(' ').length > 280) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** "What is this app for?" — the manifest description, else the README lead. */
export function derivePurpose(description, readme) {
  if (typeof description === 'string' && description.trim()) {
    return description.trim().slice(0, 300)
  }
  if (readme) {
    const lead = readmeLead(readme)
    if (lead) return lead.slice(0, 300)
  }
  return undefined
}

/**
 * Identity of the project, read from the top of the tree: the folder name,
 * the manifest name/description (never its scripts) and the README.
 */
export function deriveIdentity(root, files, contents) {
  const textOf = (rel) => contents.get(rel)?.text
  let name = basename(root)
  let description
  const manifest = textOf('package.json')
  if (manifest) {
    try {
      const pkg = JSON.parse(manifest)
      if (typeof pkg.name === 'string' && pkg.name) name = pkg.name
      if (typeof pkg.description === 'string') description = pkg.description
    } catch {
      /* not valid JSON — keep the folder name */
    }
  }
  let readmeRel = null
  for (const rec of files.values()) {
    if (rec.depth === 1 && /^readme/i.test(rec.name)) {
      readmeRel = rec.rel
      break
    }
  }
  const readme = readmeRel ? textOf(readmeRel)?.slice(0, README_BYTES) : undefined
  return { name, description, readme, purpose: derivePurpose(description, readme) }
}

const CODE_LANG_LABEL = {
  typescript: 'TypeScript', tsx: 'TypeScript (TSX)', javascript: 'JavaScript', jsx: 'JavaScript (JSX)',
  python: 'Python', rust: 'Rust', go: 'Go', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', csharp: 'C#', ruby: 'Ruby', php: 'PHP', shell: 'Shell', vue: 'Vue',
  svelte: 'Svelte', sql: 'SQL',
}

/** Frameworks and libraries recognised from the imports in the code. */
const FRAMEWORKS = new Map([
  ['react', 'React'], ['react-dom', 'React'], ['next', 'Next.js'], ['vue', 'Vue'],
  ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['electron', 'Electron'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['hono', 'Hono'],
  ['vite', 'Vite'], ['zustand', 'Zustand'], ['redux', 'Redux'],
  ['@reduxjs/toolkit', 'Redux Toolkit'], ['@prisma/client', 'Prisma'], ['monaco-editor', 'Monaco'],
  ['@monaco-editor/react', 'Monaco'], ['xterm', 'xterm.js'], ['@xterm/xterm', 'xterm.js'],
  ['chokidar', 'chokidar'], ['simple-git', 'simple-git'], ['jest', 'Jest'], ['vitest', 'Vitest'],
  ['lucide-react', 'Lucide'], ['tailwindcss', 'Tailwind CSS'], ['django', 'Django'],
  ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['numpy', 'NumPy'], ['pandas', 'pandas'],
  ['torch', 'PyTorch'], ['tensorflow', 'TensorFlow'], ['sqlalchemy', 'SQLAlchemy'],
  ['github.com/gin-gonic/gin', 'Gin'], ['gorm.io/gorm', 'GORM'], ['tokio', 'Tokio'],
  ['serde', 'Serde'], ['axum', 'Axum'], ['org.springframework', 'Spring'],
])

function frameworkFor(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null
  const seg = spec.split('/')
  const candidates = [spec, seg[0], seg.length > 1 ? `${seg[0]}/${seg[1]}` : '', spec.split('.')[0]]
  for (const c of candidates) {
    const label = c && FRAMEWORKS.get(c)
    if (label) return label
  }
  return null
}

const ENTRY_NAMES = new Set(['main', 'index', 'app', 'server', 'cli', '__main__', 'manage', 'program', 'start', 'lib'])

/**
 * Code profile from the code itself: languages by file count, frameworks from
 * imports, and entry-point modules by name and depth.
 */
export function buildCodeProfile(files) {
  const languageCounts = new Map()
  const frameworkCounts = new Map()
  const entryCandidates = []
  for (const rec of files.values()) {
    if (rec.text && !NON_CODE.has(rec.language)) {
      languageCounts.set(rec.language, (languageCounts.get(rec.language) || 0) + 1)
    }
    if (rec.text) {
      for (const spec of rec.imports) {
        const label = frameworkFor(spec)
        if (label) frameworkCounts.set(label, (frameworkCounts.get(label) || 0) + 1)
      }
      const stem = rec.name.replace(/\.[^.]+$/, '')
      if (ENTRY_NAMES.has(stem) && rec.depth <= 3 && !NON_CODE.has(rec.language)) {
        entryCandidates.push(rec)
      }
    }
  }
  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([language, count]) => ({ language, label: CODE_LANG_LABEL[language] || language, files: count }))
  const frameworks = [...frameworkCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([label]) => label)
  const entryPoints = entryCandidates
    .sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))
    .slice(0, 8)
    .map((r) => r.rel)
  return { languages, frameworks, entryPoints }
}

/**
 * One digest per directory, built from the files inside it: file counts
 * (recursive), code languages, declared symbols and AI summaries (direct files).
 */
export function digestDirectories(files, { maxDirs = 240 } = {}) {
  const dirs = new Map()
  const ensure = (rel) => {
    let d = dirs.get(rel)
    if (!d) {
      d = { rel, depth: rel === '' ? 0 : rel.split('/').length, fileCount: 0, childDirs: new Set(), languages: new Map(), symbols: [], summaries: [] }
      dirs.set(rel, d)
    }
    return d
  }
  ensure('')
  for (const rec of files.values()) {
    // Ancestors (including the root) count this file.
    const parts = rec.rel.split('/')
    for (let i = 0; i < parts.length; i++) {
      const d = ensure(parts.slice(0, i).join('/'))
      d.fileCount++
      if (i < parts.length - 1) d.childDirs.add(parts.slice(0, i + 1).join('/'))
    }
    // Direct content only: languages, symbols and summaries of the file's own directory.
    const own = ensure(rec.dir)
    if (rec.text && !NON_CODE.has(rec.language)) {
      own.languages.set(rec.language, (own.languages.get(rec.language) || 0) + 1)
    }
    for (const sym of rec.symbols) {
      if (own.symbols.length < 12 && !own.symbols.includes(sym)) own.symbols.push(sym)
    }
    if (rec.summary && own.summaries.length < 3) {
      own.summaries.push(`${rec.name}: ${rec.summary}`)
    }
  }
  const out = [...dirs.values()]
    .filter((d) => d.rel === '' || d.fileCount > 0)
    .sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))
    .slice(0, maxDirs)
    .map((d) => ({
      rel: d.rel,
      depth: d.depth,
      fileCount: d.fileCount,
      childDirs: d.childDirs.size,
      languages: [...d.languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l),
      symbols: d.symbols,
      summaries: d.summaries,
    }))
  return out
}

/* --------------------------------- service --------------------------------- */

/**
 * Create the project index service. `cacheDir` is where the metadata (never
 * file contents) is persisted, so a restart loads instantly.
 */
export function createProjectIndex({ cacheDir }) {
  /** @type {Map<string, any>} */
  const states = new Map()

  const cacheFile = (root) => {
    const hash = createHash('sha1').update(root).digest('hex').slice(0, 12)
    return join(cacheDir, `${hash}.json`)
  }

  async function loadPersisted(root) {
    try {
      const data = JSON.parse(await fs.readFile(cacheFile(root), 'utf8'))
      if (!data || data.root !== root || !Array.isArray(data.files)) return null
      const files = new Map()
      for (const rec of data.files) if (rec && rec.rel) files.set(rec.rel, rec)
      return { files, topLevel: data.topLevel || [], scannedAt: data.scannedAt || 0 }
    } catch {
      return null
    }
  }

  function schedulePersist(state) {
    if (state.persistTimer) clearTimeout(state.persistTimer)
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null
      void persist(state)
    }, 1500)
  }

  async function persist(state) {
    try {
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(
        cacheFile(state.root),
        JSON.stringify({
          root: state.root,
          topLevel: state.topLevel,
          scannedAt: state.scannedAt,
          files: [...state.files.values()],
        }),
      )
    } catch {
      /* the cache is an optimization; ignore write failures */
    }
  }

  /** Read cached contents for files the scan did not hold (after a restart). */
  async function warm(state) {
    if (state.warming) return
    state.warming = true
    try {
      let n = 0
      for (const rec of state.files.values()) {
        if (!rec.text || state.contents.has(rec.rel)) continue
        const text = await readText(rec.path, rec.size)
        if (text !== null) state.contents.add(rec.rel, text, rec.mtime)
        if (++n % YIELD_EVERY === 0) await yieldToEventLoop()
      }
    } finally {
      state.warming = false
    }
  }

  function startWatching(state) {
    if (state.watcher) return
    const { root } = state
    const relOf = (full) => relative(root, full)
    const inside = (rel) => rel && !rel.startsWith('..') && !isAbsolute(rel)
    try {
      state.watcher = chokidar.watch(root, {
        ignoreInitial: true,
        depth: 24,
        ignored: (p) => SKIP_DIRS.has(basename(p)),
      })
      const upsert = async (full) => {
        const rel = relOf(full)
        if (!inside(rel)) return
        // A change to the ignore rules themselves: rescan so the new rules apply.
        if (isIgnoreFile(rel)) {
          void rescanState(state)
          return
        }
        if (state.ignore?.ignores(rel, false)) return
        let st
        try {
          st = await fs.stat(full)
        } catch {
          return
        }
        if (!st.isFile()) return
        // Read the previous record AFTER the await: add and change events for one
        // file can race, and reading earlier duplicated entries.
        const prev = state.files.get(rel)
        const record = makeRecord(root, rel, st.size, st.mtimeMs)
        if (prev) {
          record.summary = prev.summary
          record.summaryAt = prev.summaryAt
        }
        if (isTextLike(rel)) {
          const text = await readText(full, st.size)
          if (text !== null) {
            applyText(record, text)
            state.contents.set(rel, text, st.mtimeMs)
          } else {
            state.contents.delete(rel)
          }
        } else {
          state.contents.delete(rel)
        }
        state.files.set(rel, record)
        schedulePersist(state)
      }
      const remove = (full) => {
        const rel = relOf(full)
        if (!inside(rel)) return
        state.files.delete(rel)
        state.contents.delete(rel)
        schedulePersist(state)
      }
      const removeDir = (full) => {
        const rel = relOf(full)
        if (!inside(rel)) return
        for (const key of [...state.files.keys()]) {
          if (key === rel || key.startsWith(`${rel}/`)) state.files.delete(key)
        }
        state.contents.deletePrefix(`${rel}/`)
        schedulePersist(state)
      }
      state.watcher.on('add', (p) => void upsert(p))
      state.watcher.on('change', (p) => void upsert(p))
      state.watcher.on('unlink', (p) => remove(p))
      state.watcher.on('unlinkDir', (p) => removeDir(p))
    } catch {
      /* watching is best-effort */
    }
  }

  async function rescanState(state) {
    if (state.scanning) return state.scanning
    state.scanning = runScan(state).finally(() => {
      state.scanning = null
    })
    return state.scanning
  }

  async function runScan(state) {
    const scanned = await scanProject(state.root)
    state.ignore = scanned.ignore
    // Keep summaries from before the scan when the file is unchanged.
    for (const [rel, rec] of scanned.files) {
      const prev = state.files.get(rel)
      if (prev?.summary && prev.mtime === rec.mtime) {
        rec.summary = prev.summary
        rec.summaryAt = prev.summaryAt
      }
    }
    state.files = scanned.files
    state.contents = scanned.contents
    state.topLevel = scanned.topLevel
    state.scannedAt = scanned.scannedAt
    schedulePersist(state)
  }

  /** One in-flight open per root, so concurrent callers share a single state and watcher. */
  const opening = new Map()

  function getState(root) {
    const existing = states.get(root)
    if (existing) {
      return existing.scanning ? existing.scanning.then(() => existing) : Promise.resolve(existing)
    }
    if (!opening.has(root)) {
      opening.set(root, openState(root).finally(() => opening.delete(root)))
    }
    return opening.get(root)
  }

  async function openState(root) {
    const loaded = await loadPersisted(root)
    const state = {
      root,
      files: loaded?.files ?? new Map(),
      contents: new ContentCache(),
      topLevel: loaded?.topLevel ?? [],
      scannedAt: loaded?.scannedAt ?? 0,
      watcher: null,
      persistTimer: null,
      scanning: null,
      warming: false,
    }
    states.set(root, state)
    // Rescan when there is no persisted index, or files changed since the last scan.
    let newest = 0
    for (const rec of state.files.values()) newest = Math.max(newest, rec.mtime)
    const stale = !loaded || state.files.size === 0 || newest > state.scannedAt
    if (stale) {
      state.scanning = runScan(state).finally(() => {
        state.scanning = null
      })
      await state.scanning
    } else {
      void warm(state)
    }
    startWatching(state)
    return state
  }

  async function snapshot(root) {
    const state = await getState(root)
    const identity = deriveIdentity(root, state.files, state.contents)
    let gitBranch = null
    try {
      gitBranch = (await simpleGit(root).status()).current
    } catch {
      /* not a repository */
    }
    const records = [...state.files.values()]
    const entries = records.map((rec) => ({
      path: rec.path,
      rel: rec.rel,
      size: rec.size,
      mtime: rec.mtime,
      language: rec.language,
      symbols: rec.symbols.slice(0, 16),
      imports: rec.imports.slice(0, 12),
      summary: rec.summary,
      summaryAt: rec.summaryAt,
    }))
    const treePaths = records
      .map((r) => r.rel)
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, 150)
    const textFiles = records.filter((r) => r.text).length
    return {
      folder: root,
      name: identity.name,
      purpose: identity.purpose,
      readme: identity.readme?.slice(0, 2000),
      fileCount: records.length,
      topLevel: state.topLevel,
      treePaths,
      gitBranch,
      scannedAt: state.scannedAt || Date.now(),
      entries,
      dirs: digestDirectories(state.files),
      profile: buildCodeProfile(state.files),
      memory: {
        textFiles,
        cachedFiles: state.contents.size,
        cachedBytes: state.contents.bytes,
        budgetBytes: state.contents.budget,
      },
    }
  }

  async function rescan(root) {
    const state = await getState(root)
    state.scanning = runScan(state).finally(() => {
      state.scanning = null
    })
    await state.scanning
    return snapshot(root)
  }

  async function setSummaries(root, items) {
    const state = states.get(root)
    if (!state) return
    for (const item of items) {
      const rec = state.files.get(item.rel)
      if (rec) {
        rec.summary = item.summary
        rec.summaryAt = item.summaryAt
      }
    }
    schedulePersist(state)
  }

  /**
   * Retrieve any file from project memory: served from the content cache when
   * the cached copy is current, otherwise read from disk and kept in memory.
   */
  async function file(root, rel) {
    const state = await getState(root)
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const full = join(root, clean)
    const back = relative(root, full)
    if (!clean || back.startsWith('..') || isAbsolute(back)) {
      throw new Error('Path is outside the project')
    }
    const relPosix = back.split(sep).join('/')
    let st
    try {
      st = await fs.stat(full)
    } catch {
      throw new Error(`No such file in the project: ${relPosix}`)
    }
    if (!st.isFile()) throw new Error(`Not a file: ${relPosix}`)
    const rec = state.files.get(relPosix)
    const cached = state.contents.get(relPosix)
    let content
    let source = 'memory'
    if (cached && cached.mtime === st.mtimeMs) {
      content = cached.text
    } else {
      const buf = await fs.readFile(full)
      if (looksBinary(buf)) {
        return { rel: relPosix, path: full, language: languageForPath(relPosix), size: st.size, binary: true, content: '', truncated: false, source: 'disk', summary: rec?.summary, indexed: !!rec }
      }
      content = buf.toString('utf8')
      source = 'disk'
      state.contents.set(relPosix, content, st.mtimeMs)
    }
    const truncated = content.length > MAX_RECALL_CHARS
    return {
      rel: relPosix,
      path: full,
      language: rec?.language ?? languageForPath(relPosix),
      size: st.size,
      binary: false,
      content: truncated ? content.slice(0, MAX_RECALL_CHARS) : content,
      truncated,
      source,
      summary: rec?.summary,
      indexed: !!rec,
    }
  }

  return { snapshot, rescan, setSummaries, file }
}
