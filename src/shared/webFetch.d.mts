// Type declarations for src/shared/webFetch.mjs.
import type { WebPage } from './types'

export const DEFAULT_TIMEOUT_MS: number
export const MAX_BYTES: number
export const MAX_CHARS: number
export function htmlToText(html: string): { title: string; text: string }
export function fetchPageText(url: string, opts?: { timeoutMs?: number }): Promise<WebPage>
