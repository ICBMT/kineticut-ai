/**
 * HTTP/WebSocket implementation of `KineticAPI`, used when the renderer runs
 * in a plain browser (live preview). Vite proxies `/api/*` to dev-server.
 */
import type {
  ExecOptions,
  ExecResult,
  FileEntry,
  FileTree,
  FsEvent,
  GitFileDiff,
  GitStatus,
  KineticAPI,
  NetRequest,
  NetResponse,
  SearchResult,
  SettingsBag,
  SystemInfo,
  TerminalOptions,
} from '../../shared/types'

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return http<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function qs(params: Record<string, string>): string {
  return '?' + new URLSearchParams(params).toString()
}

/** Parse a text/event-stream response body, invoking onData per `data:` JSON payload. */
async function readSSE(res: Response, onData: (obj: any) => void): Promise<void> {
  if (!res.body) return
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
      try {
        onData(JSON.parse(data))
      } catch {
        /* keepalive */
      }
    }
  }
}

/* ------------------------------ terminal (WS) ------------------------------ */

const termSockets = new Map<string, WebSocket>()
const termDataCbs = new Map<string, Set<(data: string) => void>>()
const termExitCbs = new Map<string, Set<(code: number) => void>>()

function termSocket(id: string): WebSocket {
  let ws = termSockets.get(id)
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/api/term/ws?id=${encodeURIComponent(id)}`)
  termSockets.set(id, ws)
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'd') termDataCbs.get(id)?.forEach((cb) => cb(msg.d))
      else if (msg.t === 'x') {
        termExitCbs.get(id)?.forEach((cb) => cb(msg.code ?? 0))
        termDataCbs.delete(id)
        termExitCbs.delete(id)
        termSockets.delete(id)
      }
    } catch {
      /* ignore */
    }
  }
  ws.onclose = () => {
    if (termSockets.get(id) === ws) termSockets.delete(id)
  }
  return ws
}

export function createHttpApi(): KineticAPI {
  return {
    system: {
      info: () => http<SystemInfo>('/api/system'),
      openFolder: async () => null, // desktop-only (native dialog)
      showItemInFolder: async () => {},
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      exec: (command, opts?: ExecOptions) => post<ExecResult>('/api/system/exec', { command, opts }),
    },
    fs: {
      list: (path) => http<FileEntry[]>(`/api/fs/list${qs({ path })}`),
      tree: (path, maxDepth) => post<FileTree>('/api/fs/tree', { path, maxDepth }),
      read: (path) => post<any>('/api/fs/read', { path }),
      write: (path, content) => post<any>('/api/fs/write', { path, content }),
      mkdir: (path) => post<any>('/api/fs/mkdir', { path }),
      remove: (path) => post<any>('/api/fs/remove', { path }),
      rename: (oldPath, newPath) => post<any>('/api/fs/rename', { oldPath, newPath }),
      stat: (path) => http<any>(`/api/fs/stat${qs({ path })}`),
      watch: async (path, cb) => {
        const source = new EventSource(`/api/fs/watch${qs({ path })}`)
        source.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data)
            if (Array.isArray(data.events)) cb(data.events as FsEvent[])
          } catch {
            /* ready ping */
          }
        }
        return () => source.close()
      },
    },
    search: {
      query: (root, text, maxResults) => post<SearchResult[]>('/api/search', { root, text, maxResults }),
    },
    git: {
      status: (root) => http<GitStatus>(`/api/git/status${qs({ root })}`),
      stage: (root, paths) => post<any>('/api/git/stage', { root, paths }),
      unstage: (root, paths) => post<any>('/api/git/unstage', { root, paths }),
      discard: (root, paths) => post<any>('/api/git/discard', { root, paths }),
      commit: (root, message) => post<any>('/api/git/commit', { root, message }),
      init: (root) => post<any>('/api/git/init', { root }),
      show: (root, path) => http<GitFileDiff>(`/api/git/show${qs({ root, path })}`),
    },
    terminal: {
      create: async (opts: TerminalOptions) => {
        const { id } = await post<{ id: string }>('/api/term', opts)
        termSocket(id) // open the data channel eagerly
        return { id }
      },
      write: (id, data) => {
        const ws = termSockets.get(id)
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: data }))
      },
      resize: (id, cols, rows) => {
        const ws = termSockets.get(id)
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', cols, rows }))
      },
      kill: (id) => {
        const ws = termSockets.get(id)
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'k' }))
        termSockets.get(id)?.close()
        termSockets.delete(id)
      },
      onData: (id, cb) => {
        let set = termDataCbs.get(id)
        if (!set) {
          set = new Set()
          termDataCbs.set(id, set)
        }
        set.add(cb)
        termSocket(id)
        return () => {
          set.delete(cb)
        }
      },
      onExit: (id, cb) => {
        let set = termExitCbs.get(id)
        if (!set) {
          set = new Set()
          termExitCbs.set(id, set)
        }
        set.add(cb)
        return () => {
          set.delete(cb)
        }
      },
    },
    net: {
      fetch: (req: NetRequest) => post<NetResponse>('/api/net/fetch', req),
      fetchStream: async (req: NetRequest, onChunk: (chunk: string) => void) => {
        const res = await fetch('/api/net/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        })
        if (!res.ok) throw new Error(`proxy stream failed: ${res.status}`)
        let final: NetResponse | null = null
        let failure: Error | null = null
        await readSSE(res, (obj) => {
          if (typeof obj.chunk === 'string') onChunk(obj.chunk)
          else if (obj.done) {
            if (obj.error) failure = new Error(String(obj.error))
            else final = { status: obj.status ?? 200, statusText: obj.statusText ?? '', headers: {}, body: '' }
          }
        })
        if (failure) throw failure
        if (!final) throw new Error('stream ended without status')
        return final
      },
    },
    settings: {
      get: () => http<SettingsBag>('/api/settings'),
      set: (patch) => post<SettingsBag>('/api/settings', patch),
    },
    projectIndex: {
      get: (root) => http<any>(`/api/project-index${qs({ root })}`),
      rescan: (root) => post<any>('/api/project-index/rescan', { root }),
      setSummaries: (root, items) => post<any>('/api/project-index/summaries', { root, items }),
    },
    win: {
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      isMaximized: async () => false,
      onMaximizeChange: () => () => {},
      editRole: (role) => {
        try {
          document.execCommand(role === 'selectAll' ? 'selectAll' : role)
        } catch {
          /* ignore */
        }
      },
    },
  }
}
