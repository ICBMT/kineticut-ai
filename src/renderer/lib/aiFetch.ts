/**
 * Network transport for AI provider calls.
 *
 * - Inside Electron, requests go through the main process (`bridge.net.*`),
 *   which has no CORS restrictions and can reach localhost (Ollama).
 * - In the browser preview, localhost targets are proxied through the dev
 *   server (so the sandbox's Ollama is reachable); external providers are
 *   called directly from the browser (CORS permitting) with a proxy fallback.
 */
import { bridge } from '../api'
import type { NetRequest, NetResponse } from '../../shared/types'

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

export async function aiFetch(req: NetRequest, signal?: AbortSignal): Promise<NetResponse> {
  if (bridge) return bridge.net.fetch(req)
  if (isLocalUrl(req.url)) return proxyFetch(req)
  try {
    return await directFetch(req, signal)
  } catch {
    return proxyFetch(req)
  }
}

async function directFetch(req: NetRequest, signal?: AbortSignal): Promise<NetResponse> {
  const res = await fetch(req.url, {
    method: req.method || 'GET',
    headers: req.headers,
    body: req.body,
    signal,
  })
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return { status: res.status, statusText: res.statusText, headers, body: await res.text() }
}

async function proxyFetch(req: NetRequest): Promise<NetResponse> {
  const res = await fetch('/api/net/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error(`proxy fetch failed: ${res.status}`)
  return (await res.json()) as NetResponse
}

/** Stream a response body as an async generator of decoded text chunks. */
export function aiFetchTextStream(req: NetRequest, signal?: AbortSignal): AsyncGenerator<string> {
  if (bridge) return bridgeTextStream(req)
  return webTextStream(req, signal)
}

async function* bridgeTextStream(req: NetRequest): AsyncGenerator<string> {
  const api = bridge!
  let notify: (() => void) | null = null
  const queue: string[] = []
  let finished = false
  let failure: unknown = null
  api.net
    .fetchStream(req, (chunk) => {
      queue.push(chunk)
      notify?.()
      notify = null
    })
    .then(
      () => {
        finished = true
        notify?.()
      },
      (err) => {
        failure = err
        finished = true
        notify?.()
      },
    )
  for (;;) {
    if (queue.length > 0) {
      yield queue.shift()!
      continue
    }
    if (finished) {
      if (failure) throw failure
      return
    }
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }
}

async function* webTextStream(req: NetRequest, signal?: AbortSignal): AsyncGenerator<string> {
  if (!isLocalUrl(req.url)) {
    let yielded = false
    try {
      const stream = directTextStream(req, signal)
      for await (const chunk of stream) {
        yielded = true
        yield chunk
      }
      return
    } catch (err) {
      if (yielded) throw err
      // fall through to the proxy
    }
  }
  yield* proxyTextStream(req)
}

async function* directTextStream(req: NetRequest, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(req.url, {
    method: req.method || 'POST',
    headers: req.headers,
    body: req.body,
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function* proxyTextStream(req: NetRequest): AsyncGenerator<string> {
  const res = await fetch('/api/net/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok || !res.body) throw new Error(`proxy stream failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      let obj: any
      try {
        obj = JSON.parse(data)
      } catch {
        continue
      }
      if (typeof obj.chunk === 'string') yield obj.chunk
      else if (obj.done) {
        if (obj.error) throw new Error(String(obj.error))
        return
      }
    }
  }
}
