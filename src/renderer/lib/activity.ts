/**
 * Live activity model for one assistant turn: what it is doing right now
 * (reading project knowledge, thinking, running a tool, writing) plus a
 * timeline of what it did. Pure helpers — no React, no I/O — shared by the
 * chat store (which records activity) and the UI (which renders it).
 */

export type ActivityPhase =
  | 'context'
  | 'connecting'
  | 'thinking'
  | 'tool'
  | 'writing'
  | 'done'
  | 'stopped'
  | 'error'

export type TrailKind = 'info' | 'ok' | 'tool' | 'warn' | 'err'

export interface TrailEntry {
  at: number
  text: string
  kind: TrailKind
}

export interface ActiveTool {
  id: string
  name: string
  label: string
  startedAt: number
}

export interface ChatActivity {
  phase: ActivityPhase
  startedAt: number
  endedAt?: number
  model?: string
  /** 1-based model turn (agent mode can take several). */
  step: number
  maxSteps?: number
  /** Characters streamed into the visible answer so far. */
  chars: number
  /** Tool calls started this turn. */
  tools: number
  currentTool?: ActiveTool
  /** Files the knowledge base selected as relevant to the question. */
  contextFiles: string[]
  /** Files the agent opened or listed through its tools. */
  touchedFiles: string[]
  trail: TrailEntry[]
}

const TRAIL_LIMIT = 40

export function createActivity(model?: string): ChatActivity {
  return {
    phase: 'context',
    startedAt: Date.now(),
    model,
    step: 1,
    chars: 0,
    tools: 0,
    contextFiles: [],
    touchedFiles: [],
    trail: [],
  }
}

export function appendTrail(trail: TrailEntry[], entry: TrailEntry): TrailEntry[] {
  return [...trail.slice(-(TRAIL_LIMIT - 1)), entry]
}

/** Short human label for a tool call: the path / command / query it works on. */
export function toolLabel(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    const v = args.path ?? args.command ?? args.query ?? args.pattern
    return typeof v === 'string' ? v.slice(0, 120) : ''
  } catch {
    return ''
  }
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] || '').slice(0, 100)
}

/** One-line outcome of a tool run, e.g. "142 lines" or "3 entries". */
export function summarizeToolResult(name: string, result: string, error?: boolean): string {
  if (error) return firstLine(result) || 'failed'
  const lines = result.split('\n').length
  const nonEmpty = result.split('\n').filter((l) => l.trim().length > 0).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  switch (name) {
    case 'read_file':
      return plural(lines, 'line', 'lines')
    case 'list_dir':
      return plural(nonEmpty, 'entry', 'entries')
    case 'grep_search':
      return plural(nonEmpty, 'match', 'matches')
    case 'codebase_search':
      return plural(nonEmpty, 'result', 'results')
    case 'file_search':
      return plural(nonEmpty, 'file', 'files')
    default:
      return firstLine(result).slice(0, 80) || 'done'
  }
}

export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4))
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

export function fileBase(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** Full sentence for the activity header, e.g. "Running read_file". */
export function phaseLabel(a: ChatActivity): string {
  switch (a.phase) {
    case 'context':
      return 'Reading project knowledge'
    case 'connecting':
      return `Connecting to ${a.model ?? 'model'}`
    case 'thinking':
      return a.maxSteps && a.step > 1 ? `Planning step ${a.step} of ${a.maxSteps}` : 'Thinking'
    case 'tool':
      return a.currentTool ? `Running ${a.currentTool.name}` : 'Running tools'
    case 'writing':
      return 'Writing the answer'
    case 'done':
      return 'Done'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Failed'
  }
}

/** Compact label for the status bar while a reply is in flight. */
export function statusLabel(a: ChatActivity): string {
  switch (a.phase) {
    case 'context':
      return 'Reading context…'
    case 'connecting':
      return 'Connecting…'
    case 'thinking':
      return a.maxSteps && a.step > 1 ? `Step ${a.step}…` : 'Thinking…'
    case 'tool':
      return a.currentTool ? `${a.currentTool.name}…` : 'Running tools…'
    case 'writing':
      return `Writing · ${estimateTokens(a.chars)} tok`
    default:
      return 'Thinking…'
  }
}
