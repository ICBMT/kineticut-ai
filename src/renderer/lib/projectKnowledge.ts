/**
 * Project understanding (renderer) — the AI's view of the open project.
 *
 *   1. MEMORY     The main-process project memory scans from the top of the tree
 *                 (src/shared/projectMemory.mjs): every file, directory digests,
 *                 a code profile, and the contents of text files, kept in memory.
 *   2. UNDERSTAND On demand, the configured model reads the files top-down and
 *                 writes a one-line summary per file, stored back in memory.
 *   3. RETRIEVE   For each question, the relevant files are selected and the AI
 *                 gets their summaries, the project map, and the content of the
 *                 best matches. Any file can be recalled at any moment.
 *   4. KEEP FRESH A watcher re-understands files that change on disk.
 *
 * Nothing here reads package scripts or guesses how to run the project: the
 * understanding comes from the code and its structure.
 */
import { mentionBlockFor } from './mentionContext'
import { create } from 'zustand'
import { api } from '../api'
import { streamChat } from '../ai/providers'
import type {
  ProjectDirDigest,
  ProjectFileContent,
  ProjectIndexEntry,
  ProjectIndexSnapshot,
} from '../../shared/types'
import { useAppStore } from '../store/app'
import { resolveChatModel, useSettingsStore } from '../store/settings'
import { fuzzyScore } from './fuzzy'

/* ------------------------------- status store ------------------------------- */

export interface KnowledgeStatus {
  enabled: boolean
  scanning: boolean
  done: number
  total: number
  summarized: number
  files: number
}

export const useKnowledgeStore = create<KnowledgeStatus>(() => ({
  enabled: false,
  scanning: false,
  done: 0,
  total: 0,
  summarized: 0,
  files: 0,
}))

function setStatus(patch: Partial<KnowledgeStatus>): void {
  useKnowledgeStore.setState(patch)
}

/* --------------------------------- project -------------------------------- */

/** One line on the languages, frameworks and entry points found in the code. */
export function codeProfileLine(snap: ProjectIndexSnapshot): string {
  const parts: string[] = []
  const langs = snap.profile?.languages ?? []
  if (langs.length) {
    parts.push(`Languages: ${langs.slice(0, 4).map((l) => `${l.label} (${l.files})`).join(', ')}`)
  }
  if (snap.profile?.frameworks?.length) {
    parts.push(`Frameworks: ${snap.profile.frameworks.slice(0, 8).join(', ')}`)
  }
  if (snap.profile?.entryPoints?.length) {
    parts.push(`Entry points: ${snap.profile.entryPoints.slice(0, 5).join(', ')}`)
  }
  return parts.join('. ')
}

/** Directory digest as one line: path, file count, languages, and what it contains. */
export function dirLine(d: ProjectDirDigest): string {
  const name = d.rel || '(root)'
  const langs = d.languages.length ? ` · ${d.languages.join('/')}` : ''
  const what = d.summaries[0]
    ? ` — ${d.summaries[0].slice(0, 120)}`
    : d.symbols.length
      ? ` — ${d.symbols.slice(0, 6).join(', ')}`
      : ''
  return `- ${name}/ (${d.fileCount} files${langs})${what}`
}

/* ---------------------------------- build --------------------------------- */

const MAX_SUMMARY_BYTES = 256 * 1024
const UNDERSTAND_FILE_CAP = 300
const SUMMARY_EXCERPT = 4000

interface BuildOptions {
  maxFiles?: number
  force?: boolean
}

/** Read one file from project memory and have the model summarize it in one sentence. */
async function summarizeEntry(folder: string, entry: ProjectIndexEntry): Promise<string | null> {
  const settings = useSettingsStore.getState()
  const { provider, model } = resolveChatModel(settings)
  if (!provider || !model) return null
  let file: ProjectFileContent
  try {
    file = await api.projectIndex.file(folder, entry.rel)
  } catch {
    return null
  }
  if (file.binary || !file.content.trim()) return null
  const content = file.content.slice(0, SUMMARY_EXCERPT)
  let out = ''
  try {
    for await (const evt of streamChat({
      provider,
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a code analyst. Summarize the given file in ONE short sentence: what it does and its key exports. Reply with only the sentence, no preamble.',
        },
        {
          role: 'user',
          content: `<file path="${entry.rel}" language="${entry.language}">\n${content}\n</file>`,
        },
      ],
    })) {
      if (evt.type === 'text') out += evt.text
      else if (evt.type === 'error') return null
    }
  } catch {
    return null
  }
  const line = out.trim().split('\n')[0]?.slice(0, 200)
  return line || null
}

