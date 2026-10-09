import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Bug,
  Check,
  ChevronDown,
  Copy,
  Database,
  FileCode,
  FileDiff,
  History,
  Lightbulb,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  PencilLine,
  RefreshCw,
  RotateCw,
  Send,
  Settings,
  Sparkles,
  Square,
  TestTube2,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { renderMarkdown } from '../lib/markdown'
import { buildUnderstanding, useKnowledgeStore } from '../lib/projectKnowledge'
import { refreshProjectBrief } from '../lib/projectBrief'
import { openFileLink, resolveFileLink } from '../lib/fileLinks'
import { cn, basename } from '../lib/utils'
import { editorRef } from '../lib/editorRef'
import { attachSelectionToChat, currentCodeAttachment } from '../lib/aiActions'
import { expandSlash, filterSlash, slashQuery, type SlashCommand } from '../lib/slashCommands'
import { activeMention, insertMention, loadMentionFiles, rankFiles, type MentionMatch } from '../lib/mentions'
import { useAppStore } from '../store/app'
import { useAIStore, type ChatMessage, type ToolEventEntry } from '../store/ai'
import { describeChanges, type FileChange } from '../lib/checkpoints'
import { relativePath } from '../lib/utils'
import { ActivityPanel } from './ChatActivity'
import { ModelSelect } from './ModelSelect'
import { EmptyState, IconButton, Segmented, Spinner } from './ui'

/* ------------------------------ markdown body ------------------------------- */

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)
  // The file tree arrives after the first answer sometimes; re-link when it does.
  const fileIndex = useAppStore((s) => s.fileIndex)

  // Inline code that names a project file opens it: the answer can be checked
  // against the code it came from.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('code').forEach((code) => {
      if (code.closest('pre') || code.dataset.fileLink === '1') return
      const abs = resolveFileLink(code.textContent || '')
      if (!abs) return
      code.dataset.fileLink = '1'
      code.classList.add('file-link')
      code.setAttribute('role', 'button')
      code.setAttribute('tabindex', '0')
      code.title = `Open ${abs}`
      const open = () => openFileLink(abs)
      code.addEventListener('click', open)
      code.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') open()
      })
    })
  }, [html, fileIndex])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre.code-block').forEach((pre) => {
      if (pre.querySelector('.cb-actions')) return
      const code = pre.querySelector('code')
      if (!code) return
      const bar = document.createElement('div')
      bar.className = 'cb-actions'
      bar.style.cssText =
        'position:absolute;top:6px;right:6px;display:flex;gap:4px;opacity:0;transition:opacity .12s'
      pre.addEventListener('mouseenter', () => (bar.style.opacity = '1'))
      pre.addEventListener('mouseleave', () => (bar.style.opacity = '0'))
      const mkBtn = (label: string, onClick: () => void) => {
        const b = document.createElement('button')
        b.textContent = label
        b.style.cssText =
          'font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg-elev);color:var(--text-dim);cursor:pointer;font-family:inherit'
        b.onmouseenter = () => ((b.style as any).color = 'var(--text)')
        b.onmouseleave = () => ((b.style as any).color = 'var(--text-dim)')
        b.onclick = (e) => {
          e.stopPropagation()
          onClick()
        }
        return b
      }
      bar.appendChild(
        mkBtn('Copy', () => {
          void navigator.clipboard.writeText(code.textContent || '')
          useAppStore.getState().toast({ kind: 'success', title: 'Copied to clipboard', duration: 1500 })
        }),
      )
      bar.appendChild(
        mkBtn('Insert at cursor', () => {
          const editor = editorRef.current
          if (!editor) return
          const sel = editor.getSelection()
          if (sel) editor.executeEdits('kineticut-ai', [{ range: sel, text: code.textContent || '' }])
          editor.focus()
        }),
      )
      pre.appendChild(bar)
    })
  }, [html])

  return (
    <div
      ref={ref}
      className="prose-chat"
      dangerouslySetInnerHTML={{ __html: html + (streaming ? '<span class="stream-cursor"></span>' : '') }}
    />
  )
}

/* ------------------------------ agent tool chips ---------------------------- */

