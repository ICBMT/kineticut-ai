import { useEffect, useState } from 'react'
import {
  Bot,
  BrainCircuit,
  Copy,
  History,
  FileCode,
  FilePlus,
  FolderOpen,
  Github,
  Keyboard,
  MessageSquarePlus,
  Minus,
  Moon,
  PanelBottom,
  PanelLeft,
  Save,
  SaveAll,
  Search,
  Settings,
  Sparkles,
  Square,
  SquareTerminal,
  Wand2,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { api, isElectron } from '../api'
import { runCommand, KEYBINDINGS } from '../commands'
import { basename } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { useSettingsStore } from '../store/settings'
import { Logo } from './Logo'
import { ModelSelect } from './ModelSelect'
import { Dropdown, IconButton, Kbd, Modal, type MenuItem } from './ui'

function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const off = api.win.onMaximizeChange(setMaximized)
    api.win.isMaximized().then(setMaximized)
    return off
  }, [])
  return (
    <div className="win-controls no-drag">
      <button className="win-btn" onClick={() => api.win.minimize()} title="Minimize" aria-label="Minimize window">
        <Minus size={14} />
      </button>
      <button
        className="win-btn"
        onClick={() => api.win.maximize()}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
      >
        {maximized ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button className="win-btn close" onClick={() => api.win.close()} title="Close" aria-label="Close window">
        <X size={14} />
      </button>
    </div>
  )
}

function ShortcutTable() {
  const rows = KEYBINDINGS.map((k) => ({
    combo: k.combo,
    command: k.commandId,
  }))
  const label = (id: string) => {
    const map: Record<string, string> = {
      'view.palette': 'Command Palette',
      'view.quickOpen': 'Go to File',
      'view.togglePanel': 'Toggle Panel / Terminal',
      'view.toggleSidebar': 'Toggle Sidebar',
      'file.save': 'Save',
      'file.saveAll': 'Save All',
      'file.closeTab': 'Close Editor',
      'settings.open': 'Settings',
      'ai.explain': 'Explain Code (Ask AI)',
      'ai.toggleAgent': 'Toggle Agent Mode',
    }
    return map[id] || id
  }
  const pretty = (combo: string) =>
    combo
      .split('+')
      .map((p) => (p === 'mod' ? 'Ctrl' : p[0].toUpperCase() + p.slice(1)))
      .join(' + ')
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-xs">
      {rows.map((r) => (
        <div key={r.combo} className="contents">
          <span className="text-[var(--text-dim)]">{label(r.command)}</span>
          <span className="font-mono text-[var(--text-faint)]">{pretty(r.combo)}</span>
        </div>
      ))}
    </div>
  )
}

