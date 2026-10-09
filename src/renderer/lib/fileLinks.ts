/**
 * File links in AI answers. An inline code span that names a file in the open
 * project (`src/main/ipc.ts`, `ipc.ts:42`) becomes a button that opens it, so
 * every answer can be checked against the code it came from.
 */
import type { FileTree } from '../../shared/types'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'

interface Index {
  /** project-relative path → absolute path */
  byRel: Map<string, string>
  /** file name → absolute path, only when the name is unique in the project */
  byName: Map<string, string>
}

const cache = new WeakMap<FileTree, { folder: string; index: Index }>()

function buildIndex(tree: FileTree, folder: string): Index {
  const byRel = new Map<string, string>()
  const names = new Map<string, string | null>()
  const prefix = folder.endsWith('/') ? folder : folder + '/'
  const walk = (node: FileTree) => {
    if (node.type === 'file') {
      const rel = node.path.startsWith(prefix) ? node.path.slice(prefix.length) : node.path
      byRel.set(rel, node.path)
      // A name that appears twice is ambiguous: it only links by its full path.
      names.set(node.name, names.has(node.name) ? null : node.path)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  const byName = new Map<string, string>()
  for (const [name, abs] of names) if (abs) byName.set(name, abs)
  return { byRel, byName }
}

/** The absolute path of the project file a piece of text names, or null. */
export function resolveFileLink(text: string): string | null {
  const app = useAppStore.getState()
  if (!app.folder || !app.fileIndex) return null
  const cleaned = text
    .trim()
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
  // Only things that look like a path: a name with an extension, or a path with a slash.
  if (!cleaned || /\s/.test(cleaned) || cleaned.length > 200) return null
  if (!cleaned.includes('/') && !/\.[a-z0-9]{1,6}$/i.test(cleaned)) return null

  let entry = cache.get(app.fileIndex)
  if (!entry || entry.folder !== app.folder) {
    entry = { folder: app.folder, index: buildIndex(app.fileIndex, app.folder) }
    cache.set(app.fileIndex, entry)
  }
  return entry.index.byRel.get(cleaned) ?? (cleaned.includes('/') ? null : entry.index.byName.get(cleaned)) ?? null
}

/** Open a file from an AI answer in the editor. */
export function openFileLink(absolutePath: string): void {
  useEditorStore.getState().openTab(absolutePath)
}
