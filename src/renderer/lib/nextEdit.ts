/**
 * Next-edit suggestions: the inline completion that follows what the user is
 * typing. It sees the code around the cursor, the last few edits in this file
 * (so a rename started above is continued below), and the signatures of the
 * project symbols this file imports. Suggestions can span several lines.
 */
import { api } from '../api'
import type { ProjectIndexEntry } from '../../shared/types'
import { stripCodeFences } from './markdown'
import { resolveImport } from './projectKnowledge'

export const COMPLETION_MAX_TOKENS = 512
export const COMPLETION_MAX_CHARS = 3000

/* ------------------------------- recent edits ------------------------------ */

export interface RecentEdit {
  /** Line where the edit started (1-based). */
  line: number
  /** Text inserted (capped). */
  inserted: string
  /** Characters removed. */
  removed: number
  at: number
}

const RECENT_KEEP = 4
const RECENT_TTL_MS = 10 * 60_000
const recentByPath = new Map<string, RecentEdit[]>()

/** Record the changes of one model update so the next suggestion can follow them. */
export function recordEdits(
  path: string,
  changes: ReadonlyArray<{ range: { startLineNumber: number }; text: string; rangeLength: number }>,
): void {
  if (changes.length === 0) return
  const now = Date.now()
  const list = (recentByPath.get(path) ?? []).filter((e) => now - e.at < RECENT_TTL_MS)
  for (const c of changes) {
    // Ignore pure auto-indent and empty edits: they say nothing about intent.
    if (c.text === '' && c.rangeLength === 0) continue
    list.push({ line: c.range.startLineNumber, inserted: c.text.slice(0, 240), removed: c.rangeLength, at: now })
  }
  recentByPath.set(path, list.slice(-RECENT_KEEP))
}

export function recentEditsFor(path: string): RecentEdit[] {
  const now = Date.now()
  return (recentByPath.get(path) ?? []).filter((e) => now - e.at < RECENT_TTL_MS)
}

/* ------------------------------ prompt building ---------------------------- */

export const INLINE_SYSTEM_PROMPT = `You are the next-edit engine of a code editor.
Given the file path, the code before the cursor (<before>), the code after it (<after>), optionally the user's recent edits in this file (<recent_edits>) and signatures of symbols this file imports (<related>), output ONLY the code to insert at the cursor.
Rules:
- Output only raw code. No explanations, no markdown fences.
- Continue the user's pattern. If a recent edit renamed or changed something, apply the same change here when it fits.
- You may write several lines when the edit clearly continues (a block, a matching case, a missing body). Otherwise write one short line.
- Do not repeat code already present in <before> or <after>.
- Match the surrounding indentation and style exactly. Use the signatures in <related> for correct names and arguments.
- If nothing should be inserted, output nothing.`

export function buildInlinePrompt(args: {
  path: string
  prefix: string
  suffix: string
  recent: RecentEdit[]
  related: string
}): string {
  const parts: string[] = [`<file path="${args.path}">`]
  if (args.related) parts.push(`<related>\n${args.related}\n</related>`)
  if (args.recent.length) {
    const lines = args.recent.map((e) => {
      const verb = e.inserted && e.removed ? 'replaced' : e.inserted ? 'inserted' : 'deleted'
      const text = e.inserted ? ` ${JSON.stringify(e.inserted)}` : e.removed ? ` ${e.removed} character(s)` : ''
      return `- line ${e.line}: ${verb}${text}`
    })
    parts.push(`<recent_edits>\n${lines.join('\n')}\n</recent_edits>`)
  }
  parts.push(`<before>\n${args.prefix}\n</before>`)
  parts.push(`<after>\n${args.suffix}\n</after>`)
  parts.push('</file>')
  return parts.join('\n')
}

/* ------------------------------ cleaning output ---------------------------- */

/**
 * Turn the raw model output into text Monaco can insert: no fences, no leading
 * blank lines, no duplicated indentation, no trailing blank lines, and a size cap.
 */
export function cleanCompletion(raw: string, prefix: string): string {
  let out = stripCodeFences(raw).replace(/^\n+/, '')
  // The cursor line may already hold the indentation the model repeated.
  const lineBefore = prefix.split('\n').pop() ?? ''
  if (lineBefore.trim() === '' && lineBefore.length > 0 && out.startsWith(lineBefore)) {
    out = out.slice(lineBefore.length)
  }
  out = out.replace(/\s+$/, '')
  if (out.length > COMPLETION_MAX_CHARS) {
    const cut = out.lastIndexOf('\n', COMPLETION_MAX_CHARS)
    out = out.slice(0, cut > COMPLETION_MAX_CHARS / 2 ? cut : COMPLETION_MAX_CHARS)
  }
  return out
}

