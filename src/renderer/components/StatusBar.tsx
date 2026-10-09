import { Folder, GitBranch, TriangleAlert, X } from 'lucide-react'
import { basename } from '../lib/utils'
import { useAppStore } from '../store/app'
import { currentActivityLabel, useAIStore } from '../store/ai'
import { resolveChatModel, useSettingsStore } from '../store/settings'
import { languageLabel } from '../lib/languages'
import { useCodebaseStatus } from '../lib/codebase'
import { Spinner } from './ui'

export function StatusBar() {
  const folder = useAppStore((s) => s.folder)
  const git = useAppStore((s) => s.gitStatus)
  const problems = useAppStore((s) => s.problems)
  const sel = useAppStore((s) => s.selectionInfo)
  const streaming = useAIStore((s) => s.streaming)
  const codebase = useCodebaseStatus()
  const runningCount = useAIStore((s) => Object.keys(s.runs).length)
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
        {folder && codebase.phase === 'indexing' && (
          <span className="sb-item" title="The codebase index is updating" role="status">
            <Spinner size={11} />
            Indexing…
          </span>
        )}
        {folder && codebase.phase === 'ready' && codebase.stats && (
          <span
            className="sb-item"
            title={
              codebase.embeddingModel
                ? `Hybrid search with ${codebase.embeddingModel}. Chunks embedded: ${codebase.embedded} of ${codebase.total}.`
                : 'Keyword codebase search. Set an embedding model in Settings for meaning-based search.'
            }
          >
            {codebase.stats.files} files · {codebase.stats.chunks} chunks
            {codebase.embeddingModel && codebase.total > 0 && codebase.embedded < codebase.total
              ? ` · embedding ${Math.round((codebase.embedded / codebase.total) * 100)}%`
              : ''}
          </span>
        )}
        {streaming && (
          <span className="sb-item" title="What the AI is doing right now" role="status" aria-live="polite">
            <Spinner size={11} />
            {runningCount > 1 ? `${runningCount} chats working` : (liveLabel ?? 'Thinking…')}
          </span>
        )}
        {chat.model && (
          <button
            type="button"
            className="sb-item clickable"
            title="Active AI model — click to open chat"
            aria-label={`AI model ${chat.model}, open chat`}
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
          </button>
        )}
        {settings.autoSave !== 'off' && (
          <span
            className="sb-item"
            title={
              settings.autoSave === 'afterDelay'
                ? `Auto Save: saves ${settings.autoSaveDelay / 1000}s after you stop typing`
                : 'Auto Save: saves when the editor loses focus'
            }
          >
            <span className="sb-dot" style={{ background: 'var(--green)' }} />
            Auto Save
          </span>
        )}
        {sel && (
          <span className="sb-item">
            Ln {sel.line}, Col {sel.column}
            {sel.selected > 0 ? ` (${sel.selected} selected)` : ''}
          </span>
        )}
        {sel && sel.tabSize !== undefined && (
          <span className="sb-item" title="Indentation of the active file">
            {sel.insertSpaces ? `Spaces: ${sel.tabSize}` : `Tab Size: ${sel.tabSize}`}
          </span>
        )}
        {sel && sel.eol && <span className="sb-item" title="Line endings">{sel.eol}</span>}
        {sel && sel.language && (
          <span className="sb-item" title="Language mode of the active file">
            {languageLabel(sel.language)}
          </span>
        )}
        <span className="sb-item">UTF-8</span>
      </div>
    </div>
  )
}
