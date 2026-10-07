import { useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
import {
  FolderOpen,
  MessageSquareText,
  Settings,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'
import { api } from '../api'
import { attachSelectionToChat } from '../lib/aiActions'
import { editorRef } from '../lib/editorRef'
import {
  deleteSnapshot,
  getSnapshot,
  useEditorStore,
} from '../store/editor'
import { useAppStore } from '../store/app'
import { useSettingsStore } from '../store/settings'
import { basename, relativePath } from '../lib/utils'
import {
  editorOptions,
  ensureModel,
  disposeModel,
  monacoThemeName,
} from '../lib/monaco'
import { Logo } from './Logo'

function closeTabWithDispose(path: string) {
  useEditorStore.getState().closeTab(path)
  disposeModel(path)
  deleteSnapshot(path)
}

/* -------------------------------- welcome ----------------------------------- */

const WELCOME_SHORTCUTS: [string, string][] = [
  ['Ctrl+P', 'Go to file'],
  ['Ctrl+Shift+P', 'Command palette'],
  ['Ctrl+`', 'Terminal'],
  ['Ctrl+I', 'Ask AI about selection'],
  ['Ctrl+S', 'Save'],
  ['Tab', 'Accept AI completion'],
]

function Welcome() {
  const recentFolders = useAppStore((s) => s.recentFolders)
  const recentFiles = useAppStore((s) => s.recentFiles)
  const folder = useAppStore((s) => s.folder)

  return (
    <div className="welcome">
      <div className="logo-mark">
        <Zap size={30} />
      </div>
      <div className="text-2xl font-bold tracking-tight">
        Kineticut&nbsp;<span className="text-gradient">AI</span>
      </div>
      <div className="text-sm text-[var(--text-dim)] max-w-[420px] text-center leading-6">
        The AI-native code editor. Local models via Ollama, frontier models via API,
        with chat, inline completions and an agent that edits with your approval.
      </div>
      <div className="flex gap-2 mt-1 flex-wrap justify-center">
        <button
          className="btn btn-primary"
          onClick={() => {
            void api.system.openFolder().then((p) => {
              if (p) useAppStore.getState().setFolder(p)
            })
          }}
        >
          <FolderOpen size={14} />
          Open Folder
        </button>
        <button className="btn" onClick={() => useAppStore.getState().setSidebarView('chat')}>
          <MessageSquareText size={14} />
          Chat with AI
        </button>
        <button className="btn" onClick={() => useAppStore.getState().setSidebarView('settings')}>
          <Settings size={14} />
          Settings
        </button>
      </div>
      <div className="flex gap-10 mt-3 text-left flex-wrap justify-center">
        {recentFolders.length > 0 && (
          <div>
            <div className="field-label">Recent folders</div>
            <div className="flex flex-col gap-0.5">
              {recentFolders.slice(0, 6).map((p) => (
                <button
                  key={p}
                  className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)] text-left truncate max-w-[260px]"
                  title={p}
                  onClick={() => useAppStore.getState().setFolder(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {recentFiles.length > 0 && (
          <div>
            <div className="field-label">Recent files</div>
            <div className="flex flex-col gap-0.5">
              {recentFiles.slice(0, 6).map((p) => (
                <button
                  key={p}
                  className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)] text-left truncate max-w-[260px]"
                  title={p}
                  onClick={() => useEditorStore.getState().openTab(p)}
                >
                  {folder ? relativePath(folder, p) : basename(p)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-10 gap-y-1.5 mt-2 text-[11px] text-[var(--text-faint)]">
        {WELCOME_SHORTCUTS.map(([combo, label]) => (
          <div key={combo} className="flex items-center gap-2">
            <span className="kbd">{combo}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------- editor area -------------------------------- */

export function EditorArea() {
  const tabs = useEditorStore((s) => s.tabs)
  const activePath = useEditorStore((s) => s.activePath)
  const dirty = useEditorStore((s) => s.dirty)
  const pendingReveal = useEditorStore((s) => s.pendingReveal)
  const askAiAnchor = useAppStore((s) => s.askAiAnchor)
  const [modelReady, setModelReady] = useState(false)

  const activeTab = tabs.find((t) => t.path === activePath) || null

  // Load the active file's model from disk before mounting the editor.
  useEffect(() => {
    if (!activePath) {
      setModelReady(false)
      return
    }
    let cancelled = false
    setModelReady(false)
    void ensureModel(activePath).then(() => {
      if (!cancelled) setModelReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [activePath])

  const handleMount = (editor: any) => {
    editorRef.current = editor

    editor.onDidChangeModelContent(() => {
      const model = editor.getModel()
      if (!model || model.uri.scheme !== 'file') return
      const path = model.uri.fsPath
      const snap = getSnapshot(path)
      useEditorStore
        .getState()
        .markDirty(path, snap === undefined ? false : model.getValue() !== snap)
    })

    editor.onDidChangeCursorSelection((e: any) => {
      const model = editor.getModel()
      const sel = e.selection
      if (!model || !sel) return
      const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
      const selectedText: string = model.getValueInRange(sel)
      useAppStore.getState().setSelectionInfo({
        line: sel.positionLineNumber,
        column: sel.positionColumn,
        selected: selectedText.length,
      })
      if (selectedText.trim().length > 0) {
        const pos = editor.getScrolledVisiblePosition({
          lineNumber: sel.startLineNumber,
          column: sel.startColumn,
        })
        if (pos) {
          useAppStore.getState().setEditorSelection({
            path,
            text: selectedText,
            label: `${basename(path)}:${sel.startLineNumber}-${sel.endLineNumber}`,
            startLineNumber: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLineNumber: sel.endLineNumber,
            endColumn: sel.endColumn,
          })
          useAppStore.getState().setAskAiAnchor({ x: pos.left, y: pos.top + pos.height + 6 })
        }
      } else {
        useAppStore.getState().setEditorSelection(null)
        useAppStore.getState().setAskAiAnchor(null)
      }
    })
  }

  // Apply pending reveal (from search / quick open) once the model is ready.
  useEffect(() => {
    if (!pendingReveal || !modelReady || pendingReveal.path !== activePath) return
    const editor = editorRef.current
    if (!editor) return
    editor.revealLineInCenter(pendingReveal.line)
    editor.setPosition({ lineNumber: pendingReveal.line, column: pendingReveal.column })
    editor.focus()
    useEditorStore.getState().setPendingReveal(null)
  }, [pendingReveal, modelReady, activePath])

  return (
    <div className="editor-area">
      <div className="tabbar">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab ${tab.path === activePath ? 'active' : ''}`}
            title={tab.path}
            onClick={() => useEditorStore.getState().setActive(tab.path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTabWithDispose(tab.path)
              }
            }}
          >
            <span className="tname">{tab.name}</span>
            {dirty[tab.path] && <span className="dirty-dot" title="Unsaved changes" />}
            <button
              className="close-btn"
              title="Close (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation()
                closeTabWithDispose(tab.path)
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="editor-fill">
        {activePath ? (
          modelReady ? (
            <Editor
              path={activePath}
              language={activeTab?.language}
              theme={monacoThemeName()}
              options={editorOptions()}
              onMount={handleMount}
              loading={
                <div className="editor-fill flex items-center justify-center text-xs text-[var(--text-faint)]">
                  Loading editor…
                </div>
              }
            />
          ) : (
            <div className="editor-fill flex items-center justify-center text-xs text-[var(--text-faint)]">
              Loading {basename(activePath)}…
            </div>
          )
        ) : (
          <Welcome />
        )}
        {askAiAnchor && (
          <button
            className="ask-ai-btn"
            style={{ left: askAiAnchor.x, top: askAiAnchor.y }}
            onClick={attachSelectionToChat}
            title="Attach this selection to the AI chat"
          >
            <Sparkles size={12} />
            Ask AI
          </button>
        )}
      </div>
    </div>
  )
}
