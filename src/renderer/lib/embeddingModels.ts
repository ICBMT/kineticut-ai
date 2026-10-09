/**
 * Embedding models are used for codebase search by meaning. They are not chat
 * models, so they are kept out of the chat model lists.
 */

/** Best first: the first one installed is used automatically. */
export const EMBEDDING_MODEL_PREFERENCE = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'snowflake-arctic-embed',
  'all-minilm',
  'bge-large',
]

/** The model `Install` pulls when none is installed. */
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'

export function isEmbeddingModel(name: string): boolean {
  return /embed|\bbge[-_]|minilm|\be5[-_]|\bgte[-_]/i.test(name)
}

/** The preferred embedding model among the installed names, or null. */
export function pickEmbeddingModel(installed: string[]): string | null {
  const embedders = installed.filter(isEmbeddingModel)
  for (const want of EMBEDDING_MODEL_PREFERENCE) {
    const hit = embedders.find((m) => m.toLowerCase().startsWith(want))
    if (hit) return hit
  }
  return embedders[0] ?? null
}
