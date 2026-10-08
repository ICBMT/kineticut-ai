import { useMemo, useState } from 'react'
import { useAppStore } from '../store/app'
import { EDITOR_BUILTIN_SHORTCUTS, shortcutRows, type ShortcutRow } from '../lib/shortcuts'
import { Kbd, Modal } from './ui'

/** Searchable reference of every bound shortcut, grouped by category. */
export function ShortcutsModal() {
  const open = useAppStore((s) => s.shortcutsOpen)
  const setOpen = useAppStore((s) => s.setShortcutsOpen)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all: ShortcutRow[] = [...shortcutRows(), ...EDITOR_BUILTIN_SHORTCUTS]
    const match = (r: ShortcutRow) =>
      !q || r.label.toLowerCase().includes(q) || r.combo.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
    const byCategory = new Map<string, ShortcutRow[]>()
    for (const r of all.filter(match)) {
      const list = byCategory.get(r.category) ?? []
      list.push(r)
      byCategory.set(r.category, list)
    }
    return [...byCategory.entries()]
  }, [query])

  if (!open) return null
  const close = () => {
    setOpen(false)
    setQuery('')
  }

  return (
    <Modal
      open
      onClose={close}
      wide
      title={
        <span className="flex items-center gap-2">
          <span>Keyboard Shortcuts</span>
          <span className="font-mono text-[11px] text-[var(--text-faint)]">Ctrl+Alt+/</span>
        </span>
      }
      footer={
        <button className="btn btn-primary" onClick={close}>
          Done
        </button>
      }
    >
      <input
        className="field-input mb-3"
        placeholder="Filter shortcuts…"
        aria-label="Filter shortcuts"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="max-h-[60vh] overflow-auto pr-1 flex flex-col gap-4">
        {groups.length === 0 && (
          <div className="text-sm text-[var(--text-faint)] italic">No shortcuts match “{query}”.</div>
        )}
        {groups.map(([category, rows]) => (
          <section key={category}>
            <div className="field-label mb-1.5">{category}</div>
            <ul className="flex flex-col gap-1">
              {rows.map((r) => (
                <li
                  key={r.combo + r.label}
                  className="flex items-center justify-between gap-4 text-sm py-0.5"
                >
                  <span className="text-[var(--text-dim)]">{r.label}</span>
                  <span className="shrink-0">
                    <Kbd>{r.combo}</Kbd>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}
