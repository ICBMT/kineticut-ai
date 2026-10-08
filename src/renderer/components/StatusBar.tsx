import { Folder, GitBranch, TriangleAlert, X } from 'lucide-react'
import { basename } from '../lib/utils'
import { useAppStore } from '../store/app'
import { currentActivityLabel, useAIStore } from '../store/ai'
import { resolveChatModel, useSettingsStore } from '../store/settings'
import { Spinner } from './ui'

export function StatusBar() {
  const folder = useAppStore((s) => s.folder)
  const git = useAppStore((s) => s.gitStatus)
  const problems = useAppStore((s) => s.problems)
  const sel = useAppStore((s) => s.selectionInfo)
  const streaming = useAIStore((s) => s.streaming)
  const liveLabel = useAIStore((s) => currentActivityLabel(s))
  const settings = useSettingsStore()
  const chat = resolveChatModel(settings)
  const status = chat.provider ? settings.providerStatus[chat.provider.id] : undefined

  return (
    <div className="statusbar">
      <div className="sb-group">
        {folder && (
          <span className="sb-item" title={folder}>
            <Folder size={12} />
            {basename(folder)}
          </span>
        )}
        {git?.branch && (
          <span className="sb-item">
            <GitBranch size={12} />
            {git.branch}
            {git.ahead > 0 && ` ↑${git.ahead}`}
            {git.behind > 0 && ` ↓${git.behind}`}
          </span>
        )}
        {(problems.errors > 0 || problems.warnings > 0) && (
          <span className="sb-item" title="Problems">
            <X size={12} color="var(--red)" />
            {problems.errors}
            <TriangleAlert size={12} color="var(--yellow)" />
            {problems.warnings}
          </span>
        )}
      </div>
      <div className="sb-group">
        {streaming && (
          <span className="sb-item" title="What the AI is doing right now">
            <Spinner size={11} />
            {liveLabel ?? 'Thinking…'}
          </span>
        )}
        {chat.model && (
          <span
            className="sb-item clickable"
            title="Active AI model — click to open chat"
            onClick={() => useAppStore.getState().setChatVisible(true)}
          >
            <span
              className="sb-dot"
              style={{
                background:
                  status === 'ok'
                    ? 'var(--green)'
                    : status === 'error'
                      ? 'var(--red)'
                      : 'var(--text-faint)',
              }}
            />
            {chat.model}
          </span>
        )}
        {sel && (
          <span className="sb-item">
            Ln {sel.line}, Col {sel.column}
            {sel.selected > 0 ? ` (${sel.selected} selected)` : ''}
          </span>
        )}
        <span className="sb-item">Spaces: 2</span>
        <span className="sb-item">UTF-8</span>
      </div>
    </div>
  )
}
