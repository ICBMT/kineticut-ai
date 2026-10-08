import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../api'
import { languageForPath } from '../lib/languages'
import { useAppStore } from './app'

export interface EditorTab {
  path: string
  name: string
  language: string
}

/** A split editor group: its own tab strip and editor pane. */
export interface EditorGroup {
  id: string
  tabs: EditorTab[]
  activePath: string | null
}

export interface PendingReveal {
  path: string
  line: number
  column: number
}

const MAX_GROUPS = 4

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

interface EditorState {
  groups: EditorGroup[]
  activeGroupId: string
  dirty: Record<string, boolean>
  pendingReveal: PendingReveal | null

  newGroup(): string
  closeGroup(id: string): void
  setActiveGroup(id: string): void
  /** Create a new (empty) editor group for splitting. Returns its id. */
  splitGroup(): string
  openTab(path: string, groupId?: string): void
  closeTab(path: string): void
  moveTab(path: string, toGroupId: string): void
  setActive(path: string): void
  renameTab(oldPath: string, newPath: string): void
  markDirty(path: string, value: boolean): void
  isDirty(path: string): boolean
  setPendingReveal(reveal: PendingReveal | null): void
  activeGroup(): EditorGroup
  activeTab(): EditorTab | null
  tabFor(path: string): EditorTab | undefined
  allTabs(): EditorTab[]
}

function makeGroup(): EditorGroup {
  return { id: uid(), tabs: [], activePath: null }
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
      groups: [makeGroup()],
      activeGroupId: '',
      dirty: {},
      pendingReveal: null,

      activeGroup: () => {
        const { groups, activeGroupId } = get()
        return groups.find((g) => g.id === activeGroupId) || groups[0]
      },

      activeTab: () => {
        const g = get().activeGroup()
        return g.tabs.find((t) => t.path === g.activePath) || null
      },

      allTabs: () => get().groups.flatMap((g) => g.tabs),

      tabFor: (path) => get().allTabs().find((t) => t.path === path),

      newGroup: () => {
        let id = ''
        set((s) => {
          if (s.groups.length >= MAX_GROUPS) return {}
          const g = makeGroup()
          id = g.id
          return { groups: [...s.groups, g], activeGroupId: g.id }
        })
        return id || get().activeGroupId
      },

      splitGroup: () => get().newGroup(),

      closeGroup: (id) =>
        set((s) => {
          if (s.groups.length <= 1) return {}
          const groups = s.groups.filter((g) => g.id !== id)
          return {
            groups,
            activeGroupId: s.activeGroupId === id ? groups[0].id : s.activeGroupId,
          }
        }),

      setActiveGroup: (id) =>
        set((s) => (s.groups.some((g) => g.id === id) ? { activeGroupId: id } : {})),

      openTab: (path, groupId) => {
        set((s) => {
          const target =
            (groupId && s.groups.find((g) => g.id === groupId)) ||
            s.groups.find((g) => g.id === s.activeGroupId) ||
            s.groups[0]
          const groups = s.groups.map((g) => {
            if (g.id !== target.id) return g
            if (g.tabs.some((t) => t.path === path)) {
              return { ...g, activePath: path }
            }
            const name = path.split(/[/\\]/).pop() || path
            const tab: EditorTab = { path, name, language: languageForPath(path) }
            return { ...g, tabs: [...g.tabs, tab], activePath: path }
          })
          return { groups, activeGroupId: target.id }
        })
        // Track recently opened files.
        const recent = useAppStore.getState().recentFiles
        useAppStore.setState({
          recentFiles: [path, ...recent.filter((p) => p !== path)].slice(0, 20),
        })
      },

      closeTab: (path) =>
        set((s) => {
          const groups = s.groups.map((g) => {
            if (!g.tabs.some((t) => t.path === path)) return g
            const idx = g.tabs.findIndex((t) => t.path === path)
            const tabs = g.tabs.filter((t) => t.path !== path)
            let activePath = g.activePath
            if (activePath === path) {
              activePath = tabs.length > 0 ? tabs[Math.min(idx, tabs.length - 1)].path : null
            }
            return { ...g, tabs, activePath }
          })
          const dirty = { ...s.dirty }
          delete dirty[path]
          return { groups, dirty }
        }),

      moveTab: (path, toGroupId) =>
        set((s) => {
          const source = s.groups.find((g) => g.tabs.some((t) => t.path === path))
          const target = s.groups.find((g) => g.id === toGroupId)
          if (!source || !target) return {}
          const tab = source.tabs.find((t) => t.path === path)!
          if (source.id === target.id) {
            // Reorder within the same group: move to end.
            const tabs = source.tabs.filter((t) => t.path !== path)
            return {
              groups: s.groups.map((g) =>
                g.id === source.id ? { ...g, tabs: [...tabs, tab], activePath: path } : g,
              ),
              activeGroupId: source.id,
            }
          }
          if (target.tabs.some((t) => t.path === path)) {
            return {
              groups: s.groups.map((g) =>
                g.id === source.id
                  ? { ...g, tabs: g.tabs.filter((t) => t.path !== path) }
                  : g.id === target.id
                    ? { ...g, activePath: path }
                    : g,
              ),
              activeGroupId: target.id,
            }
          }
          return {
            groups: s.groups.map((g) =>
              g.id === source.id
                ? { ...g, tabs: g.tabs.filter((t) => t.path !== path) }
                : g.id === target.id
                  ? { ...g, tabs: [...g.tabs, tab], activePath: path }
                  : g,
            ),
            activeGroupId: target.id,
          }
        }),

      setActive: (path) =>
        set((s) => {
          const group = s.groups.find((g) => g.tabs.some((t) => t.path === path))
          if (!group) return {}
          return {
            groups: s.groups.map((g) =>
              g.id === group.id ? { ...g, activePath: path } : g,
            ),
            activeGroupId: group.id,
          }
        }),

      renameTab: (oldPath, newPath) =>
        set((s) => ({
          groups: s.groups.map((g) => ({
            ...g,
            tabs: g.tabs.map((t) =>
              t.path === oldPath
                ? {
                    ...t,
                    path: newPath,
                    name: newPath.split(/[/\\]/).pop() || newPath,
                    language: languageForPath(newPath),
                  }
                : t,
            ),
            activePath: g.activePath === oldPath ? newPath : g.activePath,
          })),
          dirty: Object.fromEntries(
            Object.entries(s.dirty).map(([p, v]) => [p === oldPath ? newPath : p, v]),
          ),
        })),

      markDirty: (path, value) => set((s) => ({ dirty: { ...s.dirty, [path]: value } })),
      isDirty: (path) => !!get().dirty[path],
      setPendingReveal: (reveal) => set({ pendingReveal: reveal }),
    }),
    {
      name: 'kineticut.editor.v2',
      partialize: (s) => ({
        groups: s.groups,
        activeGroupId: s.activeGroupId,
      }),
      // Migrate any v1 persisted state (flat tabs) into a single group.
      migrate: (persisted: any) => {
        if (persisted && Array.isArray(persisted.tabs) && !Array.isArray(persisted.groups)) {
          return {
            groups: [
              {
                id: 'group-1',
                tabs: persisted.tabs,
                activePath: persisted.activePath || null,
              },
            ],
            activeGroupId: 'group-1',
          }
        }
        return persisted
      },
      version: 2,
    },
  ),
)

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
