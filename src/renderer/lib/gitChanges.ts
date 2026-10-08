import { api } from '../api'
import { useAppStore } from '../store/app'
import { languageForPath } from './languages'

const TITLES: Record<string, string> = {
  added: 'New file (not in HEAD)',
  deleted: 'Deleted (HEAD version)',
  modified: 'Changes vs HEAD',
  unchanged: 'No changes vs HEAD',
}

/**
 * Open a read-only HEAD-vs-working-tree diff for one repo-relative path.
 * Reuses the shared DiffModal; binary, oversized, and unchanged files get a toast instead.
 */
export async function showGitChanges(root: string, rel: string): Promise<void> {
  const app = useAppStore.getState()
  try {
    const d = await api.git.show(root, rel)
    if (d.binary) {
      app.toast({ kind: 'info', title: 'Binary file', message: `${rel} has no text diff.`, duration: 2600 })
      return
    }
    if (d.tooLarge) {
      app.toast({ kind: 'warning', title: 'File too large', message: `${rel} is over 2 MB.`, duration: 3200 })
      return
    }
    if (d.status === 'unchanged') {
      app.toast({ kind: 'info', title: 'No changes', message: `${rel} matches HEAD.`, duration: 2200 })
      return
    }
    app.requestDiff({
      path: rel,
      original: d.original,
      modified: d.modified,
      language: languageForPath(rel),
      title: TITLES[d.status] ?? 'Changes vs HEAD',
      resolve: () => {},
    })
  } catch (err) {
    app.toast({
      kind: 'error',
      title: 'Could not load changes',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