/**
 * Build the AI's understanding of the project: summarize files TOP-DOWN (the
 * root and first directory levels first, then deeper modules), skipping files
 * already understood unless `force` is set.
 */
export async function buildUnderstanding(opts: BuildOptions = {}): Promise<void> {
  const folder = useAppStore.getState().folder
  if (!folder) return
  if (useKnowledgeStore.getState().scanning) return

  setStatus({ scanning: true, done: 0, total: 0 })
  try {
    const snap = await api.projectIndex.get(folder)
    const entries = snap.entries || []
    setStatus({ files: entries.length })

    const cap = opts.maxFiles ?? UNDERSTAND_FILE_CAP
    const targets = entries
      .filter((e) => {
        if (e.size === 0 || e.size > MAX_SUMMARY_BYTES) return false
        if (/lock/i.test(e.rel) || e.rel.endsWith('.min.js')) return false
        if (opts.force) return true
        return !e.summary || !e.summaryAt || e.summaryAt < e.mtime
      })
      // Top-down: shallow paths first, then smaller files (quicker to read).
      .sort((a, b) => {
        const da = a.rel.split('/').length
        const db = b.rel.split('/').length
        if (da !== db) return da - db
        return a.size - b.size
      })
      .slice(0, cap)

    setStatus({ total: targets.length, summarized: entries.filter((e) => e.summary).length })

    const CONCURRENCY = 3
    let done = 0
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (entry) => ({ entry, summary: await summarizeEntry(folder, entry) })),
      )
      const items = results
        .filter((r): r is { entry: ProjectIndexEntry; summary: string } => !!r.summary)
        .map((r) => ({ rel: r.entry.rel, summary: r.summary, summaryAt: Date.now() }))
      if (items.length > 0) await api.projectIndex.setSummaries(folder, items)
      done += batch.length
      setStatus({ done, summarized: useKnowledgeStore.getState().summarized + items.length })
    }

    setStatus({ enabled: true })
    startKnowledgeKeeper()
  } finally {
    setStatus({ scanning: false })
  }
}

/* ------------------------------- retrieval -------------------------------- */

export interface RelevantHit {
  entry: ProjectIndexEntry
  score: number
  includeContent: boolean
  /** Set when the file was pulled in because it is imported by / imports this file. */
  via?: string
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 2)
}

/** Tokens that carry meaning for retrieval (stopwords removed). */
const STOPWORDS = new Set([
  'the', 'how', 'does', 'what', 'when', 'where', 'why', 'over', 'with', 'for',
  'and', 'that', 'this', 'file', 'files', 'code', 'work', 'works', 'working',
  'using', 'use', 'used', 'from', 'into', 'about', 'please', 'explain', 'tell',
  'show', 'make', 'create', 'build', 'project', 'app', 'application', 'our',
  'my', 'your', 'its', 'are', 'was', 'can', 'could', 'should', 'would', 'will',
  'have', 'has', 'not', 'but', 'all', 'any', 'some', 'get', 'set', 'new', 'one',
  'two', 'via', 'per', 'know', 'want', 'need', 'find', 'give', 'list',
])

function meaningfulTokens(query: string): string[] {
  return queryTokens(query).filter((t) => t.length > 3 && !STOPWORDS.has(t))
}

/** Quoted phrases ("the retry helper") are the strongest signal a question can give. */
function quotedPhrases(query: string): string[] {
  const out: string[] = []
  const re = /["'`]([^"'`]{3,60})["'`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(query))) {
    const phrase = m[1].trim().toLowerCase()
    if (phrase) out.push(phrase)
  }
  return out
}

/** Find a file explicitly named in the query (path-like token). */
export function findMentionedFile(query: string, entries: ProjectIndexEntry[]): ProjectIndexEntry | null {
  const tokens = query.split(/\s+/)
  for (const token of tokens) {
    const cleaned = token.replace(/[`'",;:()]/g, '')
    if (!cleaned.includes('/') && !/\.[a-z0-9]{1,5}$/i.test(cleaned)) continue
    const lower = cleaned.toLowerCase()
    const exact = entries.find(
      (e) => e.rel.toLowerCase() === lower || e.rel.toLowerCase().endsWith('/' + lower),
    )
    if (exact) return exact
    const base = entries.filter((e) => e.rel.toLowerCase().split('/').pop() === lower)
    if (base.length === 1) return base[0]
    if (base.length > 1) return base.sort((a, b) => a.rel.length - b.rel.length)[0]
  }
  return null
}

