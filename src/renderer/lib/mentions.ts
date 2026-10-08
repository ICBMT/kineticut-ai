/**
 * `@file` mentions in the chat composer. Typing `@` offers project files; the
 * chosen path is inserted as `@src/file.ts`, and the knowledge base then
 * includes that file's full content in the prompt.
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

/** The `@token` ending at the caret, or null when the caret is not inside one. */
export function activeMention(text: string, caret: number): MentionMatch | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  return { start: before.length - m[2].length - 1, end: caret, query: m[2] }
}

/** Replace the active `@token` with `@rel ` and return the new text and caret. */
export function insertMention(text: string, match: MentionMatch, rel: string): { text: string; caret: number } {
  const insert = `@${rel} `
  return {
    text: text.slice(0, match.start) + insert + text.slice(match.end),
    caret: match.start + insert.length,
  }
}

/** Rank candidate paths against the query (best first). */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit)
  return files
    .map((f) => ({ f, s: fuzzyScore(query, f) }))
    .filter((x): x is { f: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f)
}

let cache: { folder: string; files: string[]; at: number } | null = null

/** Project file paths from the (cached) project index. Cached for 30 seconds. */
export async function loadMentionFiles(folder: string): Promise<string[]> {
  if (cache && cache.folder === folder && Date.now() - cache.at < 30_000) return cache.files
  try {
    const snap = await api.projectIndex.get(folder)
    const files = (snap.entries || []).map((e) => e.rel)
    cache = { folder, files, at: Date.now() }
    return files
  } catch {
    return []
  }
}
