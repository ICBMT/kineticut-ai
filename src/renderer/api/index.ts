import type { KineticAPI } from '../../shared/types'
import { createHttpApi } from './http'

/** The Electron preload bridge, present only inside the desktop app. */
export const bridge: KineticAPI | null =
  typeof window !== 'undefined' ? (window.kinetic ?? null) : null

/** Unified API: Electron IPC in the desktop app, HTTP/WS in the browser preview. */
export const api: KineticAPI = bridge ?? createHttpApi()

export const isElectron = bridge !== null
