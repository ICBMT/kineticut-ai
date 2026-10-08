import { ChevronRight, FileCode, Folder } from 'lucide-react'
import { breadcrumbs, type Crumb } from '../lib/breadcrumbs'
import { cn, relativePath } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'

/** Location of the active file above the editor: click a folder to open the explorer, the file to copy its path. */
export function EditorBreadcrumbs() {
  const tab = useEditorStore((s) => s.activeTab())
  const folder = useAppStore((s) => s.folder)
  if (!tab) return null
  const crumbs = breadcrumbs(tab.path, folder)

  const activate = (c: Crumb) => {
    const app = useAppStore.getState()
    if (c.isFile) {
      const text = folder ? relativePath(folder, c.path) : c.path
      void navigator.clipboard.writeText(text)
      app.toast({ kind: 'success', title: 'Path copied', message: text, duration: 1500 })
    } else {
      app.setSidebarView('explorer')
    }
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex h-[22px] shrink-0 items-center gap-0.5 overflow-hidden whitespace-nowrap border-b border-[var(--border-soft)] px-3 text-[11px] text-[var(--text-faint)]"
    >
      {crumbs.map((c, i) => (
        <span key={c.path} className="flex min-w-0 items-center gap-0.5">
          {i > 0 && <ChevronRight size={11} className="shrink-0 opacity-60" />}
          <button
            className={cn(
              'flex min-w-0 items-center gap-1 rounded px-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
              c.isFile && 'text-[var(--text-dim)]',
            )}
            title={c.isFile ? 'Copy path' : 'Show in explorer'}
            onClick={() => activate(c)}
          >
            {c.isFile ? <FileCode size={11} className="shrink-0" /> : <Folder size={11} className="shrink-0" />}
            <span className="truncate">{c.label}</span>
          </button>
        </span>
      ))}
    </nav>
  )
}
