/**
 * Project memory for the browser-preview dev server. The understanding itself
 * lives in src/shared/projectMemory.mjs (shared with the Electron main process);
 * this module only chooses the cache location.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProjectIndex } from '../src/shared/projectMemory.mjs'
import { createCodebaseIndex } from '../src/shared/codebaseIndex.mjs'

const cacheDir = join(homedir(), '.kineticut-project-memory')
const service = createProjectIndex({ cacheDir })
const codebase = createCodebaseIndex({ cacheDir, projectIndex: service })

export const projectIndexSnapshot = (root) => service.snapshot(root)
export const rescanProjectIndex = (root) => service.rescan(root)
export const setFileSummaries = (root, items) => service.setSummaries(root, items)
export const projectFile = (root, rel) => service.file(root, rel)

export const codebaseBuild = (root, opts) => codebase.build(root, opts)
export const codebaseSearch = (root, query, opts) => codebase.search(root, query, opts)
export const codebasePending = (root, opts) => codebase.pending(root, opts)
export const codebaseSetVectors = (root, opts) => codebase.setVectors(root, opts)
