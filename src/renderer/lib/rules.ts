/**
 * Project rules: standing instructions the user keeps in the repository, read
 * into every AI request. The first file found wins, in this order, so a
 * project can use the convention it already has (AGENTS.md, Cursor rules,
 * Copilot instructions) or Kineticut's own .kineticut/rules.md.
 */
import { api } from '../api'
import type { FileTree } from '../../shared/types'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { joinPath } from './utils'

export const RULE_FILE_CANDIDATES = [
  '.kineticut/rules.md',
  'AGENTS.md',
  'KINETICUT.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
] as const

/** Rules are injected into every request, so keep them short. */
export const MAX_RULES_CHARS = 8000

/** Relative, forward-slash paths of every file in the index under `folder`. */
export function relativeFilePaths(tree: FileTree | null, folder: string): Set<string> {
  const out = new Set<string>()
  if (!tree) return out
  const root = folder.replace(/[\\/]+$/, '')
  const walk = (node: FileTree) => {
    if (node.type === 'file') {
      const rel = node.path.startsWith(root) ? node.path.slice(root.length) : node.path
      out.add(rel.replace(/^[\\/]+/, '').replace(/\\/g, '/'))
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return out
}

/** The first rule file the project has, by priority, or null. */
export function pickRuleFile(existing: Set<string>): string | null {
  return RULE_FILE_CANDIDATES.find((c) => existing.has(c)) ?? null
}

/** Cut rules to the budget at a line boundary when possible. */
export function clampRules(text: string, max = MAX_RULES_CHARS): { text: string; truncated: boolean } {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length <= max) return { text: clean, truncated: false }
  const cut = clean.slice(0, max)
  const lastBreak = cut.lastIndexOf('\n')
  return { text: (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd(), truncated: true }
}

/** The starter file the "Create project rules" command writes. */
export const RULES_TEMPLATE = `# Project rules

These instructions are read by Kineticut AI in every chat and agent request.
Keep them short and specific. Delete any line that does not apply.

## What this project is
- (one or two sentences: purpose and main users)

## Stack and commands
- Language and framework:
- Install, build, test, lint commands:

## Conventions
- (naming, folder layout, how new features are wired up)
- (error handling, logging, testing style)

## Do not
- (things the AI must never change or do)
`

/** A Cursor rule file (.cursor/rules/*.mdc): frontmatter plus a body. */
export interface CursorRule {
  path: string
  description: string
  globs: string[]
  alwaysApply: boolean
  body: string
}

/** Parse `---` frontmatter (description, globs, alwaysApply) and the body. */
export function parseCursorRule(path: string, text: string): CursorRule {
  const clean = text.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(clean)
  const meta: Record<string, string> = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim())
      if (kv) meta[kv[1]] = kv[2].trim()
    }
  }
  const body = m ? clean.slice(m[0].length) : clean
  const globs = (meta.globs ?? '')
    .split(',')
    .map((g) => g.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  return {
    path,
    description: (meta.description ?? '').replace(/^["']|["']$/g, ''),
    globs,
    alwaysApply: /^true$/i.test(meta.alwaysApply ?? ''),
    body: body.trim(),
  }
}

/** A glob (`**\/*.ts`, `src/**\/*.tsx`) as a regular expression over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Rules that apply to the open file: always-on rules and rules whose globs match it. */
export function rulesFor(rules: CursorRule[], activeRel: string | null): { always: CursorRule[]; requested: CursorRule[] } {
  const always = rules.filter(
    (r) => r.alwaysApply || (activeRel !== null && r.globs.some((g) => globToRegExp(g).test(activeRel))),
  )
  // Description-only rules are offered to the agent by name; it reads them when relevant.
  const requested = rules.filter((r) => !r.alwaysApply && r.globs.length === 0 && r.description && !always.includes(r))
  return { always, requested }
}

let cache: { key: string; at: number; block: string } | null = null

/** Path of the file open in the editor, relative to the folder, forward-slashed. */
function activeRelPath(folder: string): string | null {
  const active = useEditorStore.getState().activeTab()?.path
  if (!active || !active.startsWith(folder)) return null
  return active.slice(folder.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

/**
 * The rules block for the open project, or '' when there is none: the classic rules
 * file, plus Cursor rules (.cursor/rules/*.mdc) that apply to the open file. The
 * files are read at most every few seconds, so each chat turn does not hit the disk twice.
 */
export async function loadRulesBlock(): Promise<string> {
  const { folder, fileIndex } = useAppStore.getState()
  if (!folder) return ''
  const rels = relativeFilePaths(fileIndex, folder)
  const classicRel = pickRuleFile(rels)
  const ruleFiles = [...rels].filter((r) => /^\.cursor\/rules\/.+\.mdc?$/.test(r)).sort()
  const active = activeRelPath(folder)
  const key = `${folder}|${classicRel ?? ''}|${ruleFiles.join(',')}|${active ?? ''}`
  if (cache && cache.key === key && Date.now() - cache.at < 5000) return cache.block

  const parts: string[] = []
  if (classicRel) {
    try {
      const res = await api.fs.read(joinPath(folder, classicRel))
      if (!res.binary && res.content.trim()) {
        const { text, truncated } = clampRules(res.content)
        parts.push(
          `Project rules from ${classicRel} (standing instructions from the user; follow them):\n${text}${truncated ? '\n(rules were truncated to fit)' : ''}`,
        )
      }
    } catch {
      /* unreadable rules file: skip it */
    }
  }

  const rules: CursorRule[] = []
  for (const rel of ruleFiles) {
    try {
      const res = await api.fs.read(joinPath(folder, rel))
      if (!res.binary) rules.push(parseCursorRule(rel, res.content))
    } catch {
      /* skip */
    }
  }
  const { always, requested } = rulesFor(rules, active)
  if (always.length) {
    const body = always
      .map((r) => `--- ${r.path}${r.description ? ` (${r.description})` : ''}\n${clampRules(r.body, 4000).text}`)
      .join('\n\n')
    parts.push(`Cursor rules that apply (follow them):\n${clampRules(body, MAX_RULES_CHARS).text}`)
  }
  if (requested.length) {
    parts.push(
      `Other rules you can read when they are relevant (read_file the path):\n${requested
        .map((r) => `- ${r.path}: ${r.description}`)
        .join('\n')}`,
    )
  }

  const block = parts.join('\n\n')
  cache = { key, at: Date.now(), block }
  return block
}

/** Forget the cached rules (after the rules file is created or edited). */
export function clearRulesCache(): void {
  cache = null
}

/**
 * Create .kineticut/rules.md from the template and open it, or open the rules
 * file the project already has. Never overwrites an existing rules file.
 */
export async function createRulesFile(): Promise<void> {
  const app = useAppStore.getState()
  if (!app.folder) {
    app.toast({ kind: 'info', title: 'Open a folder first', message: 'Project rules belong to a project.' })
    return
  }
  const existing = pickRuleFile(relativeFilePaths(app.fileIndex, app.folder))
  if (existing) {
    useEditorStore.getState().openTab(joinPath(app.folder, existing))
    app.toast({ kind: 'info', title: `Rules already set in ${existing}`, message: 'Edit that file to change them.' })
    return
  }
  const target = joinPath(app.folder, '.kineticut/rules.md')
  await api.fs.mkdir(joinPath(app.folder, '.kineticut')).catch(() => undefined)
  await api.fs.write(target, RULES_TEMPLATE)
  clearRulesCache()
  useEditorStore.getState().openTab(target)
  app.toast({ kind: 'success', title: 'Created .kineticut/rules.md', message: 'Every AI request in this project now reads it.' })
}