/** Score every indexed file against a natural-language question. */
export function retrieveRelevantFiles(entries: ProjectIndexEntry[], query: string, k = 5): RelevantHit[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  const keywords = meaningfulTokens(query)
  const mentioned = findMentionedFile(query, entries)
  const phrases = quotedPhrases(query)
  const hits: RelevantHit[] = []

  for (const entry of entries) {
    let score = 0
    const pathScore = fuzzyScore(query, entry.rel)
    if (pathScore !== null) score += pathScore
    if (phrases.length) {
      const haystack = `${entry.rel} ${entry.summary ?? ''} ${entry.symbols.join(' ')}`.toLowerCase()
      for (const phrase of phrases) if (haystack.includes(phrase)) score += 45
    }
    const base = entry.rel.split('/').pop() || ''
    if (keywords.some((t) => base.toLowerCase().includes(t))) score += 40
    let symbolScore = 0
    for (const sym of entry.symbols) {
      const sl = sym.toLowerCase()
      if (keywords.some((t) => sl.includes(t) || t.includes(sl))) symbolScore += 25
      if (symbolScore >= 60) break
    }
    score += symbolScore
    if (entry.summary) {
      const sl = entry.summary.toLowerCase()
      for (const t of keywords) if (sl.includes(t)) score += 8
    }
    if (entry.imports.some((i) => keywords.some((t) => i.toLowerCase().includes(t)))) score += 6
    if (keywords.includes(entry.language)) score += 5
    score -= entry.rel.split('/').length * 0.5
    if (score > 0 || entry === mentioned) {
      hits.push({ entry, score, includeContent: entry === mentioned })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(k, mentioned ? k + 1 : k))
}

/* ------------------------------ relationships ------------------------------ */

/** Extensions tried when an import like `./ipc` or `./ipc.js` is resolved to a file. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Resolve a relative import (`../lib/utils`, `./ipc.js`) written in `fromRel`
 * to the indexed file it points at. Bare package names resolve to nothing: the
 * graph only holds the project's own files.
 */
export function resolveImport(fromRel: string, spec: string, byRel: Map<string, ProjectIndexEntry>): string | null {
  if (!spec.startsWith('.')) return null
  const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')).split('/') : []
  const out: string[] = []
  for (const part of [...dir, ...spec.split('/')]) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  const base = out.join('/')
  // TypeScript sources are often imported with a .js extension.
  const stripped = base.replace(/\.(m|c)?jsx?$/, '')
  const roots = stripped !== base ? [stripped, base] : [base]
  for (const root of roots) {
    const candidates = [
      root,
      ...SOURCE_EXTENSIONS.map((ext) => root + ext),
      ...SOURCE_EXTENSIONS.map((ext) => `${root}/index${ext}`),
    ]
    for (const candidate of candidates) if (byRel.has(candidate) && candidate !== fromRel) return candidate
  }
  return null
}

export interface FileRelations {
  byRel: Map<string, ProjectIndexEntry>
  /** file → the project files it imports */
  imports: Map<string, string[]>
  /** file → the project files that import it */
  importedBy: Map<string, string[]>
}

const relationCache = new WeakMap<ProjectIndexEntry[], FileRelations>()

/** The import graph of the project, built once per snapshot. */
export function buildRelations(entries: ProjectIndexEntry[]): FileRelations {
  const cached = relationCache.get(entries)
  if (cached) return cached
  const byRel = new Map(entries.map((e) => [e.rel, e]))
  const imports = new Map<string, string[]>()
  const importedBy = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.imports?.length) continue
    const targets: string[] = []
    for (const spec of entry.imports) {
      const target = resolveImport(entry.rel, spec, byRel)
      if (target && !targets.includes(target)) targets.push(target)
    }
    if (targets.length === 0) continue
    imports.set(entry.rel, targets)
    for (const target of targets) {
      const list = importedBy.get(target) ?? []
      list.push(entry.rel)
      importedBy.set(target, list)
    }
  }
  const relations = { byRel, imports, importedBy }
  relationCache.set(entries, relations)
  return relations
}

/**
 * Graph-first expansion: the files the top hits import or are imported by are
 * the usual next thing a question needs ("what calls X" is answered by who imports X).
 */
export function expandWithRelations(hits: RelevantHit[], entries: ProjectIndexEntry[], extra = 3): RelevantHit[] {
  if (hits.length === 0) return hits
  const relations = buildRelations(entries)
  const seen = new Set(hits.map((h) => h.entry.rel))
  const out = [...hits]
  for (const hit of hits.slice(0, 2)) {
    const neighbours = [...(relations.imports.get(hit.entry.rel) ?? []), ...(relations.importedBy.get(hit.entry.rel) ?? [])]
    for (const rel of neighbours) {
      if (out.length >= hits.length + extra) break
      if (seen.has(rel)) continue
      const entry = relations.byRel.get(rel)
      if (!entry) continue
      seen.add(rel)
      out.push({ entry, score: hit.score * 0.5, includeContent: false, via: hit.entry.rel })
    }
  }
  return out
}

