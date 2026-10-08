/**
 * Project knowledge base (renderer).
 *
 * The full workflow:
 *   1. PRESCAN — generate a one-line AI summary for every indexed file and
 *      store it in the main-process project index (persisted, incremental).
 *      File metadata (language, symbols, imports) comes from the shared
 *      fileMeta extractor, so any type of code is understood.
 *   2. UNDERSTAND — detect the infrastructure profile (stack, package manager,
 *      scripts, CI, docker, configs) from the index snapshot.
 *   3. RETRIEVE — when the user asks something, score every file and hand the
 *      AI the specific relevant files (plus content for explicitly mentioned
 *      files) as context. Chat and agent prompts get this automatically.
 *   4. STAY FRESH — a keeper re-summarizes files that change on disk.
 */
import { create } from 'zustand'
import { api } from '../api'
import { streamChat } from '../ai/providers'
import type { ProjectIndexEntry, ProjectIndexSnapshot } from '../../shared/types'
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

/* ------------------------------ infrastructure ------------------------------ */

export interface InfraProfile {
  stack: string[]
  packageManager: string | null
  scripts: Record<string, string>
  devCommand: string | null
  buildCommand: string | null
  testCommand: string | null
  configs: string[]
  hasDocker: boolean
  hasCI: boolean
  ciProvider: string | null
}

const DEP_STACK: [RegExp, string][] = [
  [/^react$/, 'React'],
  [/^react-dom$/, 'React'],
  [/^next$/, 'Next.js'],
  [/^vue$/, 'Vue'],
  [/^svelte$/, 'Svelte'],
  [/^electron$/, 'Electron'],
  [/^electron-builder$/, 'Electron'],
  [/^express$/, 'Express'],
  [/^fastify$/, 'Fastify'],
  [/^monaco-editor$/, 'Monaco'],
  [/^typescript$/, 'TypeScript'],
  [/^tailwindcss$/, 'Tailwind CSS'],
  [/^@tailwindcss\/vite$/, 'Tailwind CSS'],
  [/^zustand$/, 'Zustand'],
  [/^prisma$/, 'Prisma'],
  [/^vitest$/, 'Vitest'],
  [/^jest$/, 'Jest'],
  [/^vite$/, 'Vite'],
]