export function TitleBar() {
  const system = useAppStore((s) => s.system)
  const folder = useAppStore((s) => s.folder)
  const activeTab = useEditorStore((s) => s.activeTab())
  const theme = useSettingsStore((s) => s.theme)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const isMac = system?.platform === 'darwin'

  const fileMenu: MenuItem[] = [
    { icon: FolderOpen, label: 'Open Folder…', onClick: () => runCommand('file.openFolder') },
    { icon: FilePlus, label: 'New File…', onClick: () => runCommand('file.newFile') },
    { type: 'separator' },
    { icon: Save, label: 'Save', shortcut: 'Ctrl+S', onClick: () => runCommand('file.save') },
    { icon: SaveAll, label: 'Save All', shortcut: 'Ctrl+Shift+S', onClick: () => runCommand('file.saveAll') },
    { type: 'separator' },
    { icon: Settings, label: 'Settings', shortcut: 'Ctrl+,', onClick: () => runCommand('settings.open') },
    ...(isElectron
      ? [
          { type: 'separator' as const },
          { icon: X, label: 'Exit', onClick: () => api.win.close() },
        ]
      : []),
  ]

  const editMenu: MenuItem[] = [
    { label: 'Undo', shortcut: 'Ctrl+Z', onClick: () => api.win.editRole('undo') },
    { label: 'Redo', shortcut: 'Ctrl+Y', onClick: () => api.win.editRole('redo') },
    { type: 'separator' },
    { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => api.win.editRole('cut') },
    { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => api.win.editRole('copy') },
    { label: 'Paste', shortcut: 'Ctrl+V', onClick: () => api.win.editRole('paste') },
    { type: 'separator' },
    { label: 'Select All', shortcut: 'Ctrl+A', onClick: () => api.win.editRole('selectAll') },
  ]

  const viewMenu: MenuItem[] = [
    { icon: Keyboard, label: 'Command Palette', shortcut: 'Ctrl+Shift+P', onClick: () => runCommand('view.palette') },
    { icon: Search, label: 'Go to File…', shortcut: 'Ctrl+P', onClick: () => runCommand('view.quickOpen') },
    { type: 'separator' },
    { icon: PanelLeft, label: 'Toggle Sidebar', shortcut: 'Ctrl+B', onClick: () => runCommand('view.toggleSidebar') },
    { icon: PanelBottom, label: 'Toggle Panel', shortcut: 'Ctrl+`', onClick: () => runCommand('view.togglePanel') },
    { type: 'separator' },
    { icon: MessageSquarePlus, label: 'Show AI Chat', onClick: () => runCommand('view.showChat') },
    { icon: MessageSquarePlus, label: 'Toggle AI Chat Sidebar', shortcut: 'Ctrl+Alt+B', onClick: () => runCommand('view.toggleChat') },
    { icon: FolderOpen, label: 'Show Explorer', onClick: () => runCommand('view.showExplorer') },
    { icon: Search, label: 'Show Search', onClick: () => runCommand('view.showSearch') },
    { type: 'separator' },
    { icon: Moon, label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`, onClick: () => runCommand('view.toggleTheme') },
    { icon: Zap, label: 'Zoom In', onClick: () => runCommand('view.zoomIn') },
    { icon: Zap, label: 'Zoom Out', onClick: () => runCommand('view.zoomOut') },
  ]

  const aiMenu: MenuItem[] = [
    { icon: MessageSquarePlus, label: 'New Chat', onClick: () => runCommand('ai.newChat') },
    { icon: BrainCircuit, label: 'Analyze Project with AI', onClick: () => runCommand('ai.analyzeProject') },
    { icon: BrainCircuit, label: 'Build Project Understanding', onClick: () => runCommand('ai.understand') },
    { icon: History, label: 'Projects & Chat History', shortcut: 'Ctrl+Alt+H', onClick: () => runCommand('view.history') },
    { icon: Bot, label: 'Toggle Agent Mode', shortcut: 'Ctrl+Shift+A', onClick: () => runCommand('ai.toggleAgent') },
    { type: 'separator' },
    { icon: Sparkles, label: 'Explain Code', shortcut: 'Ctrl+I', onClick: () => runCommand('ai.explain') },
    { icon: Wand2, label: 'Refactor Selection', onClick: () => runCommand('ai.refactor') },
    { icon: FileCode, label: 'Generate Tests', onClick: () => runCommand('ai.tests') },
    { icon: Wrench, label: 'Fix Problems with AI', onClick: () => runCommand('ai.fixProblems') },
    { type: 'separator' },
    { icon: MessageSquarePlus, label: 'Attach Selection to Chat', onClick: () => runCommand('ai.attachSelection') },
    { icon: Zap, label: 'Trigger Inline Completion', onClick: () => runCommand('ai.inlineCompletion') },
  ]

  const helpMenu: MenuItem[] = [
    { icon: Keyboard, label: 'Keyboard Shortcuts', onClick: () => setShortcutsOpen(true) },
    { label: 'About Kineticut AI', onClick: () => setAboutOpen(true) },
    { type: 'separator' },
    {
      icon: Github,
      label: 'VS Code Fork (microsoft/vscode)',
      onClick: () => api.system.openExternal('https://github.com/microsoft/vscode'),
    },
    {
      icon: Github,
      label: 'Kineticut AI Repository',
      onClick: () => api.system.openExternal('https://github.com/ICBMT/kineticut-ai'),
    },
  ]

  return (
    <div className="titlebar">
      <div className="tb-left">
        <Logo size={20} />
        <span className="tb-app">
          Kineticut&nbsp;<span className="text-gradient">AI</span>
        </span>
        <nav className="tb-menus" aria-label="Application menu">
          <DropdownMenuButton label="File" items={fileMenu} />
          <DropdownMenuButton label="Edit" items={editMenu} />
          <DropdownMenuButton label="View" items={viewMenu} />
          <DropdownMenuButton label="AI" items={aiMenu} />
          <DropdownMenuButton label="Help" items={helpMenu} />
        </nav>
      </div>

      <div className="tb-center">
        <span>{folder ? basename(folder) : 'no folder open'}</span>
        {activeTab && (
          <>
            <span className="tb-file">—</span>
            <span className="tb-file truncate">{activeTab.name}</span>
          </>
        )}
      </div>

      <div className="tb-right no-drag">
        <ModelSelect compact />
        <IconButton
          icon={Search}
          tooltip="Quick Open (Ctrl+P)"
          onClick={() => useAppStore.getState().setQuickOpenOpen(true)}
        />
        <IconButton
          icon={Settings}
          tooltip="Settings (Ctrl+,)"
          onClick={() => runCommand('settings.open')}
        />
        {isElectron && !isMac && <WindowControls />}
      </div>

      <Modal open={aboutOpen} onClose={() => setAboutOpen(false)} title="About Kineticut AI">
        <div className="flex items-center gap-4 mb-4">
          <Logo size={44} />
          <div>
            <div className="text-lg font-bold">Kineticut AI</div>
            <div className="text-xs text-[var(--text-faint)]">
              Version {system?.version || '0.1.0'} · {system?.platform || 'web'} / {system?.arch || ''}
            </div>
          </div>
        </div>
        <p className="text-sm text-[var(--text-dim)] leading-6">
          An AI-native code editor. Local models via Ollama, frontier models via API,
          built on the Monaco editor engine (the editor that powers VS Code), with a
          full VS Code fork under <code className="text-xs">/vscode</code>.
        </p>
      </Modal>

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard Shortcuts"
      >
        <ShortcutTable />
        <div className="mt-4 text-[11px] text-[var(--text-faint)]">
          Tip: press <Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>P</Kbd> to run any command by name.
        </div>
      </Modal>
    </div>
  )
}

function DropdownMenuButton({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <Dropdown
      trigger={
        <button className="tb-menu-btn" type="button" aria-haspopup="menu">
          {label}
        </button>
      }
      items={items}
    />
  )
}
