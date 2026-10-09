import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, FileCode, FilePlus, FileSearch, Folder, FolderTree, Pencil, Search, Terminal, Eye } from 'lucide-react'
import { describeStep, resultHint, type StepKind } from '../lib/agentSteps'
import { cn } from '../lib/utils'
import type { ToolEventEntry } from '../store/ai'
import { Spinner } from './ui'

const KIND_ICON: Record<StepKind, typeof FileCode> = {
  read: Eye,
  search: Search,
  edit: Pencil,
  write: FilePlus,
  run: Terminal,
  list: Folder,
  map: FolderTree,
  other: FileSearch,
}

/** Steps shown before the rest are folded behind "Show all". */
const VISIBLE = 8

/**
 * The agent's work as a timeline: one row per tool call, with a readable label,
 * a live status, and the raw output on demand.
 */
export function AgentTimeline({ events }: { events: ToolEventEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  if (events.length === 0) return null
  const done = events.filter((e) => e.status !== 'running').length
  const hidden = Math.max(0, events.length - VISIBLE)
  const shown = showAll ? events : events.slice(-VISIBLE)
  return (
    <div className="agent-timeline" aria-label="Agent steps">
      <div className="agent-timeline-head">
        {done === events.length ? 'Steps' : 'Working'} · {done}/{events.length}
        {hidden > 0 && (
          <button className="agent-timeline-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show recent' : `Show all ${events.length}`}
          </button>
        )}
      </div>
      <ol className="agent-timeline-list">
        {shown.map((e, i) => (
          <Step key={`${e.call.id ?? i}-${i}`} entry={e} last={i === shown.length - 1} />
        ))}
      </ol>
    </div>
  )
}

function Step({ entry, last }: { entry: ToolEventEntry; last: boolean }) {
  const [open, setOpen] = useState(false)
  const step = describeStep(entry.call.name, entry.call.arguments, entry.status)
  const Icon = KIND_ICON[step.kind]
  const hint = entry.status === 'done' ? resultHint(entry.result) : ''
  return (
    <li className={cn('agent-step', `is-${entry.status}`, last && 'is-last')}>
      <span className="agent-step-rail" aria-hidden="true">
        {entry.status === 'running' ? (
          <Spinner size={11} className="text-[var(--accent)]" />
        ) : entry.status === 'error' ? (
          <AlertTriangle size={11} className="text-[var(--red)]" />
        ) : (
          <Check size={11} className="text-[var(--green)]" />
        )}
      </span>
      <button
        className="agent-step-main"
        aria-expanded={open}
        disabled={!entry.result}
        onClick={() => setOpen((v) => !v)}
        title={entry.call.name}
      >
        <Icon size={12} className="shrink-0 text-[var(--text-faint)]" />
        <span className="agent-step-verb">{step.verb}</span>
        {step.target && <span className="agent-step-target">{step.target}</span>}
        {step.detail && <span className="agent-step-detail">{step.detail}</span>}
        {hint && <span className="agent-step-hint">{hint}</span>}
        {entry.result && <ChevronDown size={11} className={cn('chevron-rot shrink-0', open && 'open')} />}
      </button>
      {open && entry.result && <pre className="agent-step-output">{entry.result}</pre>}
    </li>
  )
}
