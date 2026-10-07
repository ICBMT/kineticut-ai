import { useEffect, useMemo, useState } from 'react'
import { COMMANDS, type Command } from '../commands'
import { fuzzyFilter } from '../lib/fuzzy'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/app'
import { Kbd } from './ui'

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen)
  const setOpen = useAppStore((s) => s.setPaletteOpen)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const list = useMemo(
    () =>
      fuzzyFilter(query, COMMANDS, (c) => `${c.title} ${c.category} ${c.keywords || ''}`),
    [query],
  )

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
    }
  }, [open])

  if (!open) return null

  const run = (command: Command) => {
    setOpen(false)
    void command.run()
  }

  return (
    <>
      <div className="overlay" onClick={() => setOpen(false)} />
      <div className="palette">
        <input
          className="palette-input"
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIdx((i) => Math.min(i + 1, Math.max(0, list.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const cmd = list[activeIdx]
              if (cmd) run(cmd)
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        <div className="palette-list">
          {list.slice(0, 16).map((cmd, i) => (
            <button
              key={cmd.id}
              className={cn('palette-item', i === activeIdx && 'selected')}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => run(cmd)}
            >
              <cmd.icon size={15} className="shrink-0" />
              <span className="truncate">{cmd.title}</span>
              <span className="pi-cat">{cmd.category}</span>
            </button>
          ))}
          {list.length === 0 && (
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
            <Kbd>↵</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </>
  )
}
