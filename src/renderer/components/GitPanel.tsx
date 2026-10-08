import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { api } from '../api'
import type { GitFile } from '../../shared/types'
import { useAppStore } from '../store/app'
import { showGitChanges } from '../lib/gitChanges'
import { EmptyState, IconButton, Spinner } from './ui'

function statusLetter(file: GitFile, section: 'staged' | 'unstaged'): string {
  return section === 'staged' ? 'A' : file.status || '?'
}

function FileRow({
  file,
  section,
  onStage,
  onUnstage,
  onDiscard,
  onShow,
}: {
  file: GitFile
  section: 'staged' | 'unstaged'
  onStage(path: string): void
  onUnstage(path: string): void
  onDiscard(path: string): void
  onShow(path: string): void
}) {
  const letter = statusLetter(file, section)
  const color =
    section === 'staged'
      ? 'var(--green)'
      : letter === 'U' || letter === '?'
        ? 'var(--yellow)'
        : letter === 'D'
          ? 'var(--red)'
          : 'var(--accent)'
  return (
    <div className="tree-row group" title={file.path}>
      <span
        className="w-4 shrink-0 text-center text-[11px] font-mono font-bold"
        style={{ color }}
      >
        {letter}
      </span>
      <span
        className="fname flex-1 cursor-pointer hover:underline"
        role="button"
        tabIndex={0}
        title="Show changes vs HEAD"
        onClick={() => onShow(file.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onShow(file.path)
          }
        }}
      >
        {file.path}
      </span>
      <button
        className="hidden group-hover:flex shrink-0 w-5 h-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-active)] hover:text-[var(--text)]"
        title="Show changes"
        aria-label={`Show changes for ${file.path}`}
        onClick={(e) => {
          e.stopPropagation()
          onShow(file.path)
        }}
      >
        <FileDiff size={12} />
      </button>
      <button
        className="hidden group-hover:flex shrink-0 w-5 h-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-active)] hover:text-[var(--red)]"
        title="Discard changes"
        onClick={(e) => {
          e.stopPropagation()
          onDiscard(file.path)
        }}
      >
        <Undo2 size={12} />
      </button>
      <button
        className="hidden group-hover:flex shrink-0 w-5 h-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-active)] hover:text-[var(--text)]"
        title={section === 'staged' ? 'Unstage' : 'Stage'}
        onClick={(e) => {
          e.stopPropagation()
          if (section === 'staged') onUnstage(file.path)
          else onStage(file.path)
        }}
      >
        {section === 'staged' ? <Minus size={12} /> : <Plus size={12} />}
      </button>
    </div>
  )
}

