import { useEffect } from 'react'
import { Zap } from 'lucide-react'
import { api } from './api'
import { installKeybindings } from './commands'
import { Logo } from './components/Logo'
import { maybeStartKnowledgeKeeper } from './lib/projectKnowledge'
import { syncOpenModelsWithDisk } from './lib/monaco'
import { cn } from './lib/utils'
import { applyAppearance, useSettingsStore } from './store/settings'
import { useAppStore } from './store/app'
import { ActivityBar } from './components/ActivityBar'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ConfirmModal, DiffModal, PromptModal } from './components/modals'
import { ShortcutsModal } from './components/ShortcutsModal'
import { HistoryModal } from './components/HistoryModal'
import { ReviewPanel } from './components/ReviewPanel'
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
  applyAppearance(useSettingsStore.getState())
  try {
    const info = await api.system.info()
    useAppStore.getState().setSystem(info)
  } catch {
    /* ignore */
  }
  // Every launch starts empty: no folder and no file are opened automatically.
  // Recent projects and past chats are available from the welcome screen and
  // the History panel.
  useAppStore.getState().setReady(true)
}

export function App() {
  const ready = useAppStore((s) => s.ready)
  const folder = useAppStore((s) => s.folder)
  const theme = useSettingsStore((s) => s.theme)
  const panelPosition = useSettingsStore((s) => s.panelPosition)

  useEffect(() => {
    installKeybindings()
  }, [])

  useEffect(() => {
    void boot()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Watch the workspace: refresh the file index, git status, open editors,
  // and resume the knowledge keeper if this project was already prescanned.
  useEffect(() => {
    if (!folder) return
    void maybeStartKnowledgeKeeper()
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
    <ErrorBoundary>
      <div className="app">
        <TitleBar />
        <div className="app-body">
          <ActivityBar />
          <SideBar slot="left" />
          <div className={cn('app-main', panelPosition === 'right' && 'app-main-row')}>
            <EditorArea />
            <TerminalPanel />
          </div>
          <SideBar slot="right" />
        </div>
        <StatusBar />
        <CommandPalette />
        <QuickOpen />
        <Toasts />
        <DiffModal />
        <ConfirmModal />
        <PromptModal />
        <ShortcutsModal />
        <HistoryModal />
        <ReviewPanel />
      </div>
    </ErrorBoundary>
  )
}
