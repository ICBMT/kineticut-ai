/**
 * The one place a document is written to disk. Manual save, save-all and
 * autosave all go through here so the "saved" snapshot, the dirty flag and any
 * pending autosave stay consistent.
 */
import { api } from '../api'
import { setSnapshot, useEditorStore } from '../store/editor'
import { useAppStore } from '../store/app'
import { basename } from './utils'

const pendingTimers = new Map<string, number>()

function cancelPending(path: string): void {
  const t = pendingTimers.get(path)
  if (t !== undefined) window.clearTimeout(t)
  pendingTimers.delete(path)
}

/** Write `content` to `path`, then mark the document clean. Throws on failure. */
export async function persistTab(path: string, content: string): Promise<void> {
  cancelPending(path)
  await api.fs.write(path, content)
  setSnapshot(path, content)
  useEditorStore.getState().markDirty(path, false)
}

/** Save from a background trigger (autosave): reports failures as a toast instead of throwing. */
async function persistInBackground(path: string, content: string): Promise<void> {
  try {
    await persistTab(path, content)
  } catch (err) {
    useAppStore.getState().toast({
      kind: 'error',
      title: 'Auto-save failed',
      message: `${basename(path)}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

/** Autosave after the user stops typing for `delayMs`. */
export function scheduleAutoSave(
  path: string,
  model: { getValue(): string; isDisposed?(): boolean },
  delayMs: number,
): void {
  cancelPending(path)
  pendingTimers.set(
    path,
    window.setTimeout(() => {
      pendingTimers.delete(path)
      if (model.isDisposed?.()) return
      if (useEditorStore.getState().isDirty(path)) void persistInBackground(path, model.getValue())
    }, delayMs),
  )
}

/** Autosave now (focus left the editor). */
export function autoSaveNow(path: string, model: { getValue(): string; isDisposed?(): boolean }): void {
  if (model.isDisposed?.()) return
  if (!useEditorStore.getState().isDirty(path)) return
  void persistInBackground(path, model.getValue())
}
