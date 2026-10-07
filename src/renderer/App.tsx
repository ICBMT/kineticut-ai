import { useEffect } from 'react'
import { Zap } from 'lucide-react'
import { api } from './api'
import { installKeybindings } from './commands'
import { Logo } from './components/Logo'
import { syncOpenModelsWithDisk } from './lib/monaco'
import { applyTheme, useSettingsStore } from './store/settings'
import { useAppStore } from './store/app'
import { ActivityBar } from './components/ActivityBar'
import { CommandPalette } from './components/CommandPalette'
import { ConfirmModal, DiffModal, PromptModal } from './components/modals'
import { EditorArea } from './components/EditorArea'
import { QuickOpen } from './components/QuickOpen'
import { SideBar } from './components/SideBar'
import { StatusBar } from './components/StatusBar'
import { TerminalPanel } from './components/TerminalPanel'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'

async function boot() {
  const settings = useSettingsStore.getState()
  await settings.load()
  applyTheme(useSettingsStore.getState().theme)
  try {
    const info = await api.system.info()
    useAppStore.getState().setSystem(info)
  } catch {
    /* ignore */
  }
  // Restore the last workspace (or fall back to the home/cwd).
  const persistedFolder = useAppStore.getState().folder
  const initial = persistedFolder || useAppStore.getState().system?.cwd || null
  if (initial) {
    try {
      const st = await api.fs.stat(initial)
      if (st.exists && st.type === 'directory') {
        useAppStore.getState().setFolder(initial)
      }
    } catch {
      /* ignore */
    }
  }
  useAppStore.getState().setReady(true)
}

export function App() {
  const ready = useAppStore((s) => s.ready)
  const sidebarVisible = useAppStore((s) => s.sidebarVisible)
  const folder = useAppStore((s) => s.folder)
  const theme = useSettingsStore((s) => s.theme)

  useEffect(() => {
    installKeybindings()
  }, [])

  useEffect(() => {
    void boot()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Watch the workspace: refresh the file index, git status, and open editors.
  useEffect(() => {
    if (!folder) return
    let disposed = false
    let unwatch: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    void (async () => {
      try {
        useAppStore.getState().setFileIndex(await api.fs.tree(folder, 10))
      } catch {
        /* ignore */
      }
      unwatch = await api.fs.watch(folder, () => {
        if (disposed) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          if (disposed) return
          api.fs
            .tree(folder, 10)
            .then((t) => {
              if (!disposed) useAppStore.getState().setFileIndex(t)
            })
            .catch(() => {})
          void syncOpenModelsWithDisk()
          void useAppStore.getState().refreshGit()
        }, 300)
      })
    })()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unwatch?.()
    }
  }, [folder])

  if (!ready) {
    return (
      <div className="splash">
        <div className="logo-mark">
          <Zap size={28} />
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--text-dim)]">
          <Logo size={16} />
          Kineticut AI is starting…
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <ActivityBar />
        {sidebarVisible && <SideBar />}
        <div className="app-main">
          <EditorArea />
          <TerminalPanel />
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <QuickOpen />
      <Toasts />
      <DiffModal />
      <ConfirmModal />
      <PromptModal />
    </div>
  )
}
