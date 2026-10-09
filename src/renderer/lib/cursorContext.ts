/**
 * Chat context in Cursor mode. Chat (no tools) gets the project's identity and
 * the codebase snippets that match the question. Agent mode gets only the
 * identity and explicit @mentions: the agent searches the codebase itself with
 * its tools (codebase_search, grep_search, file_search, read_file), as Cursor's
 * agent does, so nothing is pre-injected that the agent did not ask for.
 */
import { api } from '../api'
import { parseMentionTokens } from './mentions'
import { mentionBlockFor } from './mentionContext'
import { formatHits, searchCodebase, stripMentions } from './codebase'

export interface CursorContextOptions {
  k?: number
  /** Pull codebase snippets for the question (chat). Agent mode searches with its tools instead. */
  retrieve?: boolean
}

export async function cursorContextFor(
  folder: string,
  query: string,
  { k = 6, retrieve = true }: CursorContextOptions = {},
): Promise<{ block: string | null; files: string[] }> {
  const snap = await api.projectIndex.get(folder).catch(() => null)
  const header: string[] = []
  if (snap) {
    header.push(`About the open project "${snap.name}"${snap.purpose ? `: ${snap.purpose}` : '.'}`)
  }
  // @codebase brings its own results (in mentionBlockFor), so the automatic search is skipped then.
  const explicit = parseMentionTokens(query).some((t) => t.toLowerCase() === 'codebase')
  const hits = retrieve && !explicit ? (await searchCodebase(folder, stripMentions(query), k)).hits : []
  const files = [...new Set(hits.map((h) => h.rel))]
  const parts = [...header]
  if (hits.length) {
    parts.push(`Relevant code from the codebase index (search again with the codebase_search tool for more):\n\n${formatHits(hits)}`)
  }
  const mentioned = await mentionBlockFor(query, folder, snap?.entries ?? [])
  if (mentioned) parts.push(mentioned)
  return { block: parts.length ? parts.join('\n\n') : null, files }
}
