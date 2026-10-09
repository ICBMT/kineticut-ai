/**
 * Codebase index: the workspace split into syntax-aware chunks (whole functions,
 * classes and sections where they fit), searchable by keyword (BM25) and, when an
 * embedding model is available, by meaning.
 *
 * This is the layer the agent uses to find code (`codebase_search`), the way
 * Cursor's codebase index does. It is incremental and content-addressed: a file
 * is re-chunked only when its content hash changes (a save with no text change
 * costs nothing), and chunks are keyed by content hash, so embedding vectors
 * survive restarts and are recomputed only for chunks whose text changed. Files
 * excluded by .gitignore or .cursorignore never enter the index.
 *
 * Shared by the Electron main process and the browser-preview dev server. It
 * reads files through a project-memory service, so it has no Electron dependency.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** A chunk never holds more lines than this; larger declarations are split at member boundaries. */
export const CHUNK_LINES = 60
export const CHUNK_MAX_CHARS = 3000
/** Beyond this many chunks the index stops adding files (keeps memory bounded). */
export const MAX_CHUNKS = 120_000
const REBUILD_AFTER_MS = 2_000
/** Bump when chunking or the cache layout changes: older caches are rebuilt once. */
const INDEX_VERSION = 2
const PERSIST_DELAY_MS = 1500

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'but', 'you', 'all', 'can',
  'has', 'have', 'its', 'our', 'out', 'use', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'does', 'did', 'into', 'about', 'there', 'their', 'then', 'than', 'also', 'just', 'any', 'some',
  'let', 'var', 'const', 'return', 'new', 'null', 'undefined', 'true', 'false', 'import', 'export',
])

/** Lowercase terms from text: identifiers, their camelCase and snake_case parts. */
export function tokenize(text) {
  const out = []
  for (const raw of String(text).split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue
    const whole = raw.toLowerCase()
    if (whole.length >= 2 && !STOP.has(whole)) out.push(whole)
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
    for (const part of parts) {
      const p = part.toLowerCase()
      if (p.length >= 2 && p !== whole && !STOP.has(p)) out.push(p)
    }
  }
  return out
}

/** A line that starts a top-level declaration (or a markdown section). */
const TOP_DECL =
  /^(?:export\s+|pub(?:\([^)]*\))?\s+|declare\s+|default\s+|async\s+)*(?:function|class|interface|type|enum|const|let|var|struct|trait|impl|fn|func|def|module|namespace|object|protocol|extension|package|@)\b|^#{1,3}\s|^#\[/