/** One line per file in the set: what it imports and what imports it, inside the set or out. */
export function relationLines(entries: ProjectIndexEntry[], rels: string[], limit = 16): string[] {
  const relations = buildRelations(entries)
  const lines: string[] = []
  for (const rel of rels) {
    const imports = (relations.imports.get(rel) ?? []).slice(0, 6)
    const importedBy = (relations.importedBy.get(rel) ?? []).slice(0, 6)
    if (imports.length) lines.push(`- ${rel} imports ${imports.join(', ')}`)
    if (importedBy.length) lines.push(`- ${rel} is imported by ${importedBy.join(', ')}`)
    if (lines.length >= limit) break
  }
  return lines.slice(0, limit)
}

/** Does the question ask about the project/app itself rather than its code? */
export function isProjectMetaQuery(query: string): boolean {
  const q = query.toLowerCase()
  if (!/\b(app|application|project|program|software|repo|codebase|editor|tool|product)\b/.test(q)) {
    return false
  }
  return /\b(what|why|how|purpose|about|describe|tell|explain)\b/.test(q)
}

/** Top-level directories, as a short map for the model. */
function directoryMap(snap: ProjectIndexSnapshot, limit = 12): string[] {
  return (snap.dirs || [])
    .filter((d) => d.depth === 1)
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, limit)
    .map(dirLine)
}

export interface KnowledgeContext {
  /** Prompt block for the model (null when there is nothing to inject). */
  block: string | null
  /** Relative paths of the files selected for this question. */
  files: string[]
}

const TOP_HIT_CHARS = 3000
const MENTION_CHARS = 6000

/**
 * Build the knowledge block for a chat/agent prompt: the project's purpose and
 * code profile, its directory map, the most relevant files with their
 * summaries, and the content of the best matches (or of the file the user named).
 */
export async function retrieveContextForQuery(query: string, k = 5): Promise<KnowledgeContext> {
  const folder = useAppStore.getState().folder
  if (!folder) return { block: null, files: [] }
  let snap: ProjectIndexSnapshot
  try {
    snap = await api.projectIndex.get(folder)
  } catch {
    return { block: null, files: [] }
  }
  const entries = snap.entries || []

  const header: string[] = []
  header.push(`About the open project "${snap.name}"${snap.purpose ? `: ${snap.purpose}` : '.'}`)
  const profile = codeProfileLine(snap)
  if (profile) header.push(profile)
  const dirs = directoryMap(snap)
  if (dirs.length) header.push(`Directory map:\n${dirs.join('\n')}`)

  if (entries.length === 0) {
    return { block: header.join('\n'), files: [] }
  }

  const hits = expandWithRelations(retrieveRelevantFiles(entries, query, k), entries)
  const files = hits.map((h) => h.entry.rel)
  const lines = hits.map((h) => {
    const syms = h.entry.symbols.length ? ` [${h.entry.symbols.slice(0, 6).join(', ')}]` : ''
    const summary = h.entry.summary ? `: ${h.entry.summary.slice(0, 140)}` : ''
    const via = h.via ? ` — connected to ${h.via}` : ''
    return `- ${h.entry.rel} (${h.entry.language})${summary}${syms}${via}`
  })

  let block = `${header.join('\n')}\n\n`
  block += `Relevant files from the project memory (${entries.length} files in ${folder}):\n${lines.join('\n')}`
  const related = relationLines(entries, files)
  if (related.length) block += `\n\nHow these files are connected (from their imports):\n${related.join('\n')}`

  const mentioned = findMentionedFile(query, entries)
  if (mentioned) {
    if (!files.includes(mentioned.rel)) files.push(mentioned.rel)
    const file = await recallSafe(folder, mentioned.rel)
    if (file && !file.binary) {
      block += `\n\nFile mentioned in the question — ${mentioned.rel}:\n\`\`\`${mentioned.language}\n${file.content.slice(0, MENTION_CHARS)}\n\`\`\``
    }
  } else {
    // The best matches come with their code, so the answer is grounded in it.
    for (const hit of hits.slice(0, 2)) {
      const file = await recallSafe(folder, hit.entry.rel)
      if (file && !file.binary && file.content.trim()) {
        block += `\n\nContent of ${hit.entry.rel}:\n\`\`\`${hit.entry.language}\n${file.content.slice(0, TOP_HIT_CHARS)}\n\`\`\``
      }
    }
  }

  // `@folder/` and `@symbol:Name` mentions bring their code (no extra AI pass).
  const mentionBlock = await mentionBlockFor(query, folder, entries)
  if (mentionBlock) block += `\n\n${mentionBlock}`

  if (isProjectMetaQuery(query)) {
    if (snap.readme?.trim()) {
      block += `\n\nREADME excerpt (project identity):\n${snap.readme.trim().slice(0, 1500)}`
    }
  }
  return { block, files }
}

