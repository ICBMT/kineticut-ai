/**
 * The prompt block for `@folder/` and `@symbol:Name` mentions. (`@file` mentions
 * are handled by the knowledge base, which includes the file itself.) Everything
 * comes from the project index and the on-demand file read, so no extra AI pass runs.
 */
import { api } from '../api'
import type { ProjectIndexEntry } from '../../shared/types'
import { parseMentionTokens, SYMBOL_PREFIX } from './mentions'

const FOLDER_FILE_CAP = 60
const SYMBOL_HITS_CAP = 3
const SYMBOL_CHARS = 3000
const SYMBOL_LINES = 70

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Block describing every folder and symbol mentioned in the message, or null. */
export async function mentionBlockFor(
  query: string,
  folder: string,
  entries: ProjectIndexEntry[],
): Promise<string | null> {
  const parts: string[] = []
  for (const token of parseMentionTokens(query)) {
    if (token.toLowerCase().startsWith(SYMBOL_PREFIX)) {
      const name = token.slice(SYMBOL_PREFIX.length)
      if (name) parts.push(await symbolBlock(folder, name, entries))
    } else if (token.endsWith('/') && token.length > 1) {
      parts.push(folderBlock(token.slice(0, -1).replace(/^\.?\//, ''), entries))
    }
  }
  if (parts.length === 0) return null
  return `Mentioned in the message (the user referenced these project parts directly):\n\n${parts.join('\n\n')}`
}

function folderBlock(dir: string, entries: ProjectIndexEntry[]): string {
  const prefix = `${dir}/`
  const inside = entries.filter((e) => e.rel.startsWith(prefix))
  if (inside.length === 0) return `Folder ${prefix} — no indexed files are inside it.`
  const lines = inside.slice(0, FOLDER_FILE_CAP).map((e) => {
    const summary = e.summary ? `: ${e.summary.slice(0, 140)}` : ''
    const syms = e.symbols.length ? ` [${e.symbols.slice(0, 8).join(', ')}]` : ''
    return `- ${e.rel} (${e.language})${summary}${syms}`
  })
  const more = inside.length > FOLDER_FILE_CAP ? `\n… and ${inside.length - FOLDER_FILE_CAP} more files` : ''
  return `Folder ${prefix} — ${inside.length} indexed file${inside.length === 1 ? '' : 's'}:\n${lines.join('\n')}${more}`
}

async function symbolBlock(folder: string, name: string, entries: ProjectIndexEntry[]): Promise<string> {
  let hits = entries.filter((e) => e.symbols.includes(name))
  if (hits.length === 0) {
    const lower = name.toLowerCase()
    hits = entries.filter((e) => e.symbols.some((s) => s.toLowerCase() === lower))
  }
  if (hits.length === 0) return `Symbol \`${name}\` — not found in the project index.`

  const sections: string[] = []
  for (const entry of hits.slice(0, SYMBOL_HITS_CAP)) {
    try {
      const file = await api.projectIndex.file(folder, entry.rel)
      if (file.binary) continue
      const lines = file.content.split('\n')
      const at = definitionLine(lines, name)
      if (at < 0) {
        sections.push(`Symbol \`${name}\` is listed in ${entry.rel}, but its definition could not be located.`)
        continue
      }
      const from = Math.max(0, at - 2)
      const to = Math.min(lines.length, from + SYMBOL_LINES)
      const code = lines.slice(from, to).join('\n').slice(0, SYMBOL_CHARS)
      sections.push(
        `Symbol \`${name}\` — defined in ${entry.rel}, line ${at + 1}:\n\`\`\`${entry.language}\n${code}\n\`\`\``,
      )
    } catch {
      sections.push(`Symbol \`${name}\` is listed in ${entry.rel}, but the file could not be read.`)
    }
  }
  if (hits.length > SYMBOL_HITS_CAP) {
    sections.push(`Also defined in ${hits.length - SYMBOL_HITS_CAP} more file(s): ${hits.slice(SYMBOL_HITS_CAP).map((h) => h.rel).join(', ')}`)
  }
  return sections.join('\n\n')
}

/** Line index of the declaration of `name`, or -1. Declarations win over call-like lines. */
export function definitionLine(lines: string[], name: string): number {
  const esc = escapeRegExp(name)
  const decl = new RegExp(
    `\\b(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|object|module)\\s+${esc}\\b`,
  )
  const i = lines.findIndex((l) => decl.test(l))
  if (i >= 0) return i
  const method = new RegExp(
    `^\\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\\s+)*${esc}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{?\\s*$`,
  )
  return lines.findIndex((l) => method.test(l))
}
