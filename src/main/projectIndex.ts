/**
 * Project memory for the Electron main process.
 *
 * The understanding itself lives in the shared core (src/shared/projectMemory.mjs),
 * which the browser-preview dev server also uses. This module only supplies the
 * Electron-specific cache location (userData): metadata is persisted there, and
 * file contents are held in a bounded in-memory cache.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { createProjectIndex, type ProjectIndexService } from '../shared/projectMemory.mjs'
import { createCodebaseIndex, type CodebaseIndexService } from '../shared/codebaseIndex.mjs'
import type { ProjectFileContent, ProjectIndexSnapshot } from '../shared/types'

let service: ProjectIndexService | null = null
let codebase: CodebaseIndexService | null = null

function index(): ProjectIndexService {
  if (!service) {
    service = createProjectIndex({ cacheDir: join(app.getPath('userData'), 'project-memory') })
  }
  return service
}

function codebaseIndex(): CodebaseIndexService {
  if (!codebase) {
    codebase = createCodebaseIndex({
      cacheDir: join(app.getPath('userData'), 'project-memory'),
      projectIndex: index(),
    })
  }
  return codebase
}

export const codebaseBuild = (root: string, opts?: { force?: boolean }) => codebaseIndex().build(root, opts)
export const codebaseSearch = (
  root: string,
  query: string,
  opts?: { k?: number; queryVector?: number[] | null; model?: string | null },
) => codebaseIndex().search(root, query, opts)
export const codebasePending = (root: string, opts: { model: string; limit?: number }) =>
  codebaseIndex().pending(root, opts)
export const codebaseSetVectors = (
  root: string,
  opts: { model: string; items: { id: string; hash: string; vector: number[] }[] },
) => codebaseIndex().setVectors(root, opts)

export function projectIndexSnapshot(root: string): Promise<ProjectIndexSnapshot> {
  return index().snapshot(root)
}

export function rescanProjectIndex(root: string): Promise<ProjectIndexSnapshot> {
  return index().rescan(root)
}

export function setFileSummaries(
  root: string,
  items: { rel: string; summary: string; summaryAt: number }[],
): Promise<void> {
  return index().setSummaries(root, items)
}

export function projectFile(root: string, rel: string): Promise<ProjectFileContent> {
  return index().file(root, rel)
}
