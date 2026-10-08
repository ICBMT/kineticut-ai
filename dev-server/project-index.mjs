/**
 * Project memory for the browser-preview dev server. The understanding itself
 * lives in src/shared/projectMemory.mjs (shared with the Electron main process);
 * this module only chooses the cache location.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProjectIndex } from '../src/shared/projectMemory.mjs'

const service = createProjectIndex({ cacheDir: join(homedir(), '.kineticut-project-memory') })

export const projectIndexSnapshot = (root) => service.snapshot(root)
export const rescanProjectIndex = (root) => service.rescan(root)
export const setFileSummaries = (root, items) => service.setSummaries(root, items)
export const projectFile = (root, rel) => service.file(root, rel)
