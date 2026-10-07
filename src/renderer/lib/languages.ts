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
