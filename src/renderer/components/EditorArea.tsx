import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import {
  BrainCircuit,
  FileImage,
  FolderOpen,
  MessageSquareText,
  Settings,
  Sparkles,
  SquareSplitVertical,
  X,
  Zap,
} from 'lucide-react'
import { api } from '../api'
import { attachSelectionToChat } from '../lib/aiActions'
import { editorRef } from '../lib/editorRef'
import { refreshProjectBrief } from '../lib/projectBrief'
import {
  deleteSnapshot,
  getSnapshot,
  useEditorStore,
  type EditorGroup,
  type EditorTab,
} from '../store/editor'
import { useAppStore } from '../store/app'
import { useSettingsStore } from '../store/settings'
import { basename, relativePath } from '../lib/utils'
import {
  disposeModel,
  editorOptions,
  ensureModel,
  monacoThemeName,
} from '../lib/monaco'

function closeTabWithDispose(path: string) {
  useEditorStore.getState().closeTab(path)
  if (!useEditorStore.getState().allTabs().some((t) => t.path === path)) {
    disposeModel(path)
    deleteSnapshot(path)
  }
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
        <button className="btn" onClick={() => useAppStore.getState().setChatVisible(true)}>
          <MessageSquareText size={14} />
          Chat with AI
        </button>
        <button
          className="btn"
          onClick={() => {
            useAppStore.getState().setChatVisible(true)
            void refreshProjectBrief()
          }}
        >
          <BrainCircuit size={14} />
          Analyze Project
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

/* ----------------------------- binary placeholder ---------------------------- */

function BinaryPlaceholder({ path }: { path: string }) {
  return (
    <div className="editor-fill flex flex-col items-center justify-center gap-3 text-[var(--text-faint)]">
      <FileImage size={36} />
      <div className="text-sm text-[var(--text-dim)]">Binary file — no text preview</div>
      <div className="font-mono text-xs">{basename(path)}</div>
    </div>
  )
}

/* ------------------------------ editor group --------------------------------- */

function EditorGroupView({
  group,
  isActive,
  mountedGroups,
  onMountEditor,
  editorsRef,
  everMounted,
}: {
  group: EditorGroup
  isActive: boolean
  mountedGroups: Set<string>
  onMountEditor: (groupId: string) => (editor: any) => void
  editorsRef: React.MutableRefObject<Map<string, any>>
  everMounted: boolean
}) {
  const dirty = useEditorStore((s) => s.dirty)
  const pendingReveal = useEditorStore((s) => s.pendingReveal)
  const groupsCount = useEditorStore((s) => s.groups.length)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [truncated, setTruncated] = useState(false)
  const toastedTruncated = useRef<Set<string>>(new Set())

  const activeTab: EditorTab | null =
    group.tabs.find((t) => t.path === group.activePath) || null

  // Load the active file's model from disk.
  useEffect(() => {
    if (!group.activePath) {
      setStatus('ready')
      return
    }
    let cancelled = false
    setStatus('loading')
    ensureModel(group.activePath).then((res) => {
      if (cancelled) return
      if (res.binary || !res.model) {
        setStatus('failed')
        return
      }
      setTruncated(res.truncated)
      setStatus('ready')
      if (res.truncated && !toastedTruncated.current.has(group.activePath!)) {
        toastedTruncated.current.add(group.activePath!)
        useAppStore.getState().toast({
          kind: 'warning',
          title: 'Large file',
          message: `${basename(group.activePath!)} is bigger than the 8 MB read limit — showing the first part only.`,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [group.activePath])

  // Apply pending reveal (from search / quick open).
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== group.activePath || status !== 'ready') return
    const editor = editorsRef.current.get(group.id)
    if (!editor) return
    editor.revealLineInCenter(pendingReveal.line)
    editor.setPosition({ lineNumber: pendingReveal.line, column: pendingReveal.column })
    editor.focus()
    useEditorStore.getState().setPendingReveal(null)
  }, [pendingReveal, status, group.activePath, group.id, editorsRef])

  const showEditor = !!group.activePath && (status === 'ready' || mountedGroups.has(group.id) || everMounted)

  return (
    <div
      className={`editor-group ${isActive ? 'editor-group-active' : ''}`}
      onMouseDown={() => useEditorStore.getState().setActiveGroup(group.id)}
    >
      <div
        className="tabbar"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('kineticut/tab')) e.preventDefault()
        }}
        onDrop={(e) => {
          const path = e.dataTransfer.getData('kineticut/tab')
          if (path) useEditorStore.getState().moveTab(path, group.id)
        }}
      >
        {group.tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab ${tab.path === group.activePath ? 'active' : ''}`}
            title={tab.path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('kineticut/tab', tab.path)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => useEditorStore.getState().setActive(tab.path)}
            onDoubleClick={() => {
              // Double-click a tab to split it into its own group.
              const store = useEditorStore.getState()
              const newId = store.splitGroup()
              if (newId) store.moveTab(tab.path, newId)
            }}
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
        <div className="tabbar-actions">
          <button
            className="icon-btn !w-6 !h-6"
            title="Split editor (new group)"
            onClick={() => {
              const store = useEditorStore.getState()
              if (store.groups.length >= 4) {
                useAppStore.getState().toast({
                  kind: 'info',
                  title: 'Maximum of 4 editor groups',
                })
                return
              }
              store.splitGroup()
            }}
          >
            <SquareSplitVertical size={13} />
          </button>
          {groupsCount > 1 && (
            <button
              className="icon-btn !w-6 !h-6"
              title="Close this editor group"
              onClick={() => {
                const store = useEditorStore.getState()
                const removed = store.groups.find((g) => g.id === group.id)?.tabs || []
                store.closeGroup(group.id)
                for (const tab of removed) {
                  if (!useEditorStore.getState().allTabs().some((t) => t.path === tab.path)) {
                    disposeModel(tab.path)
                    deleteSnapshot(tab.path)
                  }
                }
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="editor-fill">
        {!group.activePath ? (
          <Welcome />
        ) : status === 'failed' ? (
          <BinaryPlaceholder path={group.activePath} />
        ) : showEditor ? (
          <Editor
            path={group.activePath}
            language={activeTab?.language}
            theme={monacoThemeName()}
            options={editorOptions()}
            keepCurrentModel
            onMount={onMountEditor(group.id)}
            loading={
              <div className="editor-fill flex items-center justify-center text-xs text-[var(--text-faint)]">
                Loading editor…
              </div>
            }
          />
        ) : (
          <div className="editor-fill flex items-center justify-center text-xs text-[var(--text-faint)]">
            Loading {basename(group.activePath)}…
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------- editor area -------------------------------- */

export function EditorArea() {
  const groups = useEditorStore((s) => s.groups)
  const activeGroupId = useEditorStore((s) => s.activeGroupId)
  const splitDirection = useSettingsStore((s) => s.splitDirection)
  const askAiAnchor = useAppStore((s) => s.askAiAnchor)

  const editorsRef = useRef(new Map<string, any>())
  const [mountedGroups, setMountedGroups] = useState<Set<string>>(new Set())
  const [everMounted, setEverMounted] = useState(false)

  // Problem markers → status bar counts (registered once, globally).
  useEffect(() => {
    const update = () => {
      const markers = monaco.editor.getModelMarkers({})
      useAppStore.getState().setProblems({
        errors: markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length,
        warnings: markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length,
      })
    }
    const sub = monaco.editor.onDidChangeMarkers(update)
    update()
    return () => sub.dispose()
  }, [])

  const handleMount = (groupId: string) => (editor: any) => {
    editorsRef.current.set(groupId, editor)
    editorRef.current = editor
    setMountedGroups((prev) => new Set(prev).add(groupId))
    setEverMounted(true)

    editor.onDidFocusEditorText(() => {
      useEditorStore.getState().setActiveGroup(groupId)
      editorRef.current = editor
    })

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
      if (useEditorStore.getState().activeGroupId !== groupId) return
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

  return (
    <div className="editor-area">
      <div
        className="editor-groups"
        data-direction={splitDirection}
        style={{ flexDirection: splitDirection === 'vertical' ? 'column' : 'row' }}
      >
        {groups.map((group) => (
          <EditorGroupView
            key={group.id}
            group={group}
            isActive={group.id === activeGroupId}
            mountedGroups={mountedGroups}
            onMountEditor={handleMount}
            editorsRef={editorsRef}
            everMounted={everMounted}
          />
        ))}
      </div>
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
  )
}
