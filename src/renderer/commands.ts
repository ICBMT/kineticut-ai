/**
 * Central command registry. The command palette, title-bar menus and
 * global keybindings all dispatch through here.
 */
import {
  AlignLeft,
  ArrowDownToLine,
  ArrowLeftRight,
  Bot,
  BrainCircuit,
  FileCode,
  FilePlus,
  FolderOpen,
  GitBranch,
  Keyboard,
  MessageSquarePlus,
  Moon,
  PanelBottom,
  PanelLeft,
  RotateCcw,
  Save,
  SaveAll,
  Search,
  Settings,
  Sparkles,
  SquareSplitVertical,
  SquareTerminal,
  Wand2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { api } from './api'
import {
  attachSelectionToChat,
  explainSelection,
  fixProblemsFromMarkers,
  generateTests,
  refactorSelection,
  triggerInlineCompletion,
} from './lib/aiActions'
import { editorRef } from './lib/editorRef'
import { refreshProjectBrief } from './lib/projectBrief'
import { basename, joinPath, sleep } from './lib/utils'
import { useAppStore } from './store/app'
import { useAIStore } from './store/ai'
import { useEditorStore } from './store/editor'
import { useSettingsStore } from './store/settings'

export interface Command {
  id: string
  title: string
  category: string
  icon: LucideIcon
  shortcut?: string
  keywords?: string
  run(): void | Promise<void>
}

/* ------------------------------- file actions ------------------------------- */

/** Trigger formatting and wait until the model content settles. */
async function formatEditor(editor: any): Promise<void> {
  const model = editor.getModel()
  if (!model) return
  editor.trigger('keyboard', 'editor.action.formatDocument', {})
  let prev = model.getValue()
  for (let i = 0; i < 40; i++) {
    await sleep(50)
    const cur = model.getValue()
    if (cur === prev) return
    prev = cur
  }
}

export async function saveActiveTab(): Promise<void> {
  const editor = editorRef.current
  const store = useEditorStore.getState()
  const tab = store.activeTab()
  if (!editor || !tab) return
  const model = editor.getModel()
  if (!model) return
  try {
    if (useSettingsStore.getState().formatOnSave) {
      await formatEditor(editor)
    }
    const content = model.getValue()
    await api.fs.write(tab.path, content)
    store.markDirty(tab.path, false)
    useAppStore.getState().toast({
      kind: 'success',
      title: 'Saved',
      message: basename(tab.path),
      duration: 1800,
    })
  } catch (err) {
    useAppStore.getState().toast({
      kind: 'error',
      title: 'Save failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function saveAllTabs(): Promise<void> {
  const editor = editorRef.current
  const store = useEditorStore.getState()
  if (!editor) return
  const model = editor.getModel()
  const activeTab = store.activeTab()
  let saved = 0
  for (const tab of store.allTabs()) {
    if (!store.dirty[tab.path]) continue
    try {
      if (model && activeTab && tab.path === activeTab.path) {
        await api.fs.write(tab.path, model.getValue())
      } else {
        const res = await api.fs.read(tab.path)
        await api.fs.write(tab.path, res.content)
      }
      store.markDirty(tab.path, false)
      saved++
    } catch {
      /* skip */
    }
  }
  if (saved > 0) {
    useAppStore.getState().toast({ kind: 'success', title: 'Saved all', message: `${saved} files` })
  }
}

async function openFolder(): Promise<void> {
  const path = await api.system.openFolder()
  if (path) useAppStore.getState().setFolder(path)
}

async function newFile(): Promise<void> {
  const folder = useAppStore.getState().folder
  if (!folder) {
    useAppStore.getState().toast({
      kind: 'warning',
      title: 'Open a folder first',
      message: 'File → Open Folder… to choose a workspace.',
    })
    return
  }
  const name = await new Promise<string | null>((resolve) => {
    useAppStore.getState().requestPrompt({
      title: 'New file',
      label: 'File name (relative to the workspace root)',
      placeholder: 'src/index.ts',
      resolve,
    })
  })
  if (!name || !name.trim()) return
  const target = joinPath(folder, name.trim())
  try {
    await api.fs.write(target, '')
    useEditorStore.getState().openTab(target)
  } catch (err) {
    useAppStore.getState().toast({
      kind: 'error',
      title: 'Could not create file',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function formatDocument(): void {
  const editor = editorRef.current
  if (!editor) return
  try {
    editor.trigger('keyboard', 'editor.action.formatDocument', {})
  } catch {
    /* no formatter for this language */
  }
}

async function goToLine(): Promise<void> {
  const editor = editorRef.current
  if (!editor) return
  const value = await new Promise<string | null>((resolve) => {
    useAppStore.getState().requestPrompt({
      title: 'Go to Line',
      label: 'Line number',
      placeholder: 'e.g. 42',
      resolve,
    })
  })
  const line = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(line) || line < 1) return
  const model = editor.getModel()
  if (!model) return
  const target = Math.min(line, model.getLineCount())
  editor.revealLineInCenter(target)
  editor.setPosition({ lineNumber: target, column: 1 })
  editor.focus()
}

/* -------------------------------- the registry ------------------------------ */

export const COMMANDS: Command[] = [
  // File
  { id: 'file.openFolder', title: 'Open Folder…', category: 'File', icon: FolderOpen, keywords: 'workspace project directory', run: openFolder },
  { id: 'file.newFile', title: 'New File…', category: 'File', icon: FilePlus, keywords: 'create', run: newFile },
  { id: 'file.save', title: 'Save', category: 'File', icon: Save, shortcut: 'Ctrl+S', keywords: 'write disk', run: saveActiveTab },
  { id: 'file.saveAll', title: 'Save All', category: 'File', icon: SaveAll, shortcut: 'Ctrl+Shift+S', keywords: 'write disk all', run: saveAllTabs },
  { id: 'file.closeTab', title: 'Close Editor', category: 'File', icon: X, shortcut: 'Ctrl+W', keywords: 'tab', run: () => {
    const tab = useEditorStore.getState().activeTab()
    if (tab) useEditorStore.getState().closeTab(tab.path)
  } },

  // View
  { id: 'view.palette', title: 'Command Palette', category: 'View', icon: Keyboard, shortcut: 'Ctrl+Shift+P', keywords: 'commands', run: () => useAppStore.getState().setPaletteOpen(true) },
  { id: 'view.quickOpen', title: 'Go to File…', category: 'View', icon: Search, shortcut: 'Ctrl+P', keywords: 'open file find', run: () => useAppStore.getState().setQuickOpenOpen(true) },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', icon: PanelLeft, shortcut: 'Ctrl+B', keywords: 'explorer', run: () => useAppStore.getState().toggleSidebar() },
  { id: 'view.togglePanel', title: 'Toggle Panel', category: 'View', icon: PanelBottom, shortcut: 'Ctrl+`', keywords: 'terminal output', run: () => useAppStore.getState().togglePanel() },
  { id: 'view.showChat', title: 'Show AI Chat', category: 'View', icon: MessageSquarePlus, keywords: 'ai assistant sidebar', run: () => useAppStore.getState().setChatVisible(true) },
  { id: 'view.toggleChat', title: 'Toggle AI Chat Sidebar', category: 'View', icon: MessageSquarePlus, shortcut: 'Ctrl+Alt+B', keywords: 'ai assistant sidebar panel', run: () => useAppStore.getState().toggleChat() },
  { id: 'view.showExplorer', title: 'Show Explorer', category: 'View', icon: PanelLeft, keywords: 'files', run: () => useAppStore.getState().setSidebarView('explorer') },
  { id: 'view.showSearch', title: 'Show Search', category: 'View', icon: Search, keywords: 'grep find', run: () => useAppStore.getState().setSidebarView('search') },
  { id: 'view.showGit', title: 'Show Source Control', category: 'View', icon: GitBranch, keywords: 'git commit', run: () => useAppStore.getState().setSidebarView('git') },
  { id: 'view.toggleTheme', title: 'Toggle Color Theme', category: 'View', icon: Moon, keywords: 'dark light appearance', run: () => {
    const s = useSettingsStore.getState()
    s.set('theme', s.theme === 'dark' ? 'light' : 'dark')
  } },
  { id: 'view.zoomIn', title: 'Zoom In', category: 'View', icon: Zap, keywords: 'font size editor', run: () => {
    const s = useSettingsStore.getState()
    s.set('editorFontSize', Math.min(28, s.editorFontSize + 1))
  } },
  { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', icon: Zap, keywords: 'font size editor', run: () => {
    const s = useSettingsStore.getState()
    s.set('editorFontSize', Math.max(9, s.editorFontSize - 1))
  } },

  // Editor
  { id: 'editor.format', title: 'Format Document', category: 'Editor', icon: AlignLeft, shortcut: 'Ctrl+Shift+I', keywords: 'prettier format code', run: formatDocument },
  { id: 'editor.goToLine', title: 'Go to Line…', category: 'Editor', icon: ArrowDownToLine, shortcut: 'Ctrl+G', keywords: 'jump navigate line number', run: goToLine },
  { id: 'editor.split', title: 'Split Editor', category: 'Editor', icon: SquareSplitVertical, keywords: 'side by side multitask groups', run: () => {
    const store = useEditorStore.getState()
    if (store.groups.length >= 4) {
      useAppStore.getState().toast({ kind: 'info', title: 'Maximum of 4 editor groups' })
      return
    }
    store.splitGroup()
  } },
  { id: 'view.toggleSplitDirection', title: 'Toggle Split Direction', category: 'View', icon: ArrowLeftRight, keywords: 'layout side by side stacked', run: () => {
    const s = useSettingsStore.getState()
    s.set('splitDirection', s.splitDirection === 'horizontal' ? 'vertical' : 'horizontal')
  } },

  // AI
  { id: 'ai.newChat', title: 'New Chat', category: 'AI', icon: MessageSquarePlus, keywords: 'assistant conversation', run: () => {
    useAIStore.getState().newSession('chat')
    useAppStore.getState().setChatVisible(true)
  } },
  { id: 'ai.analyzeProject', title: 'Analyze Project with AI', category: 'AI', icon: BrainCircuit, keywords: 'project brief scan understand workspace overview', run: () => {
    useAppStore.getState().setChatVisible(true)
    void refreshProjectBrief()
  } },
  { id: 'ai.toggleAgent', title: 'Toggle Agent Mode', category: 'AI', icon: Bot, shortcut: 'Ctrl+Shift+A', keywords: 'tools autonomous', run: () => {
    const ai = useAIStore.getState()
    const session = ai.activeSession()
    if (!session) {
      ai.newSession('agent')
    } else {
      ai.setMode(session.id, session.mode === 'agent' ? 'chat' : 'agent')
    }
    useAppStore.getState().setSidebarView('chat')
  } },
  { id: 'ai.explain', title: 'Explain Code', category: 'AI', icon: Sparkles, shortcut: 'Ctrl+I', keywords: 'understand selection', run: explainSelection },
  { id: 'ai.refactor', title: 'Refactor Selection', category: 'AI', icon: Wand2, keywords: 'improve clean code', run: refactorSelection },
  { id: 'ai.tests', title: 'Generate Tests', category: 'AI', icon: FileCode, keywords: 'unit test coverage', run: generateTests },
  { id: 'ai.fixProblems', title: 'Fix Problems with AI', category: 'AI', icon: Wrench, keywords: 'errors warnings quickfix', run: fixProblemsFromMarkers },
  { id: 'ai.attachSelection', title: 'Attach Selection to Chat', category: 'AI', icon: MessageSquarePlus, keywords: 'context code', run: attachSelectionToChat },
  { id: 'ai.inlineCompletion', title: 'Trigger Inline Completion', category: 'AI', icon: Zap, keywords: 'ghost text suggest', run: triggerInlineCompletion },

  // Settings / app
  { id: 'settings.open', title: 'Settings', category: 'Preferences', icon: Settings, shortcut: 'Ctrl+,', keywords: 'preferences providers models', run: () => useAppStore.getState().setSidebarView('settings') },
  { id: 'git.refresh', title: 'Refresh Git Status', category: 'Git', icon: RotateCcw, keywords: 'source control', run: () => useAppStore.getState().refreshGit() },
]

export function runCommand(id: string): void {
  const command = COMMANDS.find((c) => c.id === id)
  if (command) void command.run()
}

/* -------------------------------- keybindings ------------------------------- */

export const KEYBINDINGS: { combo: string; commandId: string }[] = [
  { combo: 'mod+shift+p', commandId: 'view.palette' },
  { combo: 'f1', commandId: 'view.palette' },
  { combo: 'mod+p', commandId: 'view.quickOpen' },
  { combo: 'mod+`', commandId: 'view.togglePanel' },
  { combo: 'mod+b', commandId: 'view.toggleSidebar' },
  { combo: 'mod+s', commandId: 'file.save' },
  { combo: 'mod+shift+s', commandId: 'file.saveAll' },
  { combo: 'mod+w', commandId: 'file.closeTab' },
  { combo: 'mod+,', commandId: 'settings.open' },
  { combo: 'mod+i', commandId: 'ai.explain' },
  { combo: 'mod+shift+a', commandId: 'ai.toggleAgent' },
  { combo: 'mod+shift+i', commandId: 'editor.format' },
  { combo: 'mod+g', commandId: 'editor.goToLine' },
]

function eventCombo(e: KeyboardEvent): string | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(key === ' ' ? 'space' : key)
  return parts.join('+')
}

export function installKeybindings(): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
    // Let typing in fields keep its own keys, except for modified shortcuts and Escape.
    if (inField && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== 'Escape') return
    const combo = eventCombo(e)
    if (!combo) return
    const binding = KEYBINDINGS.find((k) => k.combo === combo)
    if (binding) {
      e.preventDefault()
      runCommand(binding.commandId)
    }
  })
}