function ToolEventItem({ entry }: { entry: ToolEventEntry }) {
  const [open, setOpen] = useState(false)
  let argsSummary = ''
  try {
    const args = JSON.parse(entry.call.arguments || '{}')
    argsSummary = String(args.path || args.command || args.query || '')
  } catch {
    /* ignore */
  }
  return (
    <div className="my-1">
      <button className="tool-chip" onClick={() => setOpen((v) => !v)}>
        {entry.status === 'running' ? (
          <Spinner size={11} />
        ) : entry.status === 'error' ? (
          <AlertTriangle size={11} color="var(--red)" />
        ) : (
          <Check size={11} color="var(--green)" />
        )}
        <span className="font-semibold text-[var(--text)]">{entry.call.name}</span>
        {argsSummary && (
          <span className="text-[var(--text-faint)] truncate max-w-[180px]">{argsSummary}</span>
        )}
        {entry.result && (
          <ChevronDown size={11} className={cn('chevron-rot', open && 'open')} />
        )}
      </button>
      {open && entry.result && (
        <pre className="mt-1 max-h-44 overflow-auto rounded-lg border border-[var(--border-soft)] bg-[#0a0a12] p-2 text-[11px] leading-5 font-mono text-[var(--text-dim)]">
          {entry.result}
        </pre>
      )}
    </div>
  )
}

/* ------------------------------ agent changes ------------------------------- */

const CHANGE_STATE: Record<FileChange['status'], { text: string; tone: string }> = {
  applied: { text: '', tone: '' },
  reverted: { text: 'undone', tone: 'text-[var(--text-faint)] line-through' },
  kept: { text: 'you edited it since, kept', tone: 'text-[var(--yellow,#d29922)]' },
  unavailable: { text: 'too large to undo', tone: 'text-[var(--text-faint)]' },
}

/**
 * What an agent turn changed, with one-click undo. Files are opened from the
 * list, and undo never overwrites a file the user has edited since.
 */
