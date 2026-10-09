/**
 * Checkpoints for agent turns. Every file an agent write changes is recorded
 * with what it looked like before, so the whole turn can be undone in one
 * click, the way Cursor's checkpoints work. Pure logic only: the store performs
 * the file operations, so these rules can be tested without a filesystem.
 */

/** Larger files are not stored (they would bloat chat history); their turn cannot undo them. */
export const MAX_CHECKPOINT_CHARS = 120_000

export type ChangeStatus = 'applied' | 'reverted' | 'kept' | 'unavailable'

export interface FileChange {
  path: string
  /** The file's content before the first agent write in this turn. null = the file was created. */
  before: string | null
  /** Hash and length of the content the agent wrote last, to detect later user edits. */
  afterHash: string
  afterLength: number
  status: ChangeStatus
  /** Set when the content was too large to store; such a change can only be reported. */
  tooLarge?: boolean
  /** The agent deleted the file. `before` holds what it was; undo restores it. */
  deleted?: boolean
  at: number
}

/** 32-bit FNV-1a. Enough to notice that a file changed since the agent wrote it. */
export function hashContent(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Record one agent write. The first write to a path in a turn keeps its
 * original `before`, so undo restores the state from before the turn, not an
 * intermediate one.
 */
export function recordWrite(
  changes: FileChange[],
  write: { path: string; before: string | null; after: string | null },
  at = Date.now(),
): FileChange[] {
  const existing = changes.find((c) => c.path === write.path)
  const tooLarge = write.before !== null && write.before.length > MAX_CHECKPOINT_CHARS
  const after = write.after ?? ''
  const base = {
    afterHash: hashContent(after),
    afterLength: after.length,
    status: 'applied' as const,
    at,
    deleted: write.after === null,
  }
  if (existing) {
    return changes.map((c) =>
      c === existing
        ? { ...c, ...base, tooLarge: c.tooLarge || tooLarge, before: c.before, status: 'applied' }
        : c,
    )
  }
  return [
    ...changes,
    {
      path: write.path,
      before: tooLarge ? null : write.before,
      ...base,
      tooLarge,
    },
  ]
}

export type UndoOp =
  | { kind: 'restore'; path: string; content: string }
  | { kind: 'remove'; path: string }

export interface UndoPlan {
  ops: { change: FileChange; op: UndoOp }[]
  /** Files the user has edited since the agent wrote them. They are left alone. */
  kept: FileChange[]
  /** Files that cannot be undone (too large to have been stored). */
  unavailable: FileChange[]
}

/**
 * Work out how to undo the applied changes. `currentContent` returns what is on
 * disk now (null if missing). A file whose content no longer matches what the
 * agent wrote is kept, so the user's own edits are never overwritten.
 */
export function planUndo(
  changes: FileChange[],
  currentContent: (path: string) => string | null,
): UndoPlan {
  const plan: UndoPlan = { ops: [], kept: [], unavailable: [] }
  for (const change of changes) {
    if (change.status !== 'applied') continue
    if (change.tooLarge) {
      plan.unavailable.push(change)
      continue
    }
    const now = currentContent(change.path)
    if (change.deleted) {
      // Undo brings the file back only while it is still missing.
      if (now === null && change.before !== null) {
        plan.ops.push({ change, op: { kind: 'restore', path: change.path, content: change.before } })
      } else {
        plan.kept.push(change)
      }
      continue
    }
    const stillAgentVersion =
      now !== null && now.length === change.afterLength && hashContent(now) === change.afterHash
    const createdAndGone = change.before === null && now === null
    if (!stillAgentVersion && !createdAndGone) {
      plan.kept.push(change)
      continue
    }
    plan.ops.push({
      change,
      op: change.before === null ? { kind: 'remove', path: change.path } : { kind: 'restore', path: change.path, content: change.before },
    })
  }
  // Undo newest first, so a file written twice in one turn ends at its original.
  plan.ops.reverse()
  return plan
}

/** Short human summary of a turn's changes, e.g. "3 files: 2 edited, 1 created". */
export function describeChanges(changes: FileChange[]): string {
  const applied = changes.filter((c) => c.status === 'applied')
  const created = applied.filter((c) => c.before === null && !c.tooLarge).length
  const edited = applied.length - created
  const parts = []
  if (edited) parts.push(`${edited} edited`)
  if (created) parts.push(`${created} created`)
  const noun = applied.length === 1 ? 'file' : 'files'
  return parts.length ? `${applied.length} ${noun}: ${parts.join(', ')}` : `${changes.length} ${changes.length === 1 ? 'file' : 'files'}`
}
