/**
 * Readable description of one agent tool call, for the step timeline. Pure: the
 * UI passes the call's name, its JSON arguments and its status.
 */

export type StepKind = 'read' | 'search' | 'edit' | 'write' | 'run' | 'list' | 'map' | 'other'

export interface StepView {
  kind: StepKind
  /** Short verb, tense follows the status: "Reading" while running, "Read" when done. */
  verb: string
  /** What the step acted on: a path, a query, or a command. */
  target: string
  /** Extra detail such as a line range. */
  detail?: string
}

type Status = 'running' | 'done' | 'error'

const VERBS: Record<string, { kind: StepKind; running: string; done: string }> = {
  list_dir: { kind: 'list', running: 'Listing', done: 'Listed' },
  read_file: { kind: 'read', running: 'Reading', done: 'Read' },
  recall_file: { kind: 'read', running: 'Recalling', done: 'Recalled' },
  open_file: { kind: 'read', running: 'Opening', done: 'Opened' },
  codebase_search: { kind: 'search', running: 'Searching code for', done: 'Searched code for' },
  grep_search: { kind: 'search', running: 'Grepping for', done: 'Grepped for' },
  file_search: { kind: 'search', running: 'Finding files named', done: 'Found files named' },
  edit_file: { kind: 'edit', running: 'Editing', done: 'Edited' },
  create_file: { kind: 'write', running: 'Creating', done: 'Created' },
  write_file: { kind: 'write', running: 'Writing', done: 'Wrote' },
  run_command: { kind: 'run', running: 'Running', done: 'Ran' },
  project_map: { kind: 'map', running: 'Mapping project', done: 'Mapped project' },
  delete_file: { kind: 'edit', running: 'Deleting', done: 'Deleted' },
  rename_file: { kind: 'edit', running: 'Renaming', done: 'Renamed' },
  web_search: { kind: 'search', running: 'Searching the web for', done: 'Searched the web for' },
  fetch_url: { kind: 'read', running: 'Fetching', done: 'Fetched' },
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

export function describeStep(name: string, argsJson: string, status: Status): StepView {
  const args = parseArgs(argsJson)
  const spec = VERBS[name]
  const verb = spec ? (status === 'running' ? spec.running : spec.done) : name.replace(/_/g, ' ')
  const kind: StepKind = spec ? spec.kind : 'other'
  let target = str(args.path) || str(args.query) || str(args.command) || ''
  let detail: string | undefined
  if (name === 'read_file' && (args.start_line || args.end_line)) {
    detail = `lines ${str(args.start_line) || '1'}–${str(args.end_line) || 'end'}`
  }
  if (name === 'list_dir' && !target) target = '.'
  if (name === 'project_map' && !target) target = 'workspace'
  if (name === 'fetch_url') target = str(args.url) || target
  if (name === 'rename_file') target = [str(args.from), str(args.to)].filter(Boolean).join(' → ')
  return { kind, verb, target, detail }
}

/** Short right-hand hint from a tool's output, e.g. "42 lines". */
export function resultHint(result: string | undefined): string {
  if (!result) return ''
  const lines = result.split('\n').filter((l) => l.trim() !== '').length
  if (lines === 0) return ''
  return lines === 1 ? '1 line' : `${lines} lines`
}
