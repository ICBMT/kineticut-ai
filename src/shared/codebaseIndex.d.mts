// Type declarations for src/shared/codebaseIndex.mjs (the shared JS core).
import type { ProjectIndexService } from './projectMemory.mjs'

export interface CodeChunk {
  id: string
  rel: string
  startLine: number
  endLine: number
  text: string
  score?: number
}

export interface CodebaseStats {
  files: number
  chunks: number
  changed: number
  removed: number
}

export const CHUNK_LINES: number
export const CHUNK_MAX_CHARS: number
export function tokenize(text: string): string[]
export function chunkText(text: string): { startLine: number; endLine: number; text: string }[]
export function hashText(text: string): string

export interface CodebaseIndexService {
  build(root: string, opts?: { force?: boolean }): Promise<CodebaseStats>
  search(
    root: string,
    query: string,
    opts?: { k?: number; queryVector?: number[] | null; model?: string | null },
  ): Promise<{ hits: CodeChunk[]; semantic: boolean; stats: CodebaseStats | null }>
  pending(
    root: string,
    opts: { model: string; limit?: number },
  ): Promise<{ items: { id: string; hash: string; text: string }[]; total: number; embedded: number }>
  setVectors(
    root: string,
    opts: { model: string; items: { id: string; hash: string; vector: number[] }[] },
  ): Promise<{ stored: number; total: number }>
}

export function createCodebaseIndex(args: {
  cacheDir: string
  projectIndex: Pick<ProjectIndexService, 'snapshot' | 'file'>
}): CodebaseIndexService
