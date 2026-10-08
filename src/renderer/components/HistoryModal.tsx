/**
 * Projects & chat history: every project you have opened and every chat you
 * have had, grouped by project, so you can get back to earlier work.
 */
import { useMemo, useState } from 'react'
import { Bot, FolderOpen, FolderX, MessageSquare, Trash2 } from 'lucide-react'
import { useAppStore } from '../store/app'
import { useAIStore, type ChatSession } from '../store/ai'
import { basename } from '../lib/utils'
import { Modal, Segmented } from './ui'

type Tab = 'chats' | 'projects'

function parentOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : ''
}

/** Human label for when something happened. */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function sessionTitle(s: ChatSession): string {
  if (s.title) return s.title
  const firstUser = s.messages.find((m) => m.role === 'user')
  if (firstUser?.content) return firstUser.content.trim().slice(0, 80)
  return 'New chat'
}

function lastActivity(s: ChatSession): number {
  const last = s.messages[s.messages.length - 1]
  return last?.createdAt ?? s.createdAt
}

export function HistoryModal() {
  const open = useAppStore((s) => s.historyOpen)
  const setOpen = useAppStore((s) => s.setHistoryOpen)
  const folder = useAppStore((s) => s.folder)
  const recentFolders = useAppStore((s) => s.recentFolders)
  const removeRecentFolder = useAppStore((s) => s.removeRecentFolder)
  const sessions = useAIStore((s) => s.sessions)
  const activeId = useAIStore((s) => s.activeId)
  const [tab, setTab] = useState<Tab>('chats')
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()

  /** Chats grouped by project: newest project first. */
  const chatGroups = useMemo(() => {
    const groups = new Map<string, { key: string; path: string | null; sessions: ChatSession[] }>()
    for (const s of sessions) {
      const key = s.folder || ''
      const matches =
        !q ||
        sessionTitle(s).toLowerCase().includes(q) ||
        (s.folder || '').toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q))
      if (!matches) continue
      const g = groups.get(key) ?? { key, path: s.folder || null, sessions: [] }
      g.sessions.push(s)
      groups.set(key, g)
    }
    return [...groups.values()]
      .map((g) => ({ ...g, sessions: g.sessions.sort((a, b) => lastActivity(b) - lastActivity(a)) }))
      .sort((a, b) => lastActivity(b.sessions[0]) - lastActivity(a.sessions[0]))
  }, [sessions, q])

  /** Projects: recent folders plus any project that has chats. */
  const projects = useMemo(() => {
    const paths = new Set<string>([...recentFolders, ...sessions.map((s) => s.folder || '').filter(Boolean)])
    if (folder) paths.add(folder)
    return [...paths]
      .map((path) => {
        const chats = sessions.filter((s) => s.folder === path)
        const last = chats.reduce((m, s) => Math.max(m, lastActivity(s)), 0)
        return { path, chats: chats.length, last, recent: recentFolders.includes(path) }
      })
      .filter((p) => !q || p.path.toLowerCase().includes(q) || basename(p.path).toLowerCase().includes(q))
      .sort((a, b) => b.last - a.last || Number(b.recent) - Number(a.recent) || a.path.localeCompare(b.path))
  }, [recentFolders, sessions, folder, q])

  if (!open) return null
  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const resumeChat = (s: ChatSession) => {
    const app = useAppStore.getState()
    if (s.folder && s.folder !== app.folder) app.setFolder(s.folder)
    useAIStore.getState().setActive(s.id)
    app.setChatVisible(true)
    close()
  }

  const openProject = (path: string) => {
    useAppStore.getState().setFolder(path)
    close()
  }

  return (
    <Modal
      open
      onClose={close}
      wide
      title={
        <span className="flex items-center gap-2">
          <span>Projects &amp; Chats</span>
          <span className="font-mono text-[11px] text-[var(--text-faint)]">Ctrl+Alt+H</span>
        </span>
      }
      footer={
        <button className="btn btn-primary" onClick={close}>
          Done
        </button>
      }
    >
      <div className="flex items-center gap-2 mb-3">
        <Segmented<Tab>
          value={tab}
          options={[
            { value: 'chats', label: `Chats (${sessions.length})`, icon: MessageSquare },
            { value: 'projects', label: `Projects (${projects.length})`, icon: FolderOpen },
          ]}
          onChange={setTab}
        />
        <input
          className="field-input flex-1"
          placeholder={tab === 'chats' ? 'Search chats…' : 'Search projects…'}
          aria-label="Search history"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="max-h-[60vh] overflow-auto pr-1 flex flex-col gap-4">
        {tab === 'chats' && (
          <>
            {chatGroups.length === 0 && (
              <div className="text-sm text-[var(--text-faint)] italic">
                {q ? `No chats match “${query}”.` : 'No chats yet. Start one from the AI Chat panel.'}
              </div>
            )}
            {chatGroups.map((g) => (
              <section key={g.key || 'none'} aria-label={g.path ? basename(g.path) : 'Chats without a project'}>
                <div className="field-label mb-1.5 flex items-baseline gap-2">
                  {g.path ? (
                    <>
                      <span className="text-[var(--text)] normal-case tracking-normal">{basename(g.path)}</span>
                      <span className="truncate text-[var(--text-faint)] normal-case tracking-normal" title={g.path}>
                        {parentOf(g.path)}
                      </span>
                    </>
                  ) : (
                    <span className="flex items-center gap-1 normal-case tracking-normal">
                      <FolderX size={11} /> No project
                    </span>
                  )}
                  <span className="text-[var(--text-faint)] normal-case tracking-normal">{g.sessions.length}</span>
                </div>
                <ul className="flex flex-col gap-0.5">
                  {g.sessions.map((s) => {
                    const Icon = s.mode === 'agent' ? Bot : MessageSquare
                    const isActive = s.id === activeId
                    return (
                      <li key={s.id} className="flex items-center gap-2 group">
                        <button
                          className={`flex-1 min-w-0 flex items-center gap-2 text-left text-sm rounded px-2 py-1.5 hover:bg-[var(--bg-hover)] ${
                            isActive ? 'text-[var(--accent)]' : 'text-[var(--text-dim)]'
                          }`}
                          onClick={() => resumeChat(s)}
                          title={sessionTitle(s)}
                        >
                          <Icon size={13} className="shrink-0" />
                          <span className="truncate flex-1">{sessionTitle(s)}</span>
                          <span className="text-[11px] text-[var(--text-faint)] shrink-0">
                            {s.messages.length} msg · {relativeTime(lastActivity(s))}
                          </span>
                        </button>
                        <button
                          className="icon-btn opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0"
                          title="Delete chat"
                          aria-label={`Delete chat ${sessionTitle(s)}`}
                          onClick={() => useAIStore.getState().removeSession(s.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </>
        )}

        {tab === 'projects' && (
          <>
            {projects.length === 0 && (
              <div className="text-sm text-[var(--text-faint)] italic">
                {q ? `No projects match “${query}”.` : 'No projects yet. Open a folder to start one.'}
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {projects.map((p) => (
                <li key={p.path} className="flex items-center gap-2 group">
                  <button
                    className="flex-1 min-w-0 flex items-center gap-2 text-left text-sm rounded px-2 py-1.5 hover:bg-[var(--bg-hover)]"
                    onClick={() => openProject(p.path)}
                    title={p.path}
                  >
                    <FolderOpen size={13} className="shrink-0 text-[var(--text-faint)]" />
                    <span className={`font-semibold shrink-0 ${p.path === folder ? 'text-[var(--accent)]' : 'text-[var(--text)]'}`}>
                      {basename(p.path)}
                    </span>
                    <span className="truncate text-[var(--text-faint)] flex-1">{parentOf(p.path)}</span>
                    <span className="text-[11px] text-[var(--text-faint)] shrink-0">
                      {p.chats} {p.chats === 1 ? 'chat' : 'chats'}
                      {p.last ? ` · ${relativeTime(p.last)}` : ''}
                    </span>
                  </button>
                  {p.recent && (
                    <button
                      className="icon-btn opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0"
                      title="Remove from recent"
                      aria-label={`Remove ${basename(p.path)} from recent projects`}
                      onClick={() => removeRecentFolder(p.path)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
