/** Accent color themes. The hex values are mirrored in styles.css. */

export type AccentId = 'ocean' | 'forest' | 'sunset' | 'rose' | 'mono'

export const ACCENT_IDS: AccentId[] = ['ocean', 'forest', 'sunset', 'rose', 'mono']

export const ACCENTS: Record<AccentId, { label: string; accent: string; accent2: string }> = {
  ocean: { label: 'Ocean', accent: '#7aa2f7', accent2: '#bb9af7' },
  forest: { label: 'Forest', accent: '#7fd88f', accent2: '#4fd6be' },
  sunset: { label: 'Sunset', accent: '#ff9e64', accent2: '#f7768e' },
  rose: { label: 'Rose', accent: '#f7768e', accent2: '#bb9af7' },
  mono: { label: 'Mono', accent: '#c0caf5', accent2: '#7aa2f7' },
}

export const EDITOR_FONTS = [
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'fira', label: 'Fira Code' },
  { id: 'cascadia', label: 'Cascadia Code' },
  { id: 'system', label: 'System monospace' },
] as const

export type EditorFontId = (typeof EDITOR_FONTS)[number]['id']

export const EDITOR_FONT_STACKS: Record<EditorFontId, string> = {
  jetbrains: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  fira: "'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
  cascadia: "'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace",
  system: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}