/* --------------------------------- cache ----------------------------------- */

/** Small LRU of completions, keyed by the text around the cursor. */
export class CompletionCache {
  private map = new Map<string, string>()
  constructor(private limit = 60) {}

  key(path: string, prefix: string, suffix: string): string {
    return `${path}\u0000${prefix.slice(-400)}\u0000${suffix.slice(0, 120)}`
  }

  get(key: string): string | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      // Refresh recency.
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: string, value: string): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string)
  }

  clear(): void {
    this.map.clear()
  }
}

/* ------------------------------ related symbols ---------------------------- */

const IMPORT_RE = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const MAX_RELATED_TARGETS = 4
const MAX_RELATED_CHARS = 1800
const SIGNATURE_LINE = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/

interface ImportSpec {
  spec: string
  names: string[] | null
}

/** The imports in a file's header, with the names taken from named imports (null = all). */
export function parseImports(source: string): ImportSpec[] {
  const head = source.slice(0, 12000)
  const out: ImportSpec[] = []
  let m: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(head)) && out.length < 60) {
    const clause = m[2]
    const braces = /\{([^}]*)\}/.exec(clause)
    const names = braces
      ? braces[1]
          .split(',')
          .map((n) => n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''))
          .filter(Boolean)
      : null
    out.push({ spec: m[3], names: names && names.length ? names : null })
  }
  return out
}

/** Exported declaration signatures of one file, filtered to the wanted names. */
export function signaturesOf(source: string, wanted: string[] | null): string[] {
  const lines = source.split('\n')
  const sigs: string[] = []
  for (let i = 0; i < lines.length && sigs.length < 14; i++) {
    const m = SIGNATURE_LINE.exec(lines[i])
    if (!m) continue
    if (wanted && !wanted.includes(m[1])) continue
    sigs.push(lines[i].trim().replace(/\s*\{\s*$/, '').slice(0, 160))
  }
  return sigs
}

interface EntriesCache {
  folder: string
  entries: ProjectIndexEntry[]
  at: number
}
let entriesCache: EntriesCache | null = null
const fileCache = new Map<string, { content: string; at: number }>()
const FILE_TTL_MS = 30_000

async function entriesFor(folder: string): Promise<ProjectIndexEntry[]> {
  if (entriesCache && entriesCache.folder === folder && Date.now() - entriesCache.at < FILE_TTL_MS) {
    return entriesCache.entries
  }
  try {
    const snap = await api.projectIndex.get(folder)
    entriesCache = { folder, entries: snap.entries || [], at: Date.now() }
    return entriesCache.entries
  } catch {
    return []
  }
}

async function contentOf(folder: string, rel: string): Promise<string | null> {
  const key = `${folder}\u0000${rel}`
  const hit = fileCache.get(key)
  if (hit && Date.now() - hit.at < FILE_TTL_MS) return hit.content
  try {
    const file = await api.projectIndex.file(folder, rel)
    if (file.binary) return null
    fileCache.set(key, { content: file.content, at: Date.now() })
    return file.content
  } catch {
    return null
  }
}

/**
 * Signatures of the project symbols this file imports, as a block for the prompt.
 * `path` is the file's absolute path; `folder` is the open project.
 */
export async function relatedContext(folder: string | null, path: string, source: string): Promise<string> {
  if (!folder || !path.startsWith(folder)) return ''
  const rel = path.slice(folder.length).replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const imports = parseImports(source).filter((i) => i.spec.startsWith('.'))
  if (imports.length === 0) return ''

  const entries = await entriesFor(folder)
  const byRel = new Map(entries.map((e) => [e.rel, e]))
  const blocks: string[] = []
  let total = 0
  let targets = 0
  for (const imp of imports) {
    if (targets >= MAX_RELATED_TARGETS || total >= MAX_RELATED_CHARS) break
    const target = resolveImport(rel, imp.spec, byRel)
    if (!target) continue
    targets++
    const content = await contentOf(folder, target)
    if (!content) continue
    const sigs = signaturesOf(content, imp.names)
    if (sigs.length === 0) continue
    const block = `${target}:\n${sigs.map((s) => `  ${s}`).join('\n')}`
    if (total + block.length > MAX_RELATED_CHARS) break
    blocks.push(block)
    total += block.length
  }
  return blocks.join('\n')
}
