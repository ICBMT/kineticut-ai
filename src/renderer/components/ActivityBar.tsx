import { FolderTree, GitBranch, MessageSquareText, Search, Settings } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useAIStore } from '../store/ai'

const projectItems = [
  { view: 'explorer', icon: FolderTree, label: 'Explorer' },
  { view: 'search', icon: Search, label: 'Search' },
  { view: 'git', icon: GitBranch, label: 'Source Control' },
] as const

export function ActivityBar() {
  const view = useAppStore((s) => s.sidebarView)
  const visible = useAppStore((s) => s.sidebarVisible)
  const chatVisible = useAppStore((s) => s.chatVisible)
  const git = useAppStore((s) => s.gitStatus)
  const streaming = useAIStore((s) => s.streaming)
  const changedCount = git
    ? git.staged.length + git.modified.length + git.untracked.length + git.conflicted.length
    : 0

  return (
    <div className="activitybar">
      {projectItems.map((it) => (
        <button
          key={it.view}
          className={cn('activity-item', visible && view === it.view && 'active')}
          title={it.label}
          onClick={() => useAppStore.getState().setSidebarView(it.view)}
        >
          <it.icon size={20} />
          {it.view === 'git' && changedCount > 0 && (
            <span className="activity-badge">{changedCount > 99 ? '99+' : changedCount}</span>
          )}
        </button>
      ))}
      <button
        className={cn('activity-item', chatVisible && 'active')}
        title="AI Chat (toggle)"
        onClick={() => useAppStore.getState().toggleChat()}
      >
        <MessageSquareText size={20} />
        {streaming && <span className="activity-dot" />}
      </button>
      <div className="activity-spacer" />
      <button
        className={cn('activity-item', visible && view === 'settings' && 'active')}
        title="Settings"
        onClick={() => useAppStore.getState().setSidebarView('settings')}
      >
        <Settings size={20} />
      </button>
    </div>
  )
}
