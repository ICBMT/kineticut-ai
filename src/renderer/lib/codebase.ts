/**
 * The codebase index as the chat and agent use it. Keyword search always works
 * (no model needed). When an embedding model is configured, chunks are embedded
 * once in the background and queries are ranked by meaning as well (hybrid).
 * Nothing here reads whole files into the prompt: the agent searches, then reads
 * the exact lines it needs.
 */
import { create } from 'zustand'
import { api } from '../api'
import { aiFetch } from './aiFetch'
import { languageForPath } from './languages'
import { useSettingsStore } from '../store/settings'
import type { CodeChunk, CodebaseStats } from '../../shared/types'

export type CodebasePhase = 'idle' | 'indexing' | 'ready' | 'error'

interface CodebaseStatusState {
  phase: CodebasePhase
  folder: string | null
  stats: CodebaseStats | null
  /** Chunks with an embedding, out of the total, when an embedding model is configured. */
  embedded: number
  total: number
  embeddingModel: string | null
  error: string | null
}

export const useCodebaseStatus = create<CodebaseStatusState>(() => ({
  phase: 'idle',
  folder: null,
  stats: null,
  embedded: 0,
  total: 0,
  embeddingModel: null,
  error: null,
}))

const building = new Map<string, Promise<CodebaseStats | null>>()
const embedding = new Set<string>()

/** Embedding model for the workspace index: the configured one, on the Ollama provider. */
export function embeddingConfig(): { baseUrl: string; model: string } | null {
  const settings = useSettingsStore.getState()
  const model = settings.embeddingModel?.trim()
  if (!model) return null
  const ollama = settings.providers.find((p) => p.type === 'ollama')
  if (!ollama) return null
  return { baseUrl: ollama.baseUrl.replace(/\/+$/, ''), model }
}

/** Embed texts through Ollama's /api/embed. Null when the model is unavailable. */
export async function embedTexts(texts: string[], cfg = embeddingConfig()): Promise<number[][] | null> {
  if (!cfg || texts.length === 0) return null
  try {
    const res = await aiFetch({
      url: `${cfg.baseUrl}/api/embed`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    })
    if (res.status >= 400) return null
    const data = JSON.parse(res.body) as { embeddings?: number[][] }
    return Array.isArray(data.embeddings) && data.embeddings.length === texts.length ? data.embeddings : null
  } catch {
    return null
  }
}

/** Bring the index up to date for a folder. Concurrent calls share one run. */
export function buildCodebase(folder: string): Promise<CodebaseStats | null> {
  const running = building.get(folder)
  if (running) return running
  useCodebaseStatus.setState({ phase: 'indexing', folder, error: null })
  const run = (async () => {
    try {
      const stats = await api.codebase.build(folder)
      useCodebaseStatus.setState({ phase: 'ready', stats })
      const cfg = embeddingConfig()
      if (cfg) void embedInBackground(folder, cfg)
      return stats
    } catch (err) {
      useCodebaseStatus.setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
      return null
    } finally {
      building.delete(folder)
    }
  })()
  building.set(folder, run)
  return run
}

/** Embed chunks that lack a vector for the configured model, a batch at a time. */
async function embedInBackground(folder: string, cfg: { baseUrl: string; model: string }): Promise<void> {
  const key = `${folder}\u0000${cfg.model}`
  if (embedding.has(key)) return
  embedding.add(key)
  useCodebaseStatus.setState({ embeddingModel: cfg.model })
  try {
    for (;;) {
      const batch = await api.codebase.pending(folder, { model: cfg.model, limit: 48 })
      useCodebaseStatus.setState({ embedded: batch.embedded, total: batch.total })
      if (batch.items.length === 0) break
      const vectors = await embedTexts(
        batch.items.map((i) => i.text),
        cfg,
      )
      if (!vectors) {
        useCodebaseStatus.setState({ error: `Embedding model "${cfg.model}" is not available.` })
        break
      }
      await api.codebase.setVectors(folder, {
        model: cfg.model,
        items: batch.items.map((item, i) => ({ id: item.id, hash: item.hash, vector: vectors[i] })),
      })
    }
  } catch {
    /* embeddings are an upgrade; keyword search keeps working */
  } finally {
    embedding.delete(key)
  }
}

/** Ranked chunks for a query. Hybrid when an embedding model is configured. */
export async function searchCodebase(
  folder: string,
  query: string,
  k = 8,
): Promise<{ hits: CodeChunk[]; semantic: boolean }> {
  const cfg = embeddingConfig()
  const queryVector = cfg ? ((await embedTexts([query], cfg)) ?? [null])[0] : null
  const res = await api.codebase.search(folder, query, {
    k,
    model: cfg && queryVector ? cfg.model : null,
    queryVector,
  })
  if (cfg && !queryVector) useCodebaseStatus.setState({ error: `Embedding model "${cfg.model}" is not available.` })
  return { hits: res.hits, semantic: res.semantic }
}

/** Snippets as Markdown, capped in size, with their file and line ranges. */
export function formatHits(hits: CodeChunk[], maxChars = 9000): string {
  const parts: string[] = []
  let total = 0
  for (const h of hits) {
    const block = `### ${h.rel}:${h.startLine}-${h.endLine}\n\`\`\`${languageForPath(h.rel)}\n${h.text}\n\`\`\``
    if (total + block.length > maxChars) break
    parts.push(block)
    total += block.length
  }
  return parts.join('\n\n')
}

/** The question without its @mentions, so search matches the words the user meant. */
export function stripMentions(text: string): string {
  return text.replace(/(^|\s)@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim()
}
