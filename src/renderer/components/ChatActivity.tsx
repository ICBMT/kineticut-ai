import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Blocks,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  FileCode,
  PenLine,
  Timer,
  Wrench,
  X,
} from 'lucide-react'
import {
  estimateTokens,
  fileBase,
  formatElapsed,
  phaseLabel,
  type ActivityPhase,
  type ChatActivity as Activity,
  type TrailEntry,
} from '../lib/activity'
import { cn } from '../lib/utils'
import type { ChatMessage } from '../store/ai'
import { Spinner } from './ui'

/** Re-renders at a fixed cadence while `active`, so elapsed time ticks live. */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [active, intervalMs])
  return now
}

interface Stage {
  id: string
  label: string
  phases: ActivityPhase[]
}

const STAGES: Stage[] = [
  { id: 'context', label: 'Context', phases: ['context'] },
  { id: 'think', label: 'Think', phases: ['connecting', 'thinking'] },
  { id: 'tools', label: 'Tools', phases: ['tool'] },
  { id: 'write', label: 'Write', phases: ['writing'] },
]

type StageState = 'done' | 'active' | 'todo'

function PhaseIcon({ phase, live }: { phase: ActivityPhase; live: boolean }) {
  if (live) return <Spinner size={12} className="text-[var(--accent)]" />
  if (phase === 'error') return <AlertTriangle size={12} className="text-[var(--red)] shrink-0" />
  if (phase === 'stopped') return <X size={12} className="text-[var(--yellow)] shrink-0" />
  return <Check size={12} className="text-[var(--green)] shrink-0" />
}

function TrailIcon({ kind }: { kind: TrailEntry['kind'] }) {
  const cls = 'shrink-0 mt-[3px]'
  switch (kind) {
    case 'tool':
      return <Wrench size={10} className={cn(cls, 'text-[var(--accent)]')} />
    case 'ok':
      return <Check size={10} className={cn(cls, 'text-[var(--green)]')} />
    case 'warn':
      return <X size={10} className={cn(cls, 'text-[var(--yellow)]')} />
    case 'err':
      return <AlertTriangle size={10} className={cn(cls, 'text-[var(--red)]')} />
    default:
      return <span className={cn(cls, 'block w-[10px] h-[10px] text-center text-[var(--text-faint)]')}>·</span>
  }
}

function FileRow({ icon: Icon, label, files }: { icon: typeof BookOpen; label: string; files: string[] }) {
  const shown = files.slice(0, 6)
  return (
    <div className="flex items-start gap-1.5">
      <Icon size={11} className="mt-[3px] shrink-0 text-[var(--text-faint)]" />
      <span className="shrink-0 pt-[1px] text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-1">
        {shown.map((f) => (
          <span
            key={f}
            title={f}
            className="max-w-[160px] truncate rounded border border-[var(--border-soft)] bg-[var(--bg-hover)] px-1.5 py-[1px] font-mono text-[10px] text-[var(--text-dim)]"
          >
            {fileBase(f)}
          </span>
        ))}
        {files.length > shown.length && (
          <span className="text-[10px] text-[var(--text-faint)] pt-[1px]">+{files.length - shown.length} more</span>
        )}
      </div>
    </div>
  )
}

