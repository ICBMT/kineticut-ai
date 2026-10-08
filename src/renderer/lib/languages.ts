import * as monaco from 'monaco-editor'
import { extOf } from './utils'

let extensionMap: Map<string, string> | null = null

function buildMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const lang of monaco.languages.getLanguages()) {
    for (const ext of lang.extensions || []) {
      if (!map.has(ext)) map.set(ext, lang.id)
    }
  }
  return map
}

/** Map a file path to a Monaco language id using Monaco's registered languages. */
export function languageForPath(path: string): string {
  if (!extensionMap) extensionMap = buildMap()
  return extensionMap.get(extOf(path)) || 'plaintext'
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript React',
  javascript: 'JavaScript',
  javascriptreact: 'JavaScript React',
  json: 'JSON',
  jsonc: 'JSON with Comments',
  markdown: 'Markdown',
  plaintext: 'Plain Text',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  yaml: 'YAML',
  shell: 'Shell Script',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C++',
  csharp: 'C#',
  java: 'Java',
  sql: 'SQL',
  xml: 'XML',
  dockerfile: 'Dockerfile',
}

/** Human label for a Monaco language id ("typescript" → "TypeScript"). */
export function languageLabel(id: string): string {
  return LANGUAGE_LABELS[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Plain Text')
}