async function recallSafe(folder: string, rel: string): Promise<ProjectFileContent | null> {
  try {
    return await api.projectIndex.file(folder, rel)
  } catch {
    return null
  }
}

/** Prompt block only, for callers that just need the text. */
export async function retrieveRelevantFilesForQuery(query: string, k = 5): Promise<string | null> {
  return (await retrieveContextForQuery(query, k)).block
}

/**
 * Recall any file from project memory by path or by file name. Returns the file
 * (full content, capped) or an error message with close matches.
 */
export async function recallFile(
  folder: string,
  pathOrName: string,
): Promise<{ ok: true; file: ProjectFileContent } | { ok: false; message: string }> {
  let wanted = pathOrName.trim().replace(/^\.\//, '').replace(/\\/g, '/')
  // Accept absolute paths inside the project as well.
  const root = folder.replace(/\\/g, '/').replace(/\/$/, '')
  if (wanted.startsWith(root + '/')) wanted = wanted.slice(root.length + 1)
  let snap: ProjectIndexSnapshot | null = null
  try {
    snap = await api.projectIndex.get(folder)
  } catch {
    snap = null
  }
  const entries = snap?.entries ?? []
  const match = entries.find((e) => e.rel === wanted) ?? findMentionedFile(wanted, entries)
  const rel = match?.rel ?? wanted
  try {
    const file = await api.projectIndex.file(folder, rel)
    return { ok: true, file }
  } catch (err) {
    const suggestions = entries
      .map((e) => e.rel)
      .filter((r) => r.toLowerCase().includes(wanted.toLowerCase().split('/').pop() || ''))
      .slice(0, 6)
    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''
    return { ok: false, message: `${err instanceof Error ? err.message : String(err)}.${hint}` }
  }
}

/* ------------------------------ keeper ------------------------------------ */

let keeperDispose: (() => void) | null = null

async function refreshStaleSummaries(paths: string[]): Promise<void> {
  const folder = useAppStore.getState().folder
  if (!folder) return
  const status = useKnowledgeStore.getState()
  if (!status.enabled || status.scanning) return
  const settings = useSettingsStore.getState()
  const { provider, model } = resolveChatModel(settings)
  if (!provider || !model) return

  let snap: ProjectIndexSnapshot
  try {
    snap = await api.projectIndex.get(folder)
  } catch {
    return
  }
  const targets = (snap.entries || [])
    .filter((e) => paths.includes(e.path))
    .filter((e) => e.size > 0 && e.size <= MAX_SUMMARY_BYTES && (!e.summary || !e.summaryAt || e.summaryAt < e.mtime))
    .slice(0, 20)
  if (targets.length === 0) return

  setStatus({ scanning: true })
  try {
    const items: { rel: string; summary: string; summaryAt: number }[] = []
    for (const entry of targets) {
      const summary = await summarizeEntry(folder, entry)
      if (summary) items.push({ rel: entry.rel, summary, summaryAt: Date.now() })
    }
    if (items.length > 0) await api.projectIndex.setSummaries(folder, items)
  } finally {
    setStatus({ scanning: false })
  }
}

/** Keep understanding fresh: re-understand files that change on disk. */
export function startKnowledgeKeeper(): void {
  const folder = useAppStore.getState().folder
  if (!folder || keeperDispose) return
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: string[] = []
  api.fs
    .watch(folder, (events) => {
      for (const ev of events) {
        if (ev.type === 'add' || ev.type === 'change') pending.push(ev.path)
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = pending
        pending = []
        void refreshStaleSummaries(paths)
      }, 1500)
    })
    .then((dispose) => {
      keeperDispose = dispose
    })
}

/** Resume the keeper when this project already has an understanding. */
export async function maybeStartKnowledgeKeeper(): Promise<void> {
  const folder = useAppStore.getState().folder
  if (!folder) return
  try {
    const snap = await api.projectIndex.get(folder)
    const summarized = (snap.entries || []).filter((e) => e.summary).length
    if (summarized > 0) {
      setStatus({ enabled: true, summarized, files: snap.entries.length })
      startKnowledgeKeeper()
    }
  } catch {
    /* ignore */
  }
}