/** Stage pipeline: Context → Think → Tools → Write, with done / active / todo states. */
function StagePipeline({ activity, live }: { activity: Activity; live: boolean }) {
  const shown = STAGES.filter((s) => s.id !== 'tools' || activity.tools > 0 || activity.phase === 'tool')
  const curIdx = shown.findIndex((s) => s.phases.includes(activity.phase))
  // Highest stage reached so far, so a step-2 "Think" after Tools keeps Tools marked done.
  const reached = useRef(0)
  if (curIdx > reached.current) reached.current = curIdx

  const stateOf = (i: number): StageState => {
    if (!live) return activity.phase === 'done' || i <= reached.current ? 'done' : 'todo'
    if (i === curIdx) return 'active'
    if (i < curIdx || i <= reached.current) return 'done'
    return 'todo'
  }

  return (
    <div className="flex items-center gap-1">
      {shown.map((s, i) => {
        const st = stateOf(i)
        return (
          <div key={s.id} className="flex items-center gap-1 min-w-0">
            {i > 0 && <span className={cn('h-px w-4 shrink-0', st === 'todo' ? 'bg-[var(--border-soft)]' : 'bg-[var(--green)]')} />}
            <span
              className={cn(
                'flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] whitespace-nowrap',
                st === 'active' && 'border-[var(--accent)] text-[var(--accent)]',
                st === 'done' && 'border-[var(--border-soft)] text-[var(--text-dim)]',
                st === 'todo' && 'border-transparent text-[var(--text-faint)] opacity-60',
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  st === 'active' && 'bg-[var(--accent)] animate-pulse',
                  st === 'done' && 'bg-[var(--green)]',
                  st === 'todo' && 'bg-[var(--border)]',
                )}
              />
              {s.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Live "what is the assistant doing" panel for one assistant turn: phase,
 * timer, stage pipeline, what it is reading, its reasoning, and a timeline.
 * Collapses to a "Worked for Xs" summary once the turn finishes.
 */
export function ActivityPanel({ message }: { message: ChatMessage }) {
  const a = message.activity!
  const live = Boolean(message.pending)
  const now = useNow(live)
  const elapsed = Math.max(0, (a.endedAt ?? (live ? now : a.startedAt)) - a.startedAt)
  const seconds = Math.max(0.5, elapsed / 1000)
  const tokens = estimateTokens(a.chars)
  const rate = tokens > 0 ? Math.round(tokens / seconds) : 0

  const [trailOpen, setTrailOpen] = useState<boolean | null>(null)
  const [thinkOpen, setThinkOpen] = useState<boolean | null>(null)
  const thinkRef = useRef<HTMLDivElement>(null)
  const reasoning = message.reasoning || ''

  // Keep the reasoning box pinned to its newest line while the model thinks.
  useEffect(() => {
    if (live && thinkRef.current) thinkRef.current.scrollTop = thinkRef.current.scrollHeight
  }, [reasoning, live])

  const showTrail = trailOpen ?? live
  const showThink = thinkOpen ?? live
  const words = reasoning.trim() ? reasoning.trim().split(/\s+/).length : 0

  const headline =
    a.phase === 'done' ? `Worked for ${formatElapsed(elapsed)}` : phaseLabel(a)
  const agentStep = a.maxSteps ? `step ${a.step}/${a.maxSteps}` : ''

  return (
    <div
      className={cn(
        'act-panel mb-2 rounded-lg border bg-[var(--bg-elev)] px-2.5 py-2 text-[11.5px]',
        live ? 'border-[var(--accent)]' : 'border-[var(--border-soft)]',
      )}
    >
      {/* header: phase + timer */}
      <div className="flex items-center gap-2 min-w-0">
        <PhaseIcon phase={a.phase} live={live} />
        <span className={cn('font-semibold truncate', live ? 'text-[var(--text)]' : 'text-[var(--text-dim)]')}>
          {headline}
        </span>
        {live && a.currentTool?.label && (
          <span className="font-mono text-[10.5px] text-[var(--text-faint)] truncate min-w-0">{a.currentTool.label}</span>
        )}
        <div className="flex-1" />
        <span className="flex items-center gap-1 font-mono text-[10.5px] tabular-nums text-[var(--text-faint)] shrink-0">
          <Timer size={11} />
          {formatElapsed(elapsed)}
        </span>
      </div>

      <div className="mt-2 overflow-x-auto">
        <StagePipeline activity={a} live={live} />
      </div>

      {/* live stats */}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[var(--text-faint)]">
        {a.model && <span>{a.model}</span>}
        {agentStep && <span>{agentStep}</span>}
        {a.chars > 0 && (
          <span>
            ~{tokens} tok{rate > 0 ? ` · ${rate} tok/s` : ''}
          </span>
        )}
        {a.contextFiles.length > 0 && <span>{a.contextFiles.length} context files</span>}
        {a.tools > 0 && <span>{a.tools} tool call{a.tools === 1 ? '' : 's'}</span>}
      </div>

      {/* what it is reading */}
      {(a.contextFiles.length > 0 || a.touchedFiles.length > 0) && (
        <div className="mt-2 flex flex-col gap-1">
          {a.contextFiles.length > 0 && <FileRow icon={BookOpen} label="Context" files={a.contextFiles} />}
          {a.touchedFiles.length > 0 && <FileRow icon={FileCode} label="Opened" files={a.touchedFiles} />}
        </div>
      )}

      {/* what it is thinking */}
      {reasoning && (
        <div className="mt-2">
          <button
            className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-dim)] hover:text-[var(--text)]"
            onClick={() => setThinkOpen(!showThink)}
          >
            <Brain size={11} className={cn(live && 'animate-pulse text-[var(--accent)]')} />
            <span>{live ? 'Thinking out loud' : 'Reasoning'}</span>
            <span className="text-[var(--text-faint)]">· {words} words</span>
            <ChevronDown size={11} className={cn('chevron-rot', showThink && 'open')} />
          </button>
          {showThink && (
            <div
              ref={thinkRef}
              className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border-soft)] bg-[#0a0a12] p-2 font-mono text-[10.5px] leading-[1.5] text-[var(--text-dim)]"
            >
              {reasoning}
            </div>
          )}
        </div>
      )}

      {/* timeline of what it did */}
      {a.trail.length > 0 && (
        <div className="mt-2">
          <button
            className="flex items-center gap-1 text-[10.5px] text-[var(--text-faint)] hover:text-[var(--text-dim)]"
            onClick={() => setTrailOpen(!showTrail)}
          >
            <Blocks size={11} />
            <span>{showTrail ? 'Hide activity' : `Activity · ${a.trail.length}`}</span>
            <ChevronDown size={11} className={cn('chevron-rot', showTrail && 'open')} />
          </button>
          {showTrail && (
            <ol className="mt-1 flex flex-col gap-1 border-l border-[var(--border-soft)] pl-2.5">
              {a.trail.map((e, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[10.5px] leading-[1.45]">
                  <TrailIcon kind={e.kind} />
                  <span
                    className={cn(
                      'min-w-0 break-words',
                      e.kind === 'err' ? 'text-[var(--red)]' : e.kind === 'tool' ? 'font-mono text-[var(--text-dim)]' : 'text-[var(--text-dim)]',
                    )}
                  >
                    {e.text}
                  </span>
                  <span className="ml-auto shrink-0 pl-2 font-mono text-[9.5px] text-[var(--text-faint)]">
                    +{((e.at - a.startedAt) / 1000).toFixed(1)}s
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