function Section({
  title,
  files,
  section,
  onStage,
  onUnstage,
  onDiscard,
  onShow,
}: {
  title: string
  files: GitFile[]
  section: 'staged' | 'unstaged'
  onStage(path: string): void
  onUnstage(path: string): void
  onDiscard(path: string): void
  onShow(path: string): void
}) {
  const [open, setOpen] = useState(true)
  if (files.length === 0) return null
  return (
    <div className="mb-2">
      <button
        className="w-full flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-faint)] hover:text-[var(--text-dim)]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title} <span className="ml-1 font-normal">({files.length})</span>
      </button>
      {open && (
        <div>
          {files.map((f) => (
            <FileRow
              key={f.path + section}
              file={f}
              section={section}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              onShow={onShow}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function GitPanel() {
  const folder = useAppStore((s) => s.folder)
  const git = useAppStore((s) => s.gitStatus)
  const gitLoading = useAppStore((s) => s.gitLoading)
  const refreshGit = useAppStore((s) => s.refreshGit)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  // Refresh on fs changes while this panel is mounted.
  useEffect(() => {
    if (!folder) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unwatch: (() => void) | null = null
    api.fs
      .watch(folder, () => {
        if (disposed) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void refreshGit(), 400)
      })
      .then((u) => {
        if (disposed) u()
        else unwatch = u
      })
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unwatch?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder])

  const stage = useCallback(
    async (paths: string[]) => {
      if (!folder || paths.length === 0) return
      await api.git.stage(folder, paths)
      await refreshGit()
    },
    [folder, refreshGit],
  )

  const unstage = useCallback(
    async (paths: string[]) => {
      if (!folder || paths.length === 0) return
      await api.git.unstage(folder, paths)
      await refreshGit()
    },
    [folder, refreshGit],
  )

  const discard = useCallback(
    async (paths: string[]) => {
      if (!folder || paths.length === 0) return
      const ok = await new Promise<boolean>((resolve) => {
        useAppStore.getState().requestConfirm({
          title: 'Discard changes',
          message: paths.length === 1 ? paths[0] : `${paths.length} files`,
          detail: 'This permanently discards uncommitted changes. This cannot be undone.',
          confirmLabel: 'Discard',
          danger: true,
          resolve,
        })
      })
      if (!ok) return
      await api.git.discard(folder, paths)
      await refreshGit()
    },
    [folder, refreshGit],
  )

  const commit = useCallback(async () => {
    if (!folder || !message.trim() || !git || git.staged.length === 0) return
    setBusy(true)
    try {
      await api.git.commit(folder, message.trim())
      setMessage('')
      await refreshGit()
      useAppStore.getState().toast({ kind: 'success', title: 'Committed', duration: 2000 })
    } catch (err) {
      useAppStore.getState().toast({
        kind: 'error',
        title: 'Commit failed',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }, [folder, message, git, refreshGit])

  const initRepo = useCallback(async () => {
    if (!folder) return
    setBusy(true)
    try {
      await api.git.init(folder)
      await refreshGit()
    } finally {
      setBusy(false)
    }
  }, [folder, refreshGit])

  const showChanges = (path: string) => {
    if (folder) void showGitChanges(folder, path)
  }

  if (!folder) {
    return (
      <div className="sidebar-inner">
        <div className="panel-header">
          <span>Source Control</span>
        </div>
        <EmptyState icon={GitBranch} title="No folder opened" text="Open a workspace to use git." />
      </div>
    )
  }

  if (!git || !git.branch) {
    return (
      <div className="sidebar-inner">
        <div className="panel-header">
          <span>Source Control</span>
          <IconButton icon={RefreshCw} size={13} tooltip="Refresh" onClick={() => refreshGit()} />
        </div>
        <div className="sidebar-scroll">
          <EmptyState
            icon={GitBranch}
            title="Not a git repository"
            text={`${folder} is not a git repository yet.`}
            action={{
              label: busy ? 'Initializing…' : 'Initialize Repository',
              onClick: () => void initRepo(),
            }}
          />
        </div>
      </div>
    )
  }

  const unstaged: GitFile[] = [...git.modified, ...git.conflicted, ...git.untracked]
  const canCommit = message.trim().length > 0 && git.staged.length > 0 && !busy

  return (
    <div className="sidebar-inner">
      <div className="panel-header">
        <span className="flex items-center gap-1.5 normal-case tracking-normal font-semibold text-[var(--text-dim)]">
          <GitBranch size={12} />
          {git.branch}
        </span>
        <div className="panel-header-actions">
          <IconButton
            icon={Plus}
            size={13}
            tooltip="Stage all changes"
            disabled={unstaged.length === 0}
            onClick={() => void stage(unstaged.map((f) => f.path))}
          />
          <IconButton
            icon={Undo2}
            size={13}
            tooltip="Discard all changes"
            disabled={unstaged.length === 0}
            onClick={() => void discard(unstaged.map((f) => f.path))}
          />
          <IconButton
            icon={RefreshCw}
            size={13}
            tooltip="Refresh"
            className={gitLoading ? 'spin' : ''}
            onClick={() => refreshGit()}
          />
        </div>
      </div>

      <div className="px-2 pb-2">
        <textarea
          className="field-input !text-xs !py-1.5 resize-none"
          rows={2}
          placeholder="Commit message…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void commit()
          }}
        />
        <button
          className="btn btn-primary w-full mt-2 !py-1.5 text-xs"
          disabled={!canCommit}
          onClick={() => void commit()}
        >
          {busy ? <Spinner size={12} /> : null}
          Commit {git.staged.length > 0 ? `(${git.staged.length})` : ''}
        </button>
      </div>

      <div className="sidebar-scroll">
        <Section
          title="Staged"
          files={git.staged}
          section="staged"
          onStage={(p) => void stage([p])}
          onUnstage={(p) => void unstage([p])}
          onDiscard={(p) => void discard([p])}
          onShow={showChanges}
        />
        <Section
          title="Changes"
          files={unstaged}
          section="unstaged"
          onStage={(p) => void stage([p])}
          onUnstage={(p) => void unstage([p])}
          onDiscard={(p) => void discard([p])}
          onShow={showChanges}
        />
        {git.staged.length === 0 && unstaged.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-faint)] italic">
            Working tree clean 🎉
          </div>
        )}
      </div>
    </div>
  )
}
