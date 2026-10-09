import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileCode, FileDiff, Maximize2, X } from 'lucide-react'
import { useReviewStore, hunksOf, type PendingChange } from '../store/review'
import { useAppStore } from '../store/app'
import { basename, cn } from '../lib/utils'
import { Modal, EmptyState } from './ui'
import { countChanges, type Hunk } from '../lib/diffHunks'

/** Lines shown per hunk before the rest is folded. */
const HUNK_LINE_CAP = 160

function dirOf(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.slice(-2).join('/')
}

/**
 * Review of every file the agent staged in a batch: per-file and per-hunk accept
 * or reject, then apply. Staged changes are not on disk until applied.
 */
export function ReviewPanel() {
  const open = useReviewStore((s) => s.reviewOpen)
  const pending = useReviewStore((s) => s.pending)
  const focus = useReviewStore((s) => s.reviewFocus)
  const closeReview = useReviewStore((s) => s.closeReview)
  const openReview = useReviewStore((s) => s.openReview)
  const paths = Object.keys(pending)
  const selected = focus && pending[focus] ? focus : (paths[0] ?? null)
  const change = selected ? pending[selected] : null

  const totalAccepted = paths.reduce((n, p) => n + pending[p].decisions.filter(Boolean).length, 0)

  return (
    <Modal
      open={open}
      onClose={closeReview}
      title={
        <span className="flex items-center gap-2">
          <FileDiff size={15} className="text-[var(--accent)]" />
          Review AI changes
          {paths.length > 0 && (
            <span className="text-xs font-normal text-[var(--text-faint)]">
              {paths.length} file{paths.length === 1 ? '' : 's'} staged
            </span>
          )}
        </span>
      }
      wide
      footer={
        paths.length > 0 ? (
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-faint)]">
              {totalAccepted} hunk{totalAccepted === 1 ? '' : 's'} accepted. Rejected hunks stay as they were.
            </span>
            <div className="flex gap-2">
              <button className="btn" onClick={() => useReviewStore.getState().discardAll()}>
                Discard all
              </button>
              <button
                className="btn btn-primary"
                disabled={totalAccepted === 0 && paths.every((p) => pending[p].original !== null)}
                onClick={() => void useReviewStore.getState().applyAll()}
              >
                Apply {paths.length === 1 ? 'file' : `${paths.length} files`}
              </button>
            </div>
          </div>
        ) : null
      }
    >
      {paths.length === 0 ? (
        <EmptyState
          icon={FileDiff}
          title="Nothing to review"
          text="When an agent stages changes in review-at-the-end mode, they appear here."
        />
      ) : (
        <div className="review-layout">
          <ul className="review-files" role="listbox" aria-label="Staged files">
            {paths.map((p) => {
              const c = pending[p]
              const hunks = hunksOf(c)
              const accepted = c.decisions.filter(Boolean).length
              return (
                <li key={p}>
                  <button
                    role="option"
                    aria-selected={p === selected}
                    className={cn('review-file', p === selected && 'is-active')}
                    onClick={() => openReview(p)}
                  >
                    <FileCode size={13} className="shrink-0 text-[var(--accent)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[var(--text)]">{basename(p)}</span>
                      <span className="block truncate text-[10px] text-[var(--text-faint)]">{dirOf(p)}</span>
                    </span>
                    <span className="review-file-meta">
                      {c.original === null && <span className="review-badge">new</span>}
                      <span className="text-[10px] text-[var(--text-faint)]">
                        {accepted}/{hunks.length}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          {change && <FileReview change={change} />}
        </div>
      )}
    </Modal>
  )
}

function FileReview({ change }: { change: PendingChange }) {
  const hunks = useMemo(() => hunksOf(change), [change])
  const original = change.original ?? ''
  const originalLines = original === '' ? [] : original.split('\n')
  const accepted = change.decisions.filter(Boolean).length

  const applyFile = async () => {
    const ok = await useReviewStore.getState().applyFile(change.path)
    if (ok) useAppStore.getState().toast({ kind: 'success', title: `Applied ${basename(change.path)}` })
  }

  return (
    <section className="review-file-pane" aria-label={`Changes in ${basename(change.path)}`}>
      <header className="review-file-head">
        <div className="min-w-0">
          <div className="truncate text-sm text-[var(--text)]">{change.path}</div>
          <div className="text-[11px] text-[var(--text-faint)]">
            {hunks.length === 0
              ? 'No changes'
              : `${hunks.length} change${hunks.length === 1 ? '' : 's'} · ${accepted} accepted`}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            className="btn !py-1 !text-[11px]"
            disabled={hunks.length === 0}
            onClick={() => useReviewStore.getState().setAllDecisions(change.path, true)}
          >
            Accept all
          </button>
          <button
            className="btn !py-1 !text-[11px]"
            disabled={hunks.length === 0}
            onClick={() => useReviewStore.getState().setAllDecisions(change.path, false)}
          >
            Reject all
          </button>
          <button className="btn btn-primary !py-1 !text-[11px]" onClick={() => void applyFile()}>
            Apply file
          </button>
          <button
            className="btn !py-1 !text-[11px]"
            title="Drop this file's staged change without writing it"
            onClick={() => useReviewStore.getState().discardFile(change.path)}
          >
            Discard
          </button>
        </div>
      </header>

      <div className="review-hunks">
        {hunks.length === 0 && <p className="p-4 text-xs text-[var(--text-faint)]">The staged text matches the file.</p>}
        {hunks.map((h, i) => (
          <HunkCard
            key={`${h.oldStart}-${i}`}
            index={i}
            hunk={h}
            accepted={change.decisions[i]}
            context={originalLines.slice(Math.max(0, h.oldStart - 2), h.oldStart)}
            onSet={(v) => useReviewStore.getState().setDecision(change.path, i, v)}
          />
        ))}
      </div>
    </section>
  )
}

function HunkCard({
  index,
  hunk,
  accepted,
  context,
  onSet,
}: {
  index: number
  hunk: Hunk
  accepted: boolean
  context: string[]
  onSet(accepted: boolean): void
}) {
  const [showAll, setShowAll] = useState(false)
  const lines = [
    ...hunk.oldLines.map((t) => ({ kind: 'del' as const, text: t })),
    ...hunk.newLines.map((t) => ({ kind: 'add' as const, text: t })),
  ]
  const shown = showAll ? lines : lines.slice(0, HUNK_LINE_CAP)
  const hidden = lines.length - shown.length
  const startLine = hunk.oldStart + 1

  return (
    <article className={cn('review-hunk', !accepted && 'is-rejected')} aria-label={`Change ${index + 1}`}>
      <header className="review-hunk-head">
        <span className="text-[11px] text-[var(--text-dim)]">
          Change {index + 1} · line {startLine}
          <span className="ml-2 text-[var(--text-faint)]">
            −{hunk.oldLines.length} +{hunk.newLines.length}
          </span>
        </span>
        <div className="flex gap-1">
          <button
            className={cn('review-toggle is-accept', accepted && 'is-on')}
            aria-pressed={accepted}
            onClick={() => onSet(true)}
          >
            <Check size={12} /> Accept
          </button>
          <button
            className={cn('review-toggle is-reject', !accepted && 'is-on')}
            aria-pressed={!accepted}
            onClick={() => onSet(false)}
          >
            <X size={12} /> Reject
          </button>
        </div>
      </header>
      <pre className="review-code">
        {context.map((t, i) => (
          <div key={`c${i}`} className="review-line is-context">
            <span className="review-sign"> </span>
            {t || ' '}
          </div>
        ))}
        {shown.map((l, i) => (
          <div key={i} className={cn('review-line', l.kind === 'add' ? 'is-add' : 'is-del')}>
            <span className="review-sign">{l.kind === 'add' ? '+' : '-'}</span>
            {l.text || ' '}
          </div>
        ))}
        {hidden > 0 && (
          <button className="review-more" onClick={() => setShowAll(true)}>
            Show {hidden} more line{hidden === 1 ? '' : 's'}
          </button>
        )}
      </pre>
    </article>
  )
}

/** Chat-side notice that agent changes are waiting for review. */
/**
 * Cursor-style "N files changed" bar above the composer. Every staged file shows
 * its +/- counts with its own accept and reject; the header accepts or rejects
 * the whole batch. Nothing is on disk until it is accepted.
 */
export function ChangesBar() {
  const pending = useReviewStore((s) => s.pending)
  const [collapsed, setCollapsed] = useState(false)
  const paths = Object.keys(pending)
  if (paths.length === 0) return null
  const stats = paths.map((p) => countChanges(hunksOf(pending[p])))
  const added = stats.reduce((n, c) => n + c.added, 0)
  const removed = stats.reduce((n, c) => n + c.removed, 0)
  const store = () => useReviewStore.getState()
  const acceptFile = async (path: string) => {
    const ok = await store().applyFile(path)
    if (ok) useAppStore.getState().toast({ kind: 'success', title: `Accepted ${basename(path)}`, duration: 1600 })
  }
  return (
    <section className="changes-bar" aria-label="Files changed by the AI">
      <header className="changes-bar-head">
        <button
          className="changes-bar-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Show changed files' : 'Hide changed files'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>
            {paths.length} file{paths.length === 1 ? '' : 's'} changed
          </span>
          <span className="changes-stat-add">+{added}</span>
          <span className="changes-stat-del">−{removed}</span>
        </button>
        <div className="changes-bar-actions">
          <button
            className="changes-row-btn"
            title="Open the full review with per-hunk controls"
            aria-label="Open full review"
            onClick={() => store().openReview(null)}
          >
            <Maximize2 size={12} />
          </button>
          <button className="btn !py-0.5 !px-2 text-[11px]" title="Reject every staged change" onClick={() => store().discardAll()}>
            Reject all
          </button>
          <button
            className="btn btn-primary !py-0.5 !px-2 text-[11px]"
            title="Accept every staged change and write it to disk"
            onClick={() => void store().applyAll()}
          >
            Accept all
          </button>
        </div>
      </header>
      {!collapsed && (
        <ul className="changes-bar-list">
          {paths.map((p, i) => {
            const c = pending[p]
            return (
              <li key={p} className="changes-bar-row">
                <button className="changes-bar-file" title={p} onClick={() => store().openReview(p)}>
                  <FileCode size={12} className="shrink-0 text-[var(--accent)]" />
                  <span className="truncate">{basename(p)}</span>
                  {c.original === null && <span className="review-badge">new</span>}
                  <span className="changes-stat-add">+{stats[i].added}</span>
                  <span className="changes-stat-del">−{stats[i].removed}</span>
                </button>
                <button
                  className="changes-row-btn is-reject"
                  title={`Reject changes to ${basename(p)}`}
                  aria-label={`Reject changes to ${basename(p)}`}
                  onClick={() => store().discardFile(p)}
                >
                  <X size={12} />
                </button>
                <button
                  className="changes-row-btn is-accept"
                  title={`Accept changes to ${basename(p)}`}
                  aria-label={`Accept changes to ${basename(p)}`}
                  onClick={() => void acceptFile(p)}
                >
                  <Check size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
