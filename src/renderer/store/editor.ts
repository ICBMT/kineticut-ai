import { create } from 'zustand'
import { api } from '../api'
import { languageForPath } from '../lib/languages'
import { useAppStore } from './app'

export interface EditorTab {
  path: string
  name: string
  language: string
}

export interface PendingReveal {
  path: string
  line: number
  column: number
}

interface EditorState {
  tabs: EditorTab[]
  activePath: string | null
  dirty: Record<string, boolean>
  pendingReveal: PendingReveal | null

  openTab(path: string): void
  closeTab(path: string): void
  closeOthers(path: string): void
  closeAll(): void
  setActive(path: string | null): void
  renameTab(oldPath: string, newPath: string): void
  markDirty(path: string, value: boolean): void
  isDirty(path: string): boolean
  setPendingReveal(reveal: PendingReveal | null): void
  tabFor(path: string): EditorTab | undefined
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,
  dirty: {},
  pendingReveal: null,

  openTab: (path) => {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      set({ activePath: path })
    } else {
      const name = path.split(/[/\\]/).pop() || path
      set((s) => ({
        tabs: [...s.tabs, { path, name, language: languageForPath(path) }],
        activePath: path,
      }))
    }
    // Track recently opened files.
    const recent = useAppStore.getState().recentFiles
    useAppStore.setState({
      recentFiles: [path, ...recent.filter((p) => p !== path)].slice(0, 20),
    })
  },

  closeTab: (path) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path)
      if (idx < 0) return {}
      const tabs = s.tabs.filter((t) => t.path !== path)
      let activePath = s.activePath
      if (activePath === path) {
        activePath = tabs.length > 0 ? tabs[Math.min(idx, tabs.length - 1)].path : null
      }
      const dirty = { ...s.dirty }
      delete dirty[path]
      return { tabs, activePath, dirty }
    }),

  closeOthers: (path) =>
    set((s) => ({
      tabs: s.tabs.filter((t) => t.path === path),
      activePath: s.tabs.some((t) => t.path === path) ? path : s.activePath,
      dirty: Object.fromEntries(Object.entries(s.dirty).filter(([p]) => p === path)),
    })),

  closeAll: () => set({ tabs: [], activePath: null, dirty: {} }),

  setActive: (path) => set({ activePath: path }),

  renameTab: (oldPath, newPath) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === oldPath
          ? { ...t, path: newPath, name: newPath.split(/[/\\]/).pop() || newPath, language: languageForPath(newPath) }
          : t,
      ),
      activePath: s.activePath === oldPath ? newPath : s.activePath,
      dirty: Object.fromEntries(
        Object.entries(s.dirty).map(([p, v]) => [p === oldPath ? newPath : p, v]),
      ),
    })),

  markDirty: (path, value) => set((s) => ({ dirty: { ...s.dirty, [path]: value } })),
  isDirty: (path) => !!get().dirty[path],
  setPendingReveal: (reveal) => set({ pendingReveal: reveal }),
  tabFor: (path) => get().tabs.find((t) => t.path === path),
}))

/** Persist a tab's saved content snapshot (used for dirty tracking). */
const snapshots = new Map<string, string>()

export function getSnapshot(path: string): string | undefined {
  return snapshots.get(path)
}
export function setSnapshot(path: string, content: string): void {
  snapshots.set(path, content)
}
export function deleteSnapshot(path: string): void {
  snapshots.delete(path)
}

/** Read a file from disk (via the API) — used when opening tabs. */
export async function readFileForTab(path: string): Promise<string | null> {
  try {
    const res = await api.fs.read(path)
    return res.binary ? null : res.content
  } catch {
    return null
  }
}