/** Detect the infrastructure profile of the open workspace. */
export function detectInfra(snap: ProjectIndexSnapshot): InfraProfile {
  const pkg = snap.packageJson || {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const stack: string[] = []
  for (const [re, label] of DEP_STACK) {
    if (Object.keys(deps).some((d) => re.test(d)) && !stack.includes(label)) {
      stack.push(label)
    }
  }
  if (snap.keyFiles['pyproject.toml'] || snap.keyFiles['requirements.txt']) stack.push('Python')
  if (snap.keyFiles['Cargo.toml']) stack.push('Rust')
  if (snap.keyFiles['go.mod']) stack.push('Go')

  const top = new Set(snap.topLevel)
  const packageManager =
    (top.has('pnpm-lock.yaml') && 'pnpm') ||
    (top.has('yarn.lock') && 'yarn') ||
    (top.has('bun.lockb') && 'bun') ||
    (top.has('package-lock.json') && 'npm') ||
    (top.has('pyproject.toml') && 'pip') ||
    (top.has('Cargo.toml') && 'cargo') ||
    (top.has('go.mod') && 'go') ||
    null

  const scripts: Record<string, string> = pkg.scripts || {}
  const pick = (...names: string[]) => {
    for (const n of names) if (scripts[n]) return scripts[n]
    return null
  }

  const configs: string[] = []
  for (const name of [
    'tsconfig.json',
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    '.github',
    '.gitlab-ci.yml',
    '.circleci',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    '.editorconfig',
    '.eslintrc',
    'vite.config.ts',
  ]) {
    if (top.has(name)) configs.push(name)
  }

  const ciProvider = top.has('.github')
    ? 'github'
    : top.has('.gitlab-ci.yml')
      ? 'gitlab'
      : top.has('.circleci')
        ? 'circleci'
        : top.has('azure-pipelines.yml')
          ? 'azure'
          : null

  return {
    stack,
    packageManager,
    scripts,
    devCommand: pick('dev', 'start', 'serve'),
    buildCommand: pick('build', 'compile'),
    testCommand: pick('test', 'test:unit'),
    configs,
    hasDocker: top.has('Dockerfile') || top.has('docker-compose.yml'),
    hasCI: !!ciProvider,
    ciProvider,
  }
}

/* --------------------------------- prescan ---------------------------------- */

const MAX_SUMMARY_BYTES = 20000
const PRESCAN_FILE_CAP = 300
const SUMMARY_EXCERPT = 4000

interface PrescanOptions {
  maxFiles?: number
  force?: boolean
}

/** Summarize one file with the configured model (one sentence). */
async function summarizeEntry(entry: ProjectIndexEntry): Promise<string | null> {
  const settings = useSettingsStore.getState()
  const { provider, model } = resolveChatModel(settings)
  if (!provider || !model) return null
  let content = ''
  try {
    const res = await api.fs.read(entry.path)
    if (res.binary) return null
    content = res.content.slice(0, SUMMARY_EXCERPT)
  } catch {
    return null
  }
  if (!content.trim()) return null
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

/** Prescan: give the AI a one-line understanding of (almost) every file. */
export async function prescanProject(opts: PrescanOptions = {}): Promise<void> {
  const folder = useAppStore.getState().folder
  if (!folder) return
  if (useKnowledgeStore.getState().scanning) return

  setStatus({ scanning: true, done: 0, total: 0 })
  try {
    const snap = await api.projectIndex.get(folder)
    const entries = snap.entries || []
    setStatus({ files: entries.length })

    const cap = opts.maxFiles ?? PRESCAN_FILE_CAP
    const targets = entries
      .filter((e) => {
        if (e.size === 0 || e.size > MAX_SUMMARY_BYTES) return false
        if (/lock/i.test(e.rel) || e.rel.endsWith('.min.js')) return false
        if (opts.force) return true
        return !e.summary || !e.summaryAt || e.summaryAt < e.mtime
      })
      // Key files and shallow paths first, then by ascending size.
      .sort((a, b) => {
        const ka = snap.keyFiles[a.rel.split('/').pop() || ''] ? 0 : 1
        const kb = snap.keyFiles[b.rel.split('/').pop() || ''] ? 0 : 1
        if (ka !== kb) return ka - kb
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
        batch.map(async (entry) => {
          const summary = await summarizeEntry(entry)
          return { entry, summary }
        }),
      )
      const items = results
        .filter((r): r is { entry: ProjectIndexEntry; summary: string } => !!r.summary)
        .map((r) => ({ rel: r.entry.rel, summary: r.summary!, summaryAt: Date.now() }))
      if (items.length > 0) {
        await api.projectIndex.setSummaries(folder, items)
      }
      done += batch.length
      setStatus({
        done,
        summarized: useKnowledgeStore.getState().summarized + items.length,
      })
    }

    setStatus({ enabled: true })
    // Keep the knowledge fresh from now on.
    startKnowledgeKeeper()
  } finally {
    setStatus({ scanning: false })
  }
}

/* ------------------------------ retrieval ----------------------------------- */

export interface RelevantHit {
  entry: ProjectIndexEntry
  score: number
  includeContent: boolean
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

/** Find a file explicitly mentioned in the query (path-like token). */
export function findMentionedFile(
  query: string,
  entries: ProjectIndexEntry[],
): ProjectIndexEntry | null {
  const tokens = query.split(/\s+/)
  for (const token of tokens) {
    const cleaned = token.replace(/[`'",;:()]/g, '')
    if (!cleaned.includes('/') && !/\.[a-z0-9]{1,5}$/i.test(cleaned)) continue
    const lower = cleaned.toLowerCase()
    // Exact rel path or basename match.
    const exact = entries.find(
      (e) => e.rel.toLowerCase() === lower || e.rel.toLowerCase().endsWith('/' + lower),
    )
    if (exact) return exact
    const base = entries.filter((e) => e.rel.toLowerCase().split('/').pop() === lower)
    if (base.length === 1) return base[0]
    if (base.length > 1) {
      // Prefer the shortest path.
      return base.sort((a, b) => a.rel.length - b.rel.length)[0]
    }
  }
  return null
}

/** Score every indexed file against a natural-language question. */
export function retrieveRelevantFiles(
  entries: ProjectIndexEntry[],
  query: string,
  k = 5,
): RelevantHit[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  // Only meaningful tokens drive symbol/summary matching (not "the", "how"…).
  const keywords = meaningfulTokens(query)
  const mentioned = findMentionedFile(query, entries)
  const hits: RelevantHit[] = []

  for (const entry of entries) {
    let score = 0
    // Path match (fuzzy over the relative path).
    const pathScore = fuzzyScore(query, entry.rel)
    if (pathScore !== null) score += pathScore
    // Basename match on meaningful tokens.
    const base = entry.rel.split('/').pop() || ''
    if (keywords.some((t) => base.toLowerCase().includes(t))) score += 40
    // Symbol match (capped so a file with many exports can't dominate).
    let symbolScore = 0
    for (const sym of entry.symbols) {
      const sl = sym.toLowerCase()
      if (keywords.some((t) => sl.includes(t) || t.includes(sl))) symbolScore += 25
      if (symbolScore >= 60) break
    }
    score += symbolScore
    // Summary keyword match.
    if (entry.summary) {
      const sl = entry.summary.toLowerCase()
      for (const t of keywords) if (sl.includes(t)) score += 8
    }
    // Import graph proximity: files importing matching modules cluster.
    if (entry.imports.some((i) => keywords.some((t) => i.toLowerCase().includes(t)))) score += 6
    // Language mention.
    if (keywords.includes(entry.language)) score += 5
    // Shallow files are slightly more likely to be central.
    score -= entry.rel.split('/').length * 0.5

    if (score > 0 || entry === mentioned) {
      hits.push({ entry, score, includeContent: entry === mentioned })
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(k, mentioned ? k + 1 : k))
}

/** Does the question ask about the project/app itself rather than its code? */
export function isProjectMetaQuery(query: string): boolean {
  const q = query.toLowerCase()
  if (!/\b(app|application|project|program|software|repo|codebase|editor|tool|product)\b/.test(q)) {
    return false
  }
  return /\b(what|why|how|purpose|about|describe|tell|explain)\b/.test(q)
}

/**
 * Build the knowledge context block for a chat/agent prompt: the most
 * relevant files (with summaries), plus the full content of any file the
 * question explicitly mentions.
 */
export interface KnowledgeContext {
  /** Prompt block for the model (null when there is nothing to inject). */
  block: string | null
  /** Relative paths of the files selected for this question. */
  files: string[]
}

/**
 * Same as retrieveRelevantFilesForQuery, but also reports which files were
 * selected so the chat can show what the assistant is reading.
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

  // Always-on optimized context: what the app IS and what it is FOR, straight
  // from the index snapshot (package.json description / README lead) — no
  // file reads, no AI calls. Injected into every chat + agent prompt.
  const header: string[] = []
  if (snap.purpose) {
    const infra = detectInfra(snap)
    const stack = infra.stack.length ? ` Stack: ${infra.stack.join(', ')}.` : ''
    header.push(`About the open project "${snap.name}": ${snap.purpose}${stack}`)
  }

  if (entries.length === 0) {
    return { block: header.length > 0 ? header.join('\n') : null, files: [] }
  }

  const hits = retrieveRelevantFiles(entries, query, k)
  const files = hits.map((h) => h.entry.rel)
  const lines = hits.map((h) => {
    const syms = h.entry.symbols.length ? ` [${h.entry.symbols.slice(0, 6).join(', ')}]` : ''
    const summary = h.entry.summary ? `: ${h.entry.summary.slice(0, 140)}` : ''
    return `- ${h.entry.rel} (${h.entry.language})${summary}${syms}`
  })

  let block = header.length > 0 ? header.join('\n') + '\n\n' : ''
  block += `Relevant files from the project knowledge base (${entries.length} files indexed in ${folder}):\n${lines.join('\n')}`

  // Explicit file mention → include its content so the AI can answer precisely.
  const mentioned = findMentionedFile(query, entries)
  if (mentioned) {
    if (!files.includes(mentioned.rel)) files.push(mentioned.rel)
    try {
      const res = await api.fs.read(mentioned.path)
      if (!res.binary && res.content) {
        block += `\n\nFile mentioned in the question — ${mentioned.rel}:\n\`\`\`${mentioned.language}\n${res.content.slice(0, 6000)}\n\`\`\``
      }
    } catch {
      /* ignore */
    }
  }

  // "What is this app for?" → answer from the cached identity files (README +
  // package.json excerpts already in the snapshot) — still no files re-read.
  if (isProjectMetaQuery(query)) {
    const excerpts: string[] = []
    if (snap.readme?.trim()) {
      excerpts.push(`README excerpt (project identity):\n${snap.readme.trim().slice(0, 1500)}`)
    }
    const pj = snap.keyFiles['package.json']
    if (pj) excerpts.push(`package.json (identity + scripts):\n${pj.slice(0, 1500)}`)
    if (excerpts.length > 0) block += `\n\n${excerpts.join('\n\n')}`
  }
  return { block, files }
}

/** Prompt block only, for callers that just need the text. */
export async function retrieveRelevantFilesForQuery(query: string, k = 5): Promise<string | null> {
  return (await retrieveContextForQuery(query, k)).block
}

/* ------------------------------ knowledge keeper ---------------------------- */

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
      const summary = await summarizeEntry(entry)
      if (summary) items.push({ rel: entry.rel, summary, summaryAt: Date.now() })
    }
    if (items.length > 0) await api.projectIndex.setSummaries(folder, items)
  } finally {
    setStatus({ scanning: false })
  }
}

/** Keep summaries fresh: re-summarize files that change on disk. */
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

/** Start the keeper if the workspace already has built knowledge. */
export async function maybeStartKnowledgeKeeper(): Promise<void> {
  const folder = useAppStore.getState().folder
  if (!folder) return
  try {
    const snap = await api.projectIndex.get(folder)
    const summarized = (snap.entries || []).filter((e) => e.summary).length
    if (summarized > 0) {
      setStatus({
        enabled: true,
        summarized,
        files: snap.entries.length,
      })
      startKnowledgeKeeper()
    }
  } catch {
    /* ignore */
  }
}
