// Type declarations for src/shared/projectMemory.mjs (the shared JS core).
import type { ProjectIndexSnapshot, ProjectFileContent } from './types'

export const SKIP_DIRS: Set<string>
export const MAX_FILES: number
export const MAX_TEXT_BYTES: number
export const MEMORY_BUDGET_BYTES: number
export const MAX_RECALL_CHARS: number

export function languageForPath(path: string): string
export function isTextLike(path: string): boolean
export function looksBinary(buf: Uint8Array): boolean
export function extractFileMeta(
  path: string,
  content: string,
): { language: string; symbols: string[]; imports: string[] }
export function derivePurpose(description: unknown, readme?: string): string | undefined

export interface ProjectIndexService {
  /** Metadata, directory digests, code profile and memory stats (scans on first use). */
  snapshot(root: string): Promise<ProjectIndexSnapshot>
  /** Full rescan from the top of the tree. */
  rescan(root: string): Promise<ProjectIndexSnapshot>
  /** Persist AI-written one-line summaries for indexed files. */
  setSummaries(
    root: string,
    items: { rel: string; summary: string; summaryAt: number }[],
  ): Promise<void>
  /** Retrieve any file: from project memory when current, otherwise from disk. */
  file(root: string, rel: string): Promise<ProjectFileContent>
}

export function createProjectIndex(opts: { cacheDir: string }): ProjectIndexService
