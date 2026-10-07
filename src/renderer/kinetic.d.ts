import type { KineticAPI } from '../shared/types'

declare global {
  interface Window {
    /** Present only inside the Electron renderer (exposed by the preload bridge). */
    kinetic?: KineticAPI
  }
}

export {}
