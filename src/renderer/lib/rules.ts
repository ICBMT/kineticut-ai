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

let cache: { key: string; at: number; block: string } | null = null

/**
 * The rules block for the open project, or '' when there is none. The file is
 * read at most every few seconds, so each chat turn does not hit the disk twice.
 */
export async function loadRulesBlock(): Promise<string> {
  const { folder, fileIndex } = useAppStore.getState()
  if (!folder) return ''
  const rel = pickRuleFile(relativeFilePaths(fileIndex, folder))
  if (!rel) return ''
  if (cache && cache.key === `${folder}|${rel}` && Date.now() - cache.at < 5000) return cache.block
  let block = ''
  try {
    const res = await api.fs.read(joinPath(folder, rel))
    if (!res.binary && res.content.trim()) {
      const { text, truncated } = clampRules(res.content)
      block = `Project rules from ${rel} (standing instructions from the user; follow them):\n${text}${truncated ? '\n(rules were truncated to fit)' : ''}`
    }
  } catch {
    block = ''
  }
  cache = { key: `${folder}|${rel}`, at: Date.now(), block }
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
