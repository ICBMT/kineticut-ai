import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../api'
import type { FileTree, GitStatus, SystemInfo } from '../../shared/types'

export type SidebarView = 'explorer' | 'search' | 'git' | 'chat' | 'settings'

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error' | 'warning'
  title: string
  message?: string
  duration?: number
}

export interface DiffRequest {
  path: string
  original: string
  modified: string
  language: string
  title?: string
  onApply?: (modified: string) => void | Promise<void>
  resolve: (ok: boolean) => void
}

export interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export interface PromptRequest {
  title: string
  label: string
  placeholder?: string
  initial?: string
  resolve: (value: string | null) => void
}

export interface EditorSelectionInfo {
  path: string
  text: string
  label: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

interface AppState {
  ready: boolean
  system: SystemInfo | null
  folder: string | null
  recentFolders: string[]
  recentFiles: string[]
  fileIndex: FileTree | null
  sidebarVisible: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  panelOpen: boolean
  panelHeight: number

  gitStatus: GitStatus | null
  gitLoading: boolean

  problems: { errors: number; warnings: number }
  selectionInfo: { line: number; column: number; selected: number } | null
  editorSelection: EditorSelectionInfo | null
  askAiAnchor: { x: number; y: number } | null

  toasts: Toast[]
  diffRequest: DiffRequest | null
  confirmRequest: ConfirmRequest | null
  promptRequest: PromptRequest | null
  paletteOpen: boolean
  quickOpenOpen: boolean

  setReady(v: boolean): void
  setSystem(s: SystemInfo): void
  setFolder(path: string | null): void
  setFileIndex(t: FileTree | null): void
  setSidebarVisible(v: boolean): void
  toggleSidebar(): void
  setSidebarView(v: SidebarView): void
  setSidebarWidth(w: number): void
  setPanelOpen(v: boolean): void
  togglePanel(): void
  setPanelHeight(h: number): void

  refreshGit(): Promise<void>

  setProblems(p: { errors: number; warnings: number }): void
  setSelectionInfo(s: { line: number; column: number; selected: number } | null): void
  setEditorSelection(s: EditorSelectionInfo | null): void
  setAskAiAnchor(a: { x: number; y: number } | null): void

  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: string): void

  requestDiff(req: Omit<DiffRequest, 'resolve'> & { resolve: (ok: boolean) => void }): void
  clearDiff(): void
  requestConfirm(req: Omit<ConfirmRequest, 'resolve'> & { resolve: (ok: boolean) => void }): void
  clearConfirm(): void
  requestPrompt(req: Omit<PromptRequest, 'resolve'> & { resolve: (value: string | null) => void }): void
  clearPrompt(): void

  setPaletteOpen(v: boolean): void
  setQuickOpenOpen(v: boolean): void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ready: false,
      system: null,
      folder: null,
      recentFolders: [],
      recentFiles: [],
      fileIndex: null,
      sidebarVisible: true,
      sidebarView: 'explorer',
      sidebarWidth: 260,
      panelOpen: false,
      panelHeight: 260,
      gitStatus: null,
      gitLoading: false,
      problems: { errors: 0, warnings: 0 },
      selectionInfo: null,
      editorSelection: null,
      askAiAnchor: null,
      toasts: [],
      diffRequest: null,
      confirmRequest: null,
      promptRequest: null,
      paletteOpen: false,
      quickOpenOpen: false,

      setReady: (v) => set({ ready: v }),
      setSystem: (s) => set({ system: s }),

      setFolder: (path) => {
        set((s) => {
          const recentFolders = path
            ? [path, ...s.recentFolders.filter((p) => p !== path)].slice(0, 10)
            : s.recentFolders
          return { folder: path, recentFolders, fileIndex: null, gitStatus: null }
        })
        if (path) void get().refreshGit()
      },

      setFileIndex: (t) => set({ fileIndex: t }),
      setSidebarVisible: (v) => set({ sidebarVisible: v }),
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarView: (v) => set({ sidebarView: v, sidebarVisible: true }),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.min(600, Math.max(180, w)) }),
      setPanelOpen: (v) => set({ panelOpen: v }),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      setPanelHeight: (h) => set({ panelHeight: Math.min(700, Math.max(120, h)) }),

      refreshGit: async () => {
        const folder = get().folder
        if (!folder) {
          set({ gitStatus: null })
          return
        }
        set({ gitLoading: true })
        try {
          const status = await api.git.status(folder)
          set({ gitStatus: status, gitLoading: false })
        } catch {
          set({ gitStatus: null, gitLoading: false })
        }
      },

      setProblems: (p) => set({ problems: p }),
      setSelectionInfo: (s) => set({ selectionInfo: s }),
      setEditorSelection: (s) => set({ editorSelection: s }),
      setAskAiAnchor: (a) => set({ askAiAnchor: a }),

      toast: (t) => {
        const id = Math.random().toString(36).slice(2)
        set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

      requestDiff: (req) => set({ diffRequest: req as DiffRequest }),
      clearDiff: () => set({ diffRequest: null }),
      requestConfirm: (req) => set({ confirmRequest: req as ConfirmRequest }),
      clearConfirm: () => set({ confirmRequest: null }),
      requestPrompt: (req) => set({ promptRequest: req as PromptRequest }),
      clearPrompt: () => set({ promptRequest: null }),

      setPaletteOpen: (v) => set({ paletteOpen: v }),
      setQuickOpenOpen: (v) => set({ quickOpenOpen: v }),
    }),
    {
      name: 'kineticut.app.v1',
      partialize: (s) => ({
        folder: s.folder,
        recentFolders: s.recentFolders,
        recentFiles: s.recentFiles,
        sidebarView: s.sidebarView,
        sidebarWidth: s.sidebarWidth,
        sidebarVisible: s.sidebarVisible,
        panelOpen: s.panelOpen,
        panelHeight: s.panelHeight,
      }),
    },
  ),
)
