/**
 * Read one web page as plain text, for the agent and @-mentions. Shared by the
 * Electron main process and the dev server, so both behave the same.
 *
 * Only http(s) URLs are fetched. The response is capped in bytes and in
 * characters, HTML is reduced to its visible text, and non-text responses
 * (images, archives, binaries) are refused.
 */

export const DEFAULT_TIMEOUT_MS = 15000
export const MAX_BYTES = 2_000_000
export const MAX_CHARS = 12000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

/** HTML to readable text: scripts, styles and tags removed, blocks kept on their own lines. */
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|li|ul|ol|h[1-6]|tr|br|pre|blockquote|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim()
  return { title: title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '', text }
}

/**
 * Fetch `url` and return its text. Throws an Error with a readable message when
 * the URL is not http(s), the request fails, or the content is not text.
 */
export async function fetchPageText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error(`Not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https pages can be read (got ${parsed.protocol})`)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(parsed.href, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5', 'user-agent': 'KineticutAI/0.1' },
    })
  } catch (err) {
    throw new Error(ctl.signal.aborted ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : `Request failed: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())
  const type = (res.headers.get('content-type') || 'text/plain').toLowerCase()
  if (!/^(text\/|application\/(json|xml|xhtml\+xml|javascript))/.test(type)) {
    throw new Error(`Not a text page (${type})`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const truncatedBytes = buf.length > MAX_BYTES
  const raw = buf.subarray(0, MAX_BYTES).toString('utf8')
  const isHtml = type.includes('html')
  const { title, text: visible } = isHtml ? htmlToText(raw) : { title: '', text: raw.trim() }
  const truncatedChars = visible.length > MAX_CHARS
  return {
    url: res.url || parsed.href,
    status: res.status,
    contentType: type,
    title,
    text: truncatedChars ? visible.slice(0, MAX_CHARS) : visible,
    truncated: truncatedBytes || truncatedChars,
  }
}

export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'

/**
 * Web search through the Brave Search API (the user's own key). Returns the top
 * results as { title, url, description }. `baseUrl` exists so tests can point at a stub.
 */
export async function searchWeb(query, apiKey, opts = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('The search query is empty.')
  if (!apiKey) throw new Error('No web search key is set. Add a Brave Search API key in Settings.')
  const count = Math.min(Math.max(opts.count ?? 5, 1), 10)
  const url = new URL(opts.baseUrl ?? BRAVE_SEARCH_URL)
  url.searchParams.set('q', q)
  url.searchParams.set('count', String(count))
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url.href, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'x-subscription-token': apiKey },
    })
  } catch (err) {
    throw new Error(ctl.signal.aborted ? 'The search timed out.' : `Search request failed: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401 || res.status === 403) throw new Error('The search key was refused. Check it in Settings.')
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`)
  const data = await res.json()
  const results = Array.isArray(data?.web?.results) ? data.web.results : []
  return results.slice(0, count).map((r) => ({
    title: String(r.title ?? '').replace(/<[^>]+>/g, ''),
    url: String(r.url ?? ''),
    description: String(r.description ?? '').replace(/<[^>]+>/g, ''),
  }))
}
