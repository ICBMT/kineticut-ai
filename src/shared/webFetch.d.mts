// Type declarations for src/shared/webFetch.mjs.
import type { WebPage, WebSearchResult } from './types'

export const DEFAULT_TIMEOUT_MS: number
export const MAX_BYTES: number
export const MAX_CHARS: number
export function htmlToText(html: string): { title: string; text: string }
export function fetchPageText(url: string, opts?: { timeoutMs?: number }): Promise<WebPage>
export const BRAVE_SEARCH_URL: string
export function searchWeb(
  query: string,
  apiKey: string | null,
  opts?: { count?: number; timeoutMs?: number; baseUrl?: string },
): Promise<WebSearchResult[]>
