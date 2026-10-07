import { useEffect, useMemo, useState } from 'react'
import { FileCode, History } from 'lucide-react'
import { COMMANDS, type Command } from '../commands'
import { fuzzyFilter } from '../lib/fuzzy'
import { cn, relativePath } from '../lib/utils'
import type { FileTree } from '../../shared/types'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { Kbd } from './ui'

interface FlatFile {
  path: string
  rel: string
}

function flatten(tree: FileTree | null, root: string, out: FlatFile[] = [], depth = 0): FlatFile[] {
  if (!tree || depth > 12) return out
  for (const child of tree.children || []) {
    const rel = root ? child.path.slice(root.length).replace(/^[/\\]+/, '') : child.path
    if (child.type === 'file') out.push({ path: child.path, rel })
    else flatten(child, root, out, depth + 1)
  }
  return out
}

export function QuickOpen() {
  const open = useAppStore((s) => s.quickOpenOpen)
  const setOpen = useAppStore((s) => s.setQuickOpenOpen)
  const fileIndex = useAppStore((s) => s.fileIndex)
  const recentFiles = useAppStore((s) => s.recentFiles)
  const folder = useAppStore((s) => s.folder)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const files = useMemo(() => flatten(fileIndex, folder || ''), [fileIndex, folder])

  const isCommandMode = query.startsWith('>')
  const q = (isCommandMode ? query.slice(1) : query).trim()

  const fileList = useMemo(() => {
    if (isCommandMode) return []
    if (!q) {
      const recents: FlatFile[] = recentFiles.map((p) => ({
        path: p,
        rel: folder ? relativePath(folder, p) : p,
      }))
      return [...recents, ...files.filter((f) => !recentFiles.includes(f.path))].slice(0, 40)
    }
    return fuzzyFilter(q, files, (f) => f.rel).slice(0, 40)
  }, [isCommandMode, q, files, recentFiles, folder])

  const commandList = useMemo(
    () => (isCommandMode ? fuzzyFilter(q, COMMANDS, (c) => c.title).slice(0, 40) : []),
    [isCommandMode, q],
  )

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
    }
  }, [open])

  if (!open) return null

  const openFile = (path: string) => {
    setOpen(false)
    useEditorStore.getState().openTab(path)
  }

  const runCommand = (cmd: Command) => {
    setOpen(false)
    void cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const total = isCommandMode ? commandList.length : fileList.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, total - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isCommandMode) {
        const cmd = commandList[activeIdx]
        if (cmd) runCommand(cmd)
      } else {
        const f = fileList[activeIdx]
        if (f) openFile(f.path)
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <>
      <div className="overlay" onClick={() => setOpen(false)} />
      <div className="palette">
        <input
          className="palette-input"
          autoFocus
          placeholder={isCommandMode ? 'Run command…' : 'Go to file… (type > for commands)'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIdx(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {!isCommandMode && !q && recentFiles.length > 0 && (
            <div className="menu-header flex items-center gap-1.5">
              <History size={11} /> Recent
            </div>
          )}
          {!isCommandMode &&
            fileList.map((f, i) => (
              <button
                key={f.path}
                className={cn('palette-item', i === activeIdx && 'selected')}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => openFile(f.path)}
              >
                <FileCode size={14} className="shrink-0" />
                <span className="truncate">{f.rel}</span>
              </button>
            ))}
          {isCommandMode &&
            commandList.map((cmd, i) => (
              <button
                key={cmd.id}
                className={cn('palette-item', i === activeIdx && 'selected')}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => runCommand(cmd)}
              >
                <cmd.icon size={14} className="shrink-0" />
                <span className="truncate">{cmd.title}</span>
                <span className="pi-cat">{cmd.category}</span>
              </button>
            ))}
          {!isCommandMode && fileList.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-faint)]">
              {q ? 'No files found.' : 'No files in the workspace yet.'}
            </div>
          )}
          {isCommandMode && commandList.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-faint)]">
              No commands found.
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </>
  )
}