/** A line that starts a member inside a declaration (method, nested function). */
const MEMBER_DECL =
  /^\s{1,8}(?:(?:public|private|protected|static|readonly|async|get|set|override|export|pub)\s+)*(?:function\s+|def\s+|fn\s+|func\s+)?[A-Za-z_$][\w$]*\s*(?:[<(:=]|\s*\()|^\s{1,8}(?:const|let|var|func|fn|def)\b|^\s{1,8}#{2,4}\s/
/** Comment and decorator lines that belong to the declaration below them. */
const ATTACHED = /^\s*(?:\/\/|\/\*|\*|#\[|@\w|#\s|#$|"""|\x27\x27\x27)/
const SYMBOL = /(?:function|class|interface|type|enum|struct|trait|impl|fn|func|def|module|namespace|object)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/
const HEADING = /^#{1,3}\s+(.+?)\s*$/

/** The name a unit is known by: its declaration name, or its markdown heading. */
function symbolOf(line) {
  const h = HEADING.exec(line)
  if (h) return h[1].slice(0, 80)
  const m = SYMBOL.exec(line)
  if (!m) return null
  return (m[1] || m[2] || '').slice(0, 80) || null
}

/**
 * Split text into chunks along syntax: top-level declarations start a new unit,
 * comments and decorators stay with the declaration below them, small neighbouring
 * units are packed together up to CHUNK_LINES, and a unit too large for one chunk
 * is split at member boundaries. Each chunk records its line range and the
 * symbol it starts with. No parser is needed, so any language is covered.
 */
export function chunkText(text) {
  const lines = String(text).split('\n')
  if (lines.length === 0) return []
  // 1. Unit starts: every top-level declaration, moved up over its comments.
  const starts = new Set([0])
  lines.forEach((line, i) => {
    if (i === 0 || !TOP_DECL.test(line)) return
    let j = i
    while (j > 0 && ATTACHED.test(lines[j - 1])) j--
    starts.add(j)
  })
  const cuts = [...starts].sort((a, b) => a - b)
  const units = cuts.map((start, k) => ({ start, end: k + 1 < cuts.length ? cuts[k + 1] : lines.length }))

  // 2. Oversize units are split at member boundaries into pieces of at most CHUNK_LINES.
  const pieces = []
  for (const u of units) {
    if (u.end - u.start <= CHUNK_LINES) {
      pieces.push(u)
      continue
    }
    let from = u.start
    while (from < u.end) {
      const hardEnd = Math.min(u.end, from + CHUNK_LINES)
      let end = hardEnd
      if (hardEnd < u.end) {
        // Prefer the last member start (or blank line) in the back half of the window.
        for (let i = hardEnd - 1; i > from + CHUNK_LINES / 2; i--) {
          if (MEMBER_DECL.test(lines[i]) || lines[i].trim() === '') {
            end = i
            break
          }
        }
      }
      pieces.push({ start: from, end })
      from = end
    }
  }

  // 3. Pack neighbouring pieces together while they fit in one chunk.
  const chunks = []
  let cur = null
  for (const p of pieces) {
    if (cur && cur.end === p.start && p.end - cur.start <= CHUNK_LINES) {
      cur.end = p.end
      continue
    }
    if (cur) chunks.push(cur)
    cur = { start: p.start, end: p.end }
  }
  if (cur) chunks.push(cur)

  // 4. Materialise: text, 1-based lines, and the symbol the chunk starts with.
  const out = []
  for (const c of chunks) {
    const body = lines.slice(c.start, c.end).join('\n')
    if (!body.trim()) continue
    // The symbol is the chunk's first top-level declaration (or heading).
    let symbol = null
    for (let i = c.start; i < c.end && !symbol; i++) {
      if (TOP_DECL.test(lines[i])) symbol = symbolOf(lines[i])
    }
    out.push({ startLine: c.start + 1, endLine: c.end, text: body.slice(0, CHUNK_MAX_CHARS), symbol })
  }
  return out
}

export function hashText(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** BM25 over chunks. Returns the top `k` chunk ids with scores. */
export function bm25Search(chunks, query, k = 8) {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || chunks.length === 0) return []
  const postings = new Map() // term -> [[docIndex, tf]]
  const lengths = new Float64Array(chunks.length)
  let total = 0
  chunks.forEach((c, i) => {
    const toks = tokenize(`${c.rel} ${c.text}`)
    lengths[i] = toks.length
    total += toks.length
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of terms) {
      const f = tf.get(t)
      if (!f) continue
      if (!postings.has(t)) postings.set(t, [])
      postings.get(t).push([i, f])
    }
  })
  const avg = total / chunks.length || 1
  const N = chunks.length
  const k1 = 1.2
  const b = 0.75
  const scores = new Float64Array(N)
  for (const t of terms) {
    const list = postings.get(t)
    if (!list) continue
    const df = list.length
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const [i, f] of list) {
      scores[i] += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * lengths[i]) / avg))
    }
  }
  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(([i, score]) => ({ index: i, score }))
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * Hybrid ranking: BM25 and vector similarity fused by reciprocal rank, so
 * neither scale dominates. Without vectors this is BM25 alone.
 */
