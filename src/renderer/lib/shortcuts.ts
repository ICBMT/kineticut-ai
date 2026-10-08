import { COMMANDS, KEYBINDINGS } from '../commands'

export interface ShortcutRow {
  combo: string
  label: string
  category: string
  commandId: string
}

const KEY_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  space: 'Space',
  f1: 'F1',
  arrowup: 'Up',
  arrowdown: 'Down',
  escape: 'Esc',
  enter: 'Enter',
}

/** Turn an internal combo like `mod+alt+l` into a display label like `Ctrl+Alt+L`. */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((part) => KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join('+')
}

/** Every bound shortcut, derived from the same tables that run them. */
export function shortcutRows(): ShortcutRow[] {
  const rows: ShortcutRow[] = []
  for (const b of KEYBINDINGS) {
    const cmd = COMMANDS.find((c) => c.id === b.commandId)
    if (!cmd) continue
    rows.push({
      combo: formatCombo(b.combo),
      label: cmd.title,
      category: cmd.category,
      commandId: cmd.id,
    })
  }
  return rows
}

/** Shortcuts handled by the code editor itself (Monaco), listed for discoverability. */
export const EDITOR_BUILTIN_SHORTCUTS: ShortcutRow[] = [
  ['Ctrl+F', 'Find in file'],
  ['Ctrl+H', 'Replace in file'],
  ['Ctrl+/', 'Toggle line comment'],
  ['Alt+Up / Alt+Down', 'Move line up / down'],
  ['Ctrl+D', 'Select next occurrence'],
  ['Ctrl+Space', 'Trigger suggestions'],
  ['F12', 'Go to definition'],
  ['Tab', 'Accept AI completion'],
].map(([combo, label]) => ({ combo, label, category: 'Editor', commandId: '' }))

/** Pick specific bound commands by id, in the given order (for compact hints). */
export function hintFor(commandIds: string[]): ShortcutRow[] {
  const all = shortcutRows()
  return commandIds.map((id) => all.find((r) => r.commandId === id)).filter((r): r is ShortcutRow => !!r)
}