function ChangeCard({ sessionId, message }: { sessionId: string; message: ChatMessage }) {
  const folder = useAppStore((s) => s.folder)
  const changes = message.changes ?? []
  const anyApplied = changes.some((c) => c.status === 'applied')
  const [busy, setBusy] = useState(false)
  const rel = (p: string) => (folder ? relativePath(folder, p) : p)
  return (
    <div className="change-card">
      <div className="change-card-head">
        <FileDiff size={12} />
        <span className="change-card-title">
          {anyApplied ? describeChanges(changes) : 'Changes undone'}
        </span>
        {anyApplied && (
          <button
            className="btn !py-0.5 !px-2 text-[10px]"
            disabled={busy || message.pending}
            title="Restore every file this reply changed to how it was before"
            onClick={async () => {
              setBusy(true)
              try {
                await useAIStore.getState().revertChanges(sessionId, message.id)
              } finally {
                setBusy(false)
              }
            }}
          >
            <RotateCw size={10} /> Undo changes
          </button>
        )}
      </div>
      <ul className="change-card-list">
        {changes.map((c) => {
          const state = CHANGE_STATE[c.status]
          const openable = c.status !== 'reverted' || c.before !== null
          return (
            <li key={c.path}>
              <button
                className="change-card-file"
                disabled={!openable}
                title={c.path}
                onClick={() => openFileLink(c.path)}
              >
                <span className="font-mono">{rel(c.path)}</span>
                <span className="change-card-kind">{c.before === null && !c.tooLarge ? 'new' : 'edited'}</span>
              </button>
              {state.text && <span className={cn('change-card-state', state.tone)}>{state.text}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ------------------------------ message actions ----------------------------- */

function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
  useAppStore.getState().toast({ kind: 'success', title: 'Copied', duration: 1200 })
}

interface MessageActions {
  /** The chat this message belongs to. */
  sessionId: string
  /** Last assistant reply, and no reply is streaming. */
  canRegenerate: boolean
  /** Last user message, and no reply is streaming. */
  canEdit: boolean
  onRegenerate(): void
  onEdit(id: string, text: string): void
  openSettings(): void
}

/** Hover-revealed row of message actions (keyboard reachable via focus-within). */
function MessageToolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {children}
    </div>
  )
}

/* --------------------------------- message ---------------------------------- */

function MessageView({ message, actions }: { message: ChatMessage; actions: MessageActions }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (message.role === 'user') {
    // The attached selection travels inside the message; show it as a chip, not raw text.
    const split = message.content.indexOf('\n\n<attached-selection')
    const visible = split >= 0 ? message.content.slice(0, split) : message.content
    const attachLabel = /label="([^"]*)"/.exec(message.content)?.[1]
    const save = () => {
      const t = draft.trim()
      if (!t) return
      setEditing(false)
      actions.onEdit(message.id, t)
    }
    return (
      <div className="msg user group">
        <div className="msg-avatar">You</div>
        <div className="msg-body">
          {editing ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                autoFocus
                className="field-input !text-xs resize-none"
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(false)
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
                }}
              />
              <div className="flex justify-end gap-1.5">
                <button className="btn !py-0.5 !px-2 text-[10px]" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary !py-0.5 !px-2 text-[10px]" onClick={save}>
                  Save &amp; resend
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="whitespace-pre-wrap break-words">{visible}</div>
              {attachLabel && (
                <div className="mt-1 inline-flex items-center gap-1 rounded border border-[var(--border-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-faint)]">
                  <Paperclip size={10} />
                  {attachLabel}
                </div>
              )}
              <MessageToolbar>
                <IconButton icon={Copy} size={12} tooltip="Copy message" onClick={() => copyText(visible)} />
                {actions.canEdit && (
                  <IconButton
                    icon={PencilLine}
                    size={12}
                    tooltip="Edit and resend"
                    onClick={() => {
                      setDraft(visible)
                      setEditing(true)
                    }}
                  />
                )}
              </MessageToolbar>
            </>
          )}
        </div>
      </div>
    )
  }

  const done = !message.pending
  return (
    <div className="msg assistant group">
      <div className="msg-avatar">
        <Sparkles size={13} />
      </div>
      <div className="msg-body">
        {message.activity && <ActivityPanel message={message} />}
        {message.error && (
          <div className="mb-2 rounded-lg border border-[#5a2a35] bg-[#2a1218] p-2.5 text-xs text-[var(--red)]">
            <div className="flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span className="break-words">{message.error}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {actions.canRegenerate && (
                <button className="btn !py-0.5 !px-2 text-[10px]" onClick={actions.onRegenerate}>
                  <RotateCw size={11} />
                  Retry
                </button>
              )}
              {/No AI model configured/.test(message.error) && (
                <button className="btn !py-0.5 !px-2 text-[10px]" onClick={actions.openSettings}>
                  <Settings size={11} />
                  Open settings
                </button>
              )}
            </div>
          </div>
        )}
        {message.toolEvents && message.toolEvents.length > 0 && (
          <div className="mb-1 flex flex-col items-start">
            {message.toolEvents.map((e, i) => (
              <ToolEventItem key={i} entry={e} />
            ))}
          </div>
        )}
        {message.content && <Markdown text={message.content} streaming={message.pending} />}
        {message.changes && message.changes.length > 0 && (
          <ChangeCard sessionId={actions.sessionId} message={message} />
        )}
        {!message.content && message.pending && !message.activity && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        )}
        {done && (message.content || message.error) && (
          <MessageToolbar>
            {message.content && (
              <IconButton icon={Copy} size={12} tooltip="Copy reply" onClick={() => copyText(message.content)} />
            )}
            {actions.canRegenerate && (
              <IconButton icon={RotateCw} size={12} tooltip="Regenerate reply" onClick={actions.onRegenerate} />
            )}
          </MessageToolbar>
        )}
      </div>
    </div>
  )
}

/* ------------------------------ project brief ------------------------------- */