export function hybridRank(chunks, query, { k = 8, queryVector = null, vectors = null } = {}) {
  const lexical = bm25Search(chunks, query, 40)
  if (!queryVector || !vectors) return lexical.slice(0, k).map((h) => ({ ...chunks[h.index], score: h.score }))
  const semantic = chunks
    .map((c, i) => ({ i, s: vectors.get(c.id) ? cosine(queryVector, vectors.get(c.id)) : -1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
  const fused = new Map()
  const RRF = 60
  lexical.forEach((h, rank) => fused.set(h.index, (fused.get(h.index) || 0) + 1 / (RRF + rank)))
  semantic.forEach((h, rank) => fused.set(h.i, (fused.get(h.i) || 0) + 1 / (RRF + rank)))
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([i, score]) => ({ ...chunks[i], score }))
}

/**
 * The index service. `projectIndex` is the project-memory service
 * (`snapshot(root)` and `file(root, rel)`), so file discovery and text reading
 * are the same ones the rest of the app uses.
 */
export function createCodebaseIndex({ cacheDir, projectIndex }) {
  /** @type {Map<string, any>} */
  const states = new Map()

  const cacheFile = (root) => join(cacheDir, `${hashText(root)}.codebase.json`)

  async function loadPersisted(root) {
    try {
      const data = JSON.parse(await fs.readFile(cacheFile(root), 'utf8'))
      if (!data || data.version !== INDEX_VERSION || data.root !== root || !data.files) return null
      return data
    } catch {
      return null
    }
  }

  function schedulePersist(state) {
    if (state.persistTimer) clearTimeout(state.persistTimer)
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null
      void persist(state)
    }, PERSIST_DELAY_MS)
  }

  async function persist(state) {
    try {
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(
        cacheFile(state.root),
        JSON.stringify({
          version: INDEX_VERSION,
          root: state.root,
          files: state.files,
          chunks: state.chunks,
          vectors: Object.fromEntries(state.vectors), // a Map would serialise as {}
          vectorModel: state.vectorModel,
        }),
      )
    } catch {
      /* the cache is an optimization; ignore write failures */
    }
  }

  async function stateFor(root) {
    let state = states.get(root)
    if (!state) {
      const saved = await loadPersisted(root)
      state = {
        root,
        files: saved?.files ?? {}, // rel -> { mtime, size, ids: [] }
        chunks: saved?.chunks ?? {}, // id -> { id, rel, startLine, endLine, text, hash }
        vectors: new Map(Object.entries(saved?.vectors ?? {})), // id -> { hash, v: number[] }
        vectorModel: saved?.vectorModel ?? null,
        builtAt: 0,
        building: null,
        searchCache: null,
        persistTimer: null,
        version: 0,
      }
      states.set(root, state)
    }
    return state
  }

  /** Bring the index up to date with the files on disk (incremental). */
  async function build(root, { force = false } = {}) {
    const state = await stateFor(root)
    if (state.building) return state.building
    if (!force && state.builtAt && Date.now() - state.builtAt < REBUILD_AFTER_MS) return state.stats
    state.building = (async () => {
      const snap = await projectIndex.snapshot(root)
      const entries = snap.entries || []
      const seen = new Set()
      let changed = 0
      let chunkCount = Object.keys(state.chunks).length
      for (const e of entries) {
        seen.add(e.rel)
        const prev = state.files[e.rel]
        if (prev && prev.mtime === e.mtime && prev.size === e.size) continue
        let file = null
        try {
          file = await projectIndex.file(root, e.rel)
        } catch {
          file = null
        }
        const contentHash = file && !file.binary && file.content ? hashText(file.content) : null
        // Touched or re-saved with the same text: keep the chunks and vectors.
        if (prev && contentHash && prev.hash === contentHash) {
          prev.mtime = e.mtime
          prev.size = e.size
          continue
        }
        // Changed or new: drop the old chunks and re-chunk.
        for (const id of prev?.ids ?? []) delete state.chunks[id]
        chunkCount -= prev?.ids?.length ?? 0
        state.files[e.rel] = { mtime: e.mtime, size: e.size, hash: contentHash, ids: [] }
        changed++
        if (chunkCount >= MAX_CHUNKS || !contentHash) continue
        for (const c of chunkText(file.content)) {
          const hash = hashText(c.text)
          const id = `${e.rel}:${c.startLine}-${c.endLine}`
          state.chunks[id] = {
            id,
            rel: e.rel,
            startLine: c.startLine,
            endLine: c.endLine,
            text: c.text,
            hash,
            symbol: c.symbol,
          }
          state.files[e.rel].ids.push(id)
          chunkCount++
        }
      }
      let removed = 0
      for (const rel of Object.keys(state.files)) {
        if (seen.has(rel)) continue
        for (const id of state.files[rel].ids) delete state.chunks[id]
        delete state.files[rel]
        removed++
      }
      // Drop vectors whose chunk text changed or vanished.
      for (const [id, rec] of state.vectors) {
        const c = state.chunks[id]
        if (!c || rec.hash !== c.hash) state.vectors.delete(id)
      }
      if (changed || removed) {
        state.version++
        state.searchCache = null
        schedulePersist(state)
      }
      state.builtAt = Date.now()
      state.stats = { files: Object.keys(state.files).length, chunks: Object.keys(state.chunks).length, changed, removed }
      return state.stats
    })()
    try {
      return await state.building
    } finally {
      state.building = null
    }
  }

  async function chunkList(root) {
    const state = await stateFor(root)
    if (!state.searchCache || state.searchCache.version !== state.version) {
      const list = Object.values(state.chunks).sort((a, b) => (a.rel === b.rel ? a.startLine - b.startLine : a.rel < b.rel ? -1 : 1))
      state.searchCache = { version: state.version, list }
    }
    return { state, list: state.searchCache.list }
  }

  /**
   * Ranked chunks for a query. `queryVector` (optional) must come from the model
   * named by `model`; vectors stored for another model are ignored.
   */
  async function search(root, query, { k = 8, queryVector = null, model = null } = {}) {
    await build(root)
    const { state, list } = await chunkList(root)
    const useVectors = queryVector && model && state.vectorModel === model && state.vectors.size > 0
    const vectors = useVectors ? new Map([...state.vectors].map(([id, rec]) => [id, rec.v])) : null
    const hits = hybridRank(list, query, { k, queryVector: useVectors ? queryVector : null, vectors })
    return { hits, semantic: Boolean(useVectors), stats: state.stats ?? null }
  }

  /** Chunks that have no vector yet for `model`, for the client to embed. */
  async function pending(root, { model, limit = 64 }) {
    await build(root)
    const { state, list } = await chunkList(root)
    if (state.vectorModel !== model) {
      state.vectors = new Map()
      state.vectorModel = model
      state.version++
    }
    const out = []
    let embedded = 0
    for (const c of list) {
      if (state.vectors.has(c.id)) {
        embedded++
        continue
      }
      if (out.length < limit) out.push({ id: c.id, hash: c.hash, text: c.text })
    }
    return { items: out, total: list.length, embedded }
  }

  /** Store vectors computed by the client for `model`. Stale hashes are ignored. */
  async function setVectors(root, { model, items }) {
    const state = await stateFor(root)
    if (state.vectorModel !== model) {
      state.vectors = new Map()
      state.vectorModel = model
    }
    let stored = 0
    for (const item of items || []) {
      const c = state.chunks[item.id]
      if (!c || c.hash !== item.hash || !Array.isArray(item.vector)) continue
      state.vectors.set(item.id, { hash: item.hash, v: item.vector })
      stored++
    }
    schedulePersist(state)
    return { stored, total: Object.keys(state.chunks).length }
  }

  return { build, search, pending, setVectors }
}
