/**
 * Workspace ignore rules, the way Cursor reads them: `.gitignore` and
 * `.cursorignore` at the workspace root, in gitignore syntax. Files matched by
 * either are not indexed, not summarised and not offered to the AI.
 *
 * Shared by the Electron main process and the browser-preview dev server.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import ignore from 'ignore'

export const IGNORE_FILES = ['.gitignore', '.cursorignore']

/** Rules for one workspace root. `ignores(rel, isDir)` takes a forward-slash path relative to the root. */
export async function loadIgnoreRules(root) {
  const matcher = ignore()
  const sources = []
  for (const name of IGNORE_FILES) {
    try {
      matcher.add(await fs.readFile(join(root, name), 'utf8'))
      sources.push(name)
    } catch {
      /* no such file */
    }
  }
  return {
    sources,
    ignores(rel, isDir = false) {
      if (!rel || rel.startsWith('..') || rel.startsWith('/')) return false
      try {
        return matcher.ignores(isDir ? `${rel}/` : rel)
      } catch {
        return false
      }
    },
  }
}

/** True when a change to this root-relative path changes the rules themselves. */
export function isIgnoreFile(rel) {
  return IGNORE_FILES.includes(rel)
}
