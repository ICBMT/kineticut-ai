/**
 * The prompt block for `@folder/` and `@symbol:Name` mentions. (`@file` mentions
 * are handled by the knowledge base, which includes the file itself.) Everything
 * comes from the project index and the on-demand file read, so no extra AI pass runs.
 */
import { api } from '../api'
import type { ProjectIndexEntry } from '../../shared/types'
import { CHAT_PREFIX, parseMentionTokens, RULE_PREFIX, ruleNameOf, SYMBOL_PREFIX } from './mentions'
import { formatHits, searchCodebase, stripMentions } from './codebase'
import { clampRules, parseCursorRule } from './rules'
import { computeHunks } from './diffHunks'

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
    } else if (token.toLowerCase() === 'codebase') {
      const { hits } = await searchCodebase(folder, stripMentions(query), 8)
      if (hits.length) parts.push(`Codebase search results for the question:\n\n${formatHits(hits)}`)
    } else if (token.toLowerCase().startsWith(RULE_PREFIX)) {
      parts.push(await ruleBlock(folder, token.slice(RULE_PREFIX.length), entries))
    } else if (token.toLowerCase().startsWith(CHAT_PREFIX)) {
      parts.push(await pastChatBlock(token.slice(CHAT_PREFIX.length)))
    } else if (token.toLowerCase() === 'git') {
      parts.push(await gitBlock(folder))
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

const RULE_CHARS = 6000
const CHAT_CHARS = 9000
const CHAT_MESSAGE_CHARS = 1500
const CHAT_LAST_MESSAGES = 12
const GIT_FILES_CAP = 4
const GIT_DIFF_LINES = 120

/** A manual rule (`@rule:name`): its full text, applied to this request. */
async function ruleBlock(folder: string, name: string, entries: ProjectIndexEntry[]): Promise<string> {
  const rel = entries.map((e) => e.rel).find((r) => ruleNameOf(r)?.toLowerCase() === name.toLowerCase())
  if (!rel) return `Rule ${name} — no file at .cursor/rules/${name}.mdc.`
  try {
    const file = await api.projectIndex.file(folder, rel)
    if (file.binary) return `Rule ${rel} is not text.`
    const rule = parseCursorRule(rel, file.content)
    const { text, truncated } = clampRules(rule.body, RULE_CHARS)
    return `Rule ${rel}${rule.description ? ` (${rule.description})` : ''}, requested with @rule:${name}. Apply it to this request:\n${text}${truncated ? '\n(truncated)' : ''}`
  } catch {
    return `Rule ${rel} could not be read.`
  }
}

/** A past chat (`@chat:id`): its latest messages, trimmed to a budget. */
async function pastChatBlock(id: string): Promise<string> {
  const { useAIStore } = await import('../store/ai')
  const session = useAIStore.getState().sessions.find((s) => s.id === id)
  if (!session) return 'Past chat not found (it may have been deleted).'
  const lines: string[] = []
  let used = 0
  for (const m of session.messages.filter((x) => x.role === 'user' || x.role === 'assistant').slice(-CHAT_LAST_MESSAGES).reverse()) {
    const split = m.content.indexOf('\n\n<attached-selection')
    const visible = (split >= 0 ? m.content.slice(0, split) : m.content).slice(0, CHAT_MESSAGE_CHARS)
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${visible}`
    if (used + line.length > CHAT_CHARS) break
    lines.unshift(line)
    used += line.length
  }
  return `Past chat "${session.title}" (latest messages):\n${lines.join('\n\n')}`
}

/** `@git`: the branch, the changed files, and the diffs of the first few. */
async function gitBlock(folder: string): Promise<string> {
  let status
  try {
    status = await api.git.status(folder)
  } catch {
    return 'Git: this folder is not a git repository, or git is unavailable.'
  }
  const changed = [...status.conflicted, ...status.staged, ...status.modified, ...status.untracked]
  const head = `Git on ${status.branch ?? 'a detached HEAD'}${status.ahead ? `, ${status.ahead} ahead` : ''}${status.behind ? `, ${status.behind} behind` : ''}.`
  if (changed.length === 0) return `${head} Working tree clean.`
  const listing = changed.map((f) => `- ${f.path} (${f.status})`).join('\n')
  const diffs: string[] = []
  for (const f of changed.slice(0, GIT_FILES_CAP)) {
    try {
      const d = await api.git.show(folder, f.path)
      if (d.binary) continue
      const out: string[] = []
      for (const h of computeHunks(d.original, d.modified)) {
        out.push(...h.oldLines.map((l) => `- ${l}`), ...h.newLines.map((l) => `+ ${l}`))
      }
      if (out.length) diffs.push(`${f.path}:\n${out.slice(0, GIT_DIFF_LINES).join('\n')}`)
    } catch {
      /* unreadable diff: list only */
    }
  }
  const more = changed.length > GIT_FILES_CAP ? `\n(${changed.length - GIT_FILES_CAP} more files not shown)` : ''
  return `${head}\nChanged files:\n${listing}${diffs.length ? `\n\nDiffs:\n${diffs.join('\n\n')}` : ''}${more}`
}