function ProjectBriefCard() {
  const brief = useAppStore((s) => s.projectBrief)
  const loading = useAppStore((s) => s.briefLoading)
  const folder = useAppStore((s) => s.folder)
  const knowledge = useKnowledgeStore()
  const [expanded, setExpanded] = useState(false)

  if (!folder) return null

  return (
    <div className="brief-card">
      <div className="flex items-center gap-2">
        <BrainCircuit size={14} className="text-[var(--accent)] shrink-0" />
        <span className="text-xs font-semibold">Project brief</span>
        {brief && (
          <span className="text-[10px] text-[var(--text-faint)]">
            {new Date(brief.at).toLocaleTimeString()}
          </span>
        )}
        <div className="flex-1" />
        {loading && <Spinner size={11} />}
        <IconButton
          icon={RefreshCw}
          size={12}
          tooltip="Regenerate project brief"
          onClick={() => void refreshProjectBrief()}
        />
      </div>
      {brief ? (
        <>
          <div
            className={cn(
              'prose-chat text-[11.5px] mt-1.5',
              !expanded && 'max-h-24 overflow-hidden',
            )}
          >
            <Markdown text={brief.text} />
          </div>
          <button
            className="text-[10px] text-[var(--accent)] mt-1"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </>
      ) : (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-faint)]">
            {loading ? 'Analyzing the workspace…' : 'Scan the workspace and write a project brief (on demand).'}
          </span>
          {!loading && (
            <button
              className="btn btn-primary !py-1 !px-2 text-[10px] shrink-0"
              onClick={() => void refreshProjectBrief()}
            >
              <BrainCircuit size={11} />
              Analyze
            </button>
          )}
        </div>
      )}

      {/* AI knowledge base: per-file understanding */}
      <div className="mt-2 pt-2 border-t border-[var(--border-soft)] flex items-center gap-2">
        <Database size={12} className="text-[var(--text-faint)] shrink-0" />
        <span className="text-[10px] text-[var(--text-faint)] flex-1 truncate">
          {knowledge.scanning
            ? `Understanding… ${knowledge.done}/${knowledge.total} files`
            : knowledge.summarized > 0
              ? `Project understanding: ${knowledge.summarized} of ${knowledge.files} files`
              : 'Project understanding: not built yet'}
        </span>
        {knowledge.scanning && <Spinner size={10} />}
        {!knowledge.scanning && (
          <button
            className="btn !py-0.5 !px-2 text-[10px] shrink-0"
            title="Read the project top-down and summarize every file so the AI understands it"
            onClick={() => void buildUnderstanding()}
          >
            {knowledge.summarized > 0 ? 'Update' : 'Build'}
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------ suggestions -------------------------------- */

const SUGGESTIONS = [
  {
    icon: Lightbulb,
    label: 'Explain this codebase',
    prompt:
      'Explore the workspace and give me a concise overview of the project structure, key files and architecture.',
  },
  {
    icon: TestTube2,
    label: 'Write tests',
    prompt: 'Generate a test suite for the most important module in this workspace.',
  },
  {
    icon: Wand2,
    label: 'Refactor a file',
    prompt: 'Pick a file in this workspace and refactor it for readability while preserving behavior.',
  },
  {
    icon: Bug,
    label: 'Find bugs',
    prompt: 'Review the workspace for likely bugs, edge cases and error-handling gaps, and suggest fixes.',
  },
]

type Menu =
  | { kind: 'slash'; items: SlashCommand[] }
  | { kind: 'mention'; items: string[] }
  | null

/* ---------------------------------- panel ----------------------------------- */

export function ChatPanel() {
  const sessions = useAIStore((s) => s.sessions)
  const activeId = useAIStore((s) => s.activeId)
  const streaming = useAIStore((s) => s.streaming)
  const attach = useAIStore((s) => s.attach)
  const ai = useAIStore()
  const folder = useAppStore((s) => s.folder)
  const session = sessions.find((s) => s.id === activeId) || null

  const [text, setText] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [mention, setMention] = useState<MentionMatch | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Ensure there is always a session when the chat is visible.
  useEffect(() => {
    if (!session) ai.newSession('chat')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.messages, streaming])

  // Ctrl+Alt+L (and the palette) focus the composer.
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('kinetic:focus-chat', focus)
    return () => window.removeEventListener('kinetic:focus-chat', focus)
  }, [])

  /* ---- composer menus: slash commands and @file mentions ---- */

  const slash = slashQuery(text)
  let menu: Menu = null
  if (!menuDismissed) {
    if (slash !== null) {
      const items = filterSlash(slash)
      if (items.length) menu = { kind: 'slash', items }
    } else if (mention) {
      const items = rankFiles(mentionFiles, mention.query)
      if (items.length) menu = { kind: 'mention', items }
    }
  }
  const menuLength = menu ? menu.items.length : 0
  const safeIndex = Math.min(menuIndex, Math.max(0, menuLength - 1))

  const acceptMenu = (i: number) => {
    if (!menu) return
    if (menu.kind === 'slash') {
      const cmd = menu.items[i]
      if (cmd.action === 'clear') {
        setText('')
        ai.clearActive()
        return
      }
      setText(`/${cmd.name} `)
      setMenuDismissed(false)
    } else if (mention) {
      const r = insertMention(text, mention, menu.items[i])
      setText(r.text)
      setMention(null)
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(r.caret, r.caret))
    }
    setMenuIndex(0)
  }

  const onTextChange = (value: string, caret: number) => {
    setText(value)
    setMenuIndex(0)
    setMenuDismissed(false)
    const m = activeMention(value, caret)
    setMention(m)
    if (m && folder) void loadMentionFiles(folder).then(setMentionFiles)
  }

  const send = () => {
    const t = text.trim()
    if (!t || streaming) return
    setText('')
    setMention(null)
    const expansion = expandSlash(t)
    if (expansion?.kind === 'clear') {
      ai.clearActive()
      return
    }
    let prompt = t
    if (expansion?.kind === 'prompt') {
      prompt = expansion.text
      // Commands about code use the selection, or the open file, when nothing is attached.
      if (expansion.needsCode && !useAIStore.getState().attach) {
        const code = currentCodeAttachment()
        if (code) useAIStore.getState().setAttach(code)
      }
    }
    void ai.send(prompt)
  }

  const actions: MessageActions = {
    sessionId: session?.id ?? '',
    canRegenerate: !streaming,
    canEdit: !streaming,
    onRegenerate: () => void ai.regenerate(),
    onEdit: (id, value) => void ai.editAndResend(id, value),
    openSettings: () => useAppStore.getState().setSidebarView('settings'),
  }
  // Only the newest user message is editable and only the newest reply can be regenerated.
  const messages = session?.messages || []
  let lastUser = -1
  let lastAssistant = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
    if (m.role === 'assistant') lastAssistant = i
  })

  return (
    <div className="sidebar-inner">
      <div className="panel-header !normal-case !tracking-normal">
        <span className="flex items-center gap-1.5 font-semibold text-[var(--text-dim)]">
          <Sparkles size={13} className="text-[var(--accent)]" />
          AI Chat
        </span>
        <div className="panel-header-actions">
          <IconButton
            icon={History}
            size={14}
            tooltip="Projects & chat history (Ctrl+Alt+H)"
            onClick={() => useAppStore.getState().setHistoryOpen(true)}
          />
          <IconButton
            icon={MessageSquarePlus}
            size={14}
            tooltip="New chat"
            onClick={() => ai.newSession(session?.mode || 'chat')}
          />
          <IconButton
            icon={Trash2}
            size={14}
            tooltip="Clear chat"
            disabled={!session || session.messages.length === 0}
            onClick={() => ai.clearActive()}
          />
        </div>
      </div>

      <div className="px-2 pb-2 flex flex-col gap-2">
        <ModelSelect kind="chat" />
        <Segmented
          value={session?.mode || 'chat'}
          options={[
            { value: 'chat', label: 'Chat', icon: MessageSquare },
            { value: 'agent', label: 'Agent', icon: Bot },
          ]}
          onChange={(m) => session && ai.setMode(session.id, m)}
        />
      </div>

      <ProjectBriefCard />

      <div ref={scrollRef} className="sidebar-scroll">
        {!session || session.messages.length === 0 ? (
          <div className="flex flex-col h-full">
            <EmptyState
              icon={Sparkles}
              title="Ask Kineticut AI"
              text={
                session?.mode === 'agent'
                  ? 'Agent mode can read your code, propose edits (you review them), and run commands with your approval.'
                  : 'Chat about your code, get explanations, generate tests or refactor — powered by Ollama locally or frontier models via API.'
              }
            />
            <div className="px-3 pb-3 grid grid-cols-1 gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-elev)] px-3 py-2 text-left text-xs text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--text)] transition-colors"
                  onClick={() => void ai.send(s.prompt)}
                >
                  <s.icon size={14} className="shrink-0 text-[var(--accent)]" />
                  {s.label}
                </button>
              ))}
            </div>
            <div className="px-3 pb-3 text-[10px] leading-relaxed text-[var(--text-faint)]">
              Tip: type <span className="font-mono text-[var(--text-dim)]">/</span> for commands
              (<span className="font-mono">/review</span>, <span className="font-mono">/tests</span>…) and{' '}
              <span className="font-mono text-[var(--text-dim)]">@</span> to attach a project file.
            </div>
          </div>
        ) : (
          <div className="pb-2">
            {messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                actions={{
                  ...actions,
                  canRegenerate: actions.canRegenerate && i === lastAssistant,
                  canEdit: actions.canEdit && i === lastUser,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="relative border-t border-[var(--border-soft)] p-2 flex flex-col gap-1.5">
        {menu && (
          <div
            role="listbox"
            className="absolute bottom-full left-2 right-2 mb-1 max-h-60 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-1 shadow-xl z-10"
          >
            {menu.kind === 'slash'
              ? menu.items.map((c, i) => (
                  <button
                    key={c.name}
                    role="option"
                    aria-selected={i === safeIndex}
                    onMouseEnter={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      acceptMenu(i)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                      i === safeIndex ? 'bg-[var(--bg-active)] text-[var(--text)]' : 'text-[var(--text-dim)]',
                    )}
                  >
                    <span className="font-mono text-[var(--accent)]">/{c.name}</span>
                    <span className="truncate text-[var(--text-faint)]">{c.hint}</span>
                  </button>
                ))
              : menu.items.map((f, i) => (
                  <button
                    key={f}
                    role="option"
                    aria-selected={i === safeIndex}
                    onMouseEnter={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      acceptMenu(i)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                      i === safeIndex ? 'bg-[var(--bg-active)] text-[var(--text)]' : 'text-[var(--text-dim)]',
                    )}
                  >
                    <FileCode size={12} className="shrink-0 text-[var(--accent)]" />
                    <span className="truncate">{basename(f)}</span>
                    <span className="truncate text-[var(--text-faint)] text-[10px]">{f}</span>
                  </button>
                ))}
          </div>
        )}
        {attach && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-elev)] px-2 py-1.5 text-[11px] text-[var(--text-dim)]">
            <FileCode size={12} className="shrink-0 text-[var(--accent)]" />
            <span className="truncate flex-1">{attach.label}</span>
            <button
              className="icon-btn !w-4 !h-4"
              onClick={() => ai.setAttach(null)}
              title="Remove attachment"
            >
              <X size={10} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <IconButton
            icon={Paperclip}
            size={15}
            tooltip="Attach current selection"
            onClick={attachSelectionToChat}
          />
          <textarea
            ref={inputRef}
            className="field-input flex-1 !py-1.5 !text-xs resize-none"
            rows={2}
            aria-label="Message the AI"
            placeholder={
              session?.mode === 'agent'
                ? 'Ask the agent to build, fix or explore…'
                : 'Ask Kineticut AI anything…'
            }
            value={text}
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={(e) => {
              if (menu) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMenuIndex((safeIndex + 1) % menuLength)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMenuIndex((safeIndex - 1 + menuLength) % menuLength)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  acceptMenu(safeIndex)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMenuDismissed(true)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {streaming ? (
            <IconButton icon={Square} size={15} tooltip="Stop generating" onClick={() => ai.stop()} />
          ) : (
            <IconButton
              icon={Send}
              size={15}
              tooltip="Send (Enter)"
              disabled={!text.trim()}
              onClick={send}
            />
          )}
        </div>
        <div className="text-[9.5px] text-[var(--text-faint)] px-0.5">
          Enter to send · Shift+Enter for newline · <span className="font-mono">/</span> commands ·{' '}
          <span className="font-mono">@</span> files ·{' '}
          {session?.mode === 'agent' ? 'Agent may propose file edits & run commands (with approval)' : 'Markdown supported'}
        </div>
      </div>
    </div>
  )
}
