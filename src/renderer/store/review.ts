/**
 * Batch review of agent changes. With the "review at the end" setting, an agent
 * write is staged here instead of being written: later edits in the same turn
 * build on the staged text, and the user accepts or rejects every file (and every
 * hunk of every file) in one review. Nothing reaches disk until it is accepted.
 *
 * Pending changes survive a reload, so an unreviewed change is never lost.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { api } from '../api'
import { applyHunkDecisions, computeHunks } from '../lib/diffHunks'
import { useAppStore } from './app'

export interface PendingChange {
  path: string
  /** Disk content before the first staged write; null when the file did not exist. */
  original: string | null
  /** The proposed content: every staged write in the turn, applied in order. */
  staged: string
  /** One flag per hunk of (original → staged): true = accept. */
  decisions: boolean[]
  sessionId: string
  messageId: string
  stagedAt: number
}

/** Staged content above this size goes through the per-write diff instead. */
export const MAX_STAGED_CHARS = 300_000

export interface AppliedEvent {
  sessionId: string
  messageId: string
  write: { path: string; before: string | null; after: string }
}

/** Listeners told about each file the review actually wrote (used for undo checkpoints). */
const appliedListeners = new Set<(e: AppliedEvent) => void>()
export function onReviewApplied(fn: (e: AppliedEvent) => void): () => void {
  appliedListeners.add(fn)
  return () => appliedListeners.delete(fn)
}

interface ReviewState {
  pending: Record<string, PendingChange>
  /** The review panel is open, optionally focused on one file. */
  reviewOpen: boolean
  reviewFocus: string | null

  stage(args: {
    path: string
    before: string | null
    after: string
    sessionId: string
    messageId: string
  }): void
  setDecision(path: string, index: number, accepted: boolean): void
  setAllDecisions(path: string, accepted: boolean): void
  applyFile(path: string): Promise<boolean>
  discardFile(path: string): void
  applyAll(): Promise<void>
  discardAll(): void
  openReview(path?: string | null): void
  closeReview(): void
}

/** The staged text for a path, if an agent has changed it in this review. */
export function stagedContent(path: string): string | undefined {
  return useReviewStore.getState().pending[path]?.staged
}

/** Hunks of a pending change: what the user is reviewing. */
export function hunksOf(change: PendingChange) {
  return computeHunks(change.original ?? '', change.staged)
}

/**
 * Write the file as the user decided, unless it changed on disk since the agent
 * read it. Returns the text written, or null when nothing needed writing.
 */
async function writeDecided(change: PendingChange): Promise<{ wrote: boolean; text: string | null }> {
  const hunks = hunksOf(change)
  const text = applyHunkDecisions(change.original ?? '', hunks, change.decisions)
  if (change.original === null && text === '') return { wrote: false, text: null }
  if (change.original !== null && text === change.original) return { wrote: false, text: null }
  await api.fs.write(change.path, text)
  return { wrote: true, text }
}

async function diskMatchesOriginal(change: PendingChange): Promise<boolean> {
  try {
    const res = await api.fs.read(change.path)
    return change.original === null ? false : res.content === change.original
  } catch {
    return change.original === null
  }
}

export const useReviewStore = create<ReviewState>()(
  persist(
    (set, get) => ({
      pending: {},
      reviewOpen: false,
      reviewFocus: null,

      stage: ({ path, before, after, sessionId, messageId }) =>
        set((s) => {
          const existing = s.pending[path]
          // The first staged write keeps the original; later ones only move `staged`.
          const original = existing ? existing.original : before
          const next: PendingChange = {
            path,
            original,
            staged: after,
            sessionId,
            messageId,
            stagedAt: Date.now(),
            decisions: computeHunks(original ?? '', after).map(() => true),
          }
          return { pending: { ...s.pending, [path]: next } }
        }),

      setDecision: (path, index, accepted) =>
        set((s) => {
          const change = s.pending[path]
          if (!change) return s
          const decisions = change.decisions.map((d, i) => (i === index ? accepted : d))
          return { pending: { ...s.pending, [path]: { ...change, decisions } } }
        }),

      setAllDecisions: (path, accepted) =>
        set((s) => {
          const change = s.pending[path]
          if (!change) return s
          return {
            pending: { ...s.pending, [path]: { ...change, decisions: change.decisions.map(() => accepted) } },
          }
        }),

      applyFile: async (path) => {
        const change = get().pending[path]
        if (!change) return false
        const app = useAppStore.getState()
        if (!(await diskMatchesOriginal(change))) {
          app.toast({
            kind: 'warning',
            title: 'Changed on disk since the AI read it',
            message: `${path.split(/[\\/]/).pop()} was edited elsewhere. Discard the AI change, or open the full diff to merge by hand.`,
          })
          return false
        }
        const result = await writeDecided(change)
        if (result.wrote && result.text !== null) {
          for (const fn of appliedListeners) {
            fn({
              sessionId: change.sessionId,
              messageId: change.messageId,
              write: { path, before: change.original, after: result.text },
            })
          }
        }
        set((s) => {
          const { [path]: _gone, ...rest } = s.pending
          return { pending: rest }
        })
        return true
      },

      discardFile: (path) =>
        set((s) => {
          const { [path]: _gone, ...rest } = s.pending
          return { pending: rest }
        }),

      applyAll: async () => {
        let applied = 0
        for (const path of Object.keys(get().pending)) {
          if (await get().applyFile(path)) applied++
        }
        if (applied) {
          useAppStore.getState().toast({
            kind: 'success',
            title: `Applied ${applied} file${applied === 1 ? '' : 's'}`,
            message: 'Each applied change can still be undone from its chat reply.',
          })
        }
      },

      discardAll: () => set({ pending: {} }),

      openReview: (path = null) => set({ reviewOpen: true, reviewFocus: path }),
      closeReview: () => set({ reviewOpen: false }),
    }),
    {
      name: 'kineticut.review.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ pending: s.pending }),
    },
  ),
)
