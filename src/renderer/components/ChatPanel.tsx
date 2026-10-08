import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Bug,
  Check,
  ChevronDown,
  FileCode,
  History,
  Lightbulb,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  TestTube2,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { renderMarkdown } from '../lib/markdown'
import { refreshProjectBrief } from '../lib/projectBrief'
import { cn } from '../lib/utils'
import { editorRef } from '../lib/editorRef'
import { attachSelectionToChat } from '../lib/aiActions'
import { useAppStore } from '../store/app'
import { useAIStore, type ChatMessage, type ToolEventEntry } from '../store/ai'
import { ModelSelect } from './ModelSelect'
import { Dropdown, EmptyState, IconButton, Segmented, Spinner, type MenuItem } from './ui'

/* ------------------------------ markdown body ------------------------------- */

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)

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

/* --------------------------------- message ---------------------------------- */

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-avatar">You</div>
        <div className="msg-body">{message.content}</div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      <div className="msg-avatar">
        <Sparkles size={13} />
      </div>
      <div className="msg-body">
        {message.error && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-[#5a2a35] bg-[#2a1218] p-2.5 text-xs text-[var(--red)]">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span className="break-words">{message.error}</span>
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
        {!message.content && message.pending && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
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

/* ---------------------------------- panel ----------------------------------- */

export function ChatPanel() {
  const sessions = useAIStore((s) => s.sessions)
  const activeId = useAIStore((s) => s.activeId)
  const streaming = useAIStore((s) => s.streaming)
  const attach = useAIStore((s) => s.attach)
  const ai = useAIStore()
  const session = sessions.find((s) => s.id === activeId) || null

  const [text, setText] = useState('')
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

  const send = () => {
    const t = text.trim()
    if (!t || streaming) return
    setText('')
    void ai.send(t)
  }

  const historyItems: MenuItem[] = [
    ...sessions.map((s) => ({
      label: s.title || 'New chat',
      icon: s.mode === 'agent' ? Bot : MessageSquare,
      onClick: () => ai.setActive(s.id),
    })),
    { type: 'separator' as const },
    {
      label: 'New chat',
      icon: MessageSquarePlus,
      onClick: () => ai.newSession(session?.mode || 'chat'),
    },
  ]

  return (
    <div className="sidebar-inner">
      <div className="panel-header !normal-case !tracking-normal">
        <span className="flex items-center gap-1.5 font-semibold text-[var(--text-dim)]">
          <Sparkles size={13} className="text-[var(--accent)]" />
          AI Chat
        </span>
        <div className="panel-header-actions">
          <Dropdown
            align="right"
            width={220}
            trigger={
              <span className="icon-btn cursor-pointer">
                <History size={14} />
              </span>
            }
            items={historyItems}
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
          </div>
        ) : (
          <div className="pb-2">
            {session.messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--border-soft)] p-2 flex flex-col gap-1.5">
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
            placeholder={
              session?.mode === 'agent'
                ? 'Ask the agent to build, fix or explore…'
                : 'Ask Kineticut AI anything…'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
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
          Enter to send · Shift+Enter for newline ·{' '}
          {session?.mode === 'agent' ? 'Agent may propose file edits & run commands (with approval)' : 'Markdown supported'}
        </div>
      </div>
    </div>
  )
}
