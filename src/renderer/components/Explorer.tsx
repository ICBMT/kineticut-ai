import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
} from 'lucide-react'
import { api } from '../api'
import type { FileEntry, FsEvent } from '../../shared/types'
import { cn, extOf, joinPath, relativePath } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { ContextMenu, EmptyState, IconButton, type MenuItem } from './ui'

function fileIcon(name: string) {
  const ext = extOf(name)
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) return FileImage
  if (['.json', '.jsonc', '.json5'].includes(ext)) return FileJson
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.vue', '.svelte'].includes(ext))
    return FileCode
  if (['.md', '.markdown', '.txt', '.log'].includes(ext)) return FileText
  return File
}

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  folder: string
  expanded: Set<string>
  toggle: (path: string) => void
  childrenOf: (path: string) => FileEntry[] | undefined
  selected: string | null
  onSelect: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
}

function TreeNode(props: TreeNodeProps) {
  const { entry, depth, expanded, toggle, childrenOf, selected, onSelect, onContextMenu } = props
  const isDir = entry.type === 'directory'
  const open = expanded.has(entry.path)
  const children = isDir ? childrenOf(entry.path) : undefined

  return (
    <div>
      <div
        className={cn('tree-row', selected === entry.path && 'selected')}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => {
          if (isDir) toggle(entry.path)
          else onSelect(entry.path)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onSelect(entry.path)
          onContextMenu(e, entry)
        }}
      >
        <span className="chevron">
          {isDir ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </span>
        {isDir ? (
          open ? (
            <FolderOpen size={14} className="shrink-0 text-[var(--accent)]" />
          ) : (
            <Folder size={14} className="shrink-0 text-[var(--accent)]" />
          )
        ) : (
          React.createElement(fileIcon(entry.name), {
            size: 14,
            className: 'shrink-0 text-[var(--text-faint)]',
          })
        )}
        <span className="fname">{entry.name}</span>
      </div>
      {isDir && open && children && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.path} {...props} entry={child} depth={depth + 1} />
          ))}
          {children.length === 0 && (
            <div className="tree-row" style={{ paddingLeft: (depth + 1) * 12 + 21 }}>
              <span className="text-[var(--text-faint)] text-xs italic">empty</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import React from 'react'

function InlineInput({
  onCommit,
  onCancel,
}: {
  onCommit(name: string): void
  onCancel(): void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      placeholder="name…"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(value)}
    />
  )
}

export function Explorer() {
  const folder = useAppStore((s) => s.folder)
  const recentFolders = useAppStore((s) => s.recentFolders)
  const activePath = useEditorStore((s) => s.activeTab()?.path ?? null)
  const openTab = useEditorStore((s) => s.openTab)

  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [inlineParent, setInlineParent] = useState<{ parent: string; kind: 'file' | 'folder' } | null>(null)

  const loadChildren = useCallback(async (path: string) => {
    try {
      const entries = await api.fs.list(path)
      setChildren((prev) => ({ ...prev, [path]: entries }))
    } catch {
      setChildren((prev) => ({ ...prev, [path]: [] }))
    }
  }, [])

  // Initial load + watch for external changes.
  useEffect(() => {
    if (!folder) return
    setChildren({})
    setExpanded(new Set([folder]))
    void loadChildren(folder)
    let unwatch: (() => void) | null = null
    let disposed = false
    void api.fs.watch(folder, (events: FsEvent[]) => {
      if (disposed) return
      const affected = new Set<string>()
      for (const ev of events) {
        affected.add(ev.path)
        // Invalidate the parent directory listing.
        const parts = ev.path.split(/[/\\]/)
        parts.pop()
        if (parts.length > 0) affected.add(parts.join('/'))
      }
      affected.add(folder)
      for (const p of affected) {
        if (p.startsWith(folder)) void loadChildren(p)
      }
    }).then((u) => {
      unwatch = u
    })
    return () => {
      disposed = true
      unwatch?.()
    }
  }, [folder, loadChildren])

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else {
          next.add(path)
          void loadChildren(path)
        }
        return next
      })
    },
    [loadChildren],
  )

  const childrenOf = useCallback((path: string) => children[path], [children])

  const refresh = useCallback(() => {
    if (!folder) return
    const dirs = [folder, ...expanded]
    for (const d of dirs) void loadChildren(d)
  }, [folder, expanded, loadChildren])

  const commitInline = useCallback(
    async (parent: string, kind: 'file' | 'folder', name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const target = joinPath(parent, trimmed)
      try {
        if (kind === 'file') {
          await api.fs.write(target, '')
          openTab(target)
        } else {
          await api.fs.mkdir(target)
          setExpanded((prev) => new Set(prev).add(parent))
        }
        await loadChildren(parent)
      } catch (err) {
        useAppStore.getState().toast({
          kind: 'error',
          title: `Could not create ${kind}`,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [loadChildren, openTab],
  )

  const doRename = useCallback(
    async (entry: FileEntry, newName: string) => {
      const trimmed = newName.trim()
      if (!trimmed || trimmed === entry.name) return
      const parent = entry.path.split(/[/\\]/).slice(0, -1).join('/')
      const target = joinPath(parent, trimmed)
      try {
        await api.fs.rename(entry.path, target)
        // Keep open tabs in sync.
        const { allTabs, renameTab } = useEditorStore.getState()
        for (const tab of allTabs()) {
          if (tab.path === entry.path) renameTab(entry.path, target)
          else if (tab.path.startsWith(entry.path + '/')) {
            renameTab(tab.path, target + tab.path.slice(entry.path.length))
          }
        }
        if (entry.type === 'directory') {
          setExpanded((prev) => {
            const next = new Set<string>()
            for (const p of prev) next.add(p === entry.path ? target : p.startsWith(entry.path + '/') ? target + p.slice(entry.path.length) : p)
            return next
          })
        }
        void loadChildren(parent)
        void useAppStore.getState().refreshGit()
      } catch (err) {
        useAppStore.getState().toast({
          kind: 'error',
          title: 'Rename failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [loadChildren],
  )

  const doDelete = useCallback(
    async (entry: FileEntry) => {
      const ok = await new Promise<boolean>((resolve) => {
        useAppStore.getState().requestConfirm({
          title: `Delete ${entry.type === 'directory' ? 'folder' : 'file'}`,
          message: entry.path,
          detail: 'This action cannot be undone.',
          confirmLabel: 'Delete',
          danger: true,
          resolve,
        })
      })
      if (!ok) return
      try {
        await api.fs.remove(entry.path)
        const { allTabs, closeTab } = useEditorStore.getState()
        for (const tab of [...allTabs()]) {
          if (tab.path === entry.path || tab.path.startsWith(entry.path + '/')) closeTab(tab.path)
        }
        const parent = entry.path.split(/[/\\]/).slice(0, -1).join('/')
        void loadChildren(parent)
        void useAppStore.getState().refreshGit()
        useAppStore.getState().toast({ kind: 'success', title: 'Deleted', message: entry.name, duration: 1800 })
      } catch (err) {
        useAppStore.getState().toast({
          kind: 'error',
          title: 'Delete failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [loadChildren],
  )

  const openToSide = useCallback((path: string) => {
    const store = useEditorStore.getState()
    let targetId = store.groups.find((g) => g.id !== store.activeGroupId)?.id
    if (!targetId) targetId = store.splitGroup()
    if (targetId) store.openTab(path, targetId)
  }, [])

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const entry = menu.entry
    const isDir = entry.type === 'directory'
    return [
      ...(isDir
        ? []
        : [
            {
              label: 'Open to the Side',
              onClick: () => openToSide(entry.path),
            } as MenuItem,
            { type: 'separator' as const },
          ]),
      {
        icon: FilePlus2,
        label: 'New File…',
        onClick: () => {
          if (isDir) setExpanded((prev) => new Set(prev).add(entry.path))
          setInlineParent({ parent: entry.path, kind: 'file' })
        },
      },
      {
        icon: FolderPlus,
        label: 'New Folder…',
        onClick: () => {
          if (isDir) setExpanded((prev) => new Set(prev).add(entry.path))
          setInlineParent({ parent: entry.path, kind: 'folder' })
        },
      },
      { type: 'separator' },
      {
        label: 'Rename…',
        onClick: () => {
          const newName = window.prompt('Rename to:', entry.name)
          if (newName) void doRename(entry, newName)
        },
      },
      {
        label: 'Delete…',
        danger: true,
        onClick: () => void doDelete(entry),
      },
      { type: 'separator' },
      {
        label: 'Copy Path',
        onClick: () => void navigator.clipboard.writeText(entry.path),
      },
      {
        label: 'Copy Relative Path',
        onClick: () =>
          void navigator.clipboard.writeText(folder ? relativePath(folder, entry.path) : entry.path),
      },
    ]
  }, [menu, doRename, doDelete, folder])

  if (!folder) {
    return (
      <div className="sidebar-inner">
        <div className="panel-header">
          <span>Explorer</span>
        </div>
        <div className="sidebar-scroll">
          <EmptyState
            icon={FolderOpen}
            title="No folder opened"
            text="Open a workspace to browse and edit files."
            action={{
              label: 'Open Folder',
              onClick: () => {
                void api.system.openFolder().then((p) => {
                  if (p) useAppStore.getState().setFolder(p)
                })
              },
            }}
          />
          {recentFolders.length > 0 && (
            <div className="px-3 pb-3">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-2">
                Recent
              </div>
              {recentFolders.map((p) => (
                <button
                  key={p}
                  className="tree-row w-full text-left"
                  style={{ paddingLeft: 8 }}
                  title={p}
                  onClick={() => useAppStore.getState().setFolder(p)}
                >
                  <Folder size={14} className="shrink-0 text-[var(--accent)]" />
                  <span className="fname">{p}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const rootChildren = children[folder]

  return (
    <div className="sidebar-inner">
      <div className="panel-header">
        <span className="truncate">{folder.split(/[/\\]/).pop() || folder}</span>
        <div className="panel-header-actions">
          <IconButton
            icon={FilePlus2}
            size={14}
            tooltip="New File"
            onClick={() => setInlineParent({ parent: folder, kind: 'file' })}
          />
          <IconButton
            icon={FolderPlus}
            size={14}
            tooltip="New Folder"
            onClick={() => setInlineParent({ parent: folder, kind: 'folder' })}
          />
          <IconButton icon={RefreshCw} size={14} tooltip="Refresh" onClick={refresh} />
        </div>
      </div>
      <div className="sidebar-scroll">
        {inlineParent && (
          <div className="tree-row" style={{ paddingLeft: 8 }}>
            {inlineParent.kind === 'file' ? (
              <File size={14} className="shrink-0 text-[var(--text-faint)]" />
            ) : (
              <Folder size={14} className="shrink-0 text-[var(--accent)]" />
            )}
            <InlineInput
              onCommit={(name) => {
                void commitInline(inlineParent.parent, inlineParent.kind, name)
                setInlineParent(null)
              }}
              onCancel={() => setInlineParent(null)}
            />
          </div>
        )}
        {rootChildren === undefined ? (
          <div className="p-3 text-xs text-[var(--text-faint)]">Loading…</div>
        ) : rootChildren.length === 0 ? (
          <div className="p-3 text-xs text-[var(--text-faint)] italic">Folder is empty</div>
        ) : (
          rootChildren.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              folder={folder}
              expanded={expanded}
              toggle={toggle}
              childrenOf={childrenOf}
              selected={activePath}
              onSelect={openTab}
              onContextMenu={(e, entry) => setMenu({ x: e.clientX, y: e.clientY, entry })}
            />
          ))
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
