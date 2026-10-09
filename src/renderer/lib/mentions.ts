/**
 * `@` mentions in the chat composer. Three kinds:
 *  - `@src/file.ts`   a file: its full content is put in the prompt
 *  - `@src/folder/`   a folder: its files, summaries and symbols go in the prompt
 *  - `@symbol:Name`   a symbol: the code where it is defined goes in the prompt
 * Typing `symbol:` after the `@` searches symbol names; otherwise files and
 * folders are offered.
 */
import { api } from '../api'
import { fuzzyScore } from './fuzzy'

export interface MentionMatch {
  /** Index of the `@` character. */
  start: number
  /** Caret position (end of the partial token). */
  end: number
  query: string
}

export type MentionKind = 'file' | 'folder' | 'symbol' | 'codebase'

export interface MentionItem {
  kind: MentionKind
  /** The text after `@` that is inserted, e.g. `src/a.ts`, `src/lib/`, `symbol:render`. */
  value: string
  label: string
  detail: string
}

export interface MentionIndex {
  files: string[]
  folders: Array<{ path: string; count: number }>
  symbols: Array<{ name: string; rel: string }>
}

export const SYMBOL_PREFIX = 'symbol:'

/** The `@token` ending at the caret, or null when the caret is not inside one. */
export function activeMention(text: string, caret: number): MentionMatch | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  return { start: before.length - m[2].length - 1, end: caret, query: m[2] }
}

/** Replace the active `@token` with `@value ` and return the new text and caret. */
export function insertMention(text: string, match: MentionMatch, value: string): { text: string; caret: number } {
  const insert = `@${value} `
  return {
    text: text.slice(0, match.start) + insert + text.slice(match.end),
    caret: match.start + insert.length,
  }
}

/** Rank the mention candidates for a query (best first). */
export function rankMentions(index: MentionIndex, query: string, limit = 8): MentionItem[] {
  if (query.toLowerCase().startsWith(SYMBOL_PREFIX)) {
    const q = query.slice(SYMBOL_PREFIX.length)
    const seen = new Set<string>()
    const scored: Array<{ item: MentionItem; score: number }> = []
    for (const sym of index.symbols) {
      if (seen.has(sym.name)) continue
      const score = q ? fuzzyScore(q, sym.name) : 0
      if (score === null) continue
      seen.add(sym.name)
      scored.push({
        item: { kind: 'symbol', value: `${SYMBOL_PREFIX}${sym.name}`, label: sym.name, detail: sym.rel },
        score,
      })
    }
    return sortTake(scored, limit)
  }

  const scored: Array<{ item: MentionItem; score: number }> = []
  // @codebase: search the whole codebase index, like Cursor's @Codebase. Offered first.
  const cb = query ? fuzzyScore(query, 'codebase') : 0
  if (cb !== null) {
    scored.push({
      item: { kind: 'codebase', value: 'codebase', label: '@codebase', detail: 'search the whole codebase index' },
      score: query ? cb + 1000 : 1e6,
    })
  }
  for (const f of index.files) {
    const score = query ? fuzzyScore(query, f) : 0
    if (score === null) continue
    scored.push({
      item: { kind: 'file', value: f, label: basename(f), detail: f },
      score,
    })
  }
  for (const d of index.folders) {
    const score = query ? fuzzyScore(query, `${d.path}/`) : -1
    if (score === null) continue
    scored.push({
      item: { kind: 'folder', value: `${d.path}/`, label: `${d.path}/`, detail: `${d.count} file${d.count === 1 ? '' : 's'}` },
      score,
    })
  }
  return sortTake(scored, limit)
}

function sortTake(scored: Array<{ item: MentionItem; score: number }>, limit: number): MentionItem[] {
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item)
}

function basename(path: string): string {
  return path.split('/').pop() || path
}

/** Folders with their file counts, including every ancestor directory. */
export function folderCounts(files: string[], maxDepth = 6): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>()
  for (const rel of files) {
    const parts = rel.split('/').slice(0, -1)
    for (let i = 1; i <= Math.min(parts.length, maxDepth); i++) {
      const dir = parts.slice(0, i).join('/')
      counts.set(dir, (counts.get(dir) ?? 0) + 1)
    }
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count)
}

let cache: { folder: string; index: MentionIndex; at: number } | null = null

/** Files, folders and symbols from the (cached) project index. Cached for 30 seconds. */
export async function loadMentionIndex(folder: string): Promise<MentionIndex> {
  if (cache && cache.folder === folder && Date.now() - cache.at < 30_000) return cache.index
  const empty: MentionIndex = { files: [], folders: [], symbols: [] }
  try {
    const snap = await api.projectIndex.get(folder)
    const entries = snap.entries || []
    const files = entries.map((e) => e.rel)
    const symbols: Array<{ name: string; rel: string }> = []
    for (const e of entries) for (const name of e.symbols) symbols.push({ name, rel: e.rel })
    const index: MentionIndex = { files, folders: folderCounts(files), symbols }
    cache = { folder, index, at: Date.now() }
    return index
  } catch {
    return empty
  }
}

/** Every mention token in a message (without the `@`), trailing punctuation removed. */
export function parseMentionTokens(text: string): string[] {
  const out: string[] = []
  const re = /(^|\s)@([^\s@]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const token = m[2].replace(/[.,;:!?)\]}'"`]+$/, '')
    if (token) out.push(token)
  }
  return [...new Set(out)]
}
