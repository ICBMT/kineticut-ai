import { contextBridge, ipcRenderer } from 'electron'
import type {
  FsEvent,
  GitFile,
  KineticAPI,
  NetRequest,
  NetResponse,
  SettingsBag,
  TerminalOptions,
} from '../shared/types'

/* ---------------------------------- state --------------------------------- */

const watchCbs = new Map<string, (events: FsEvent[]) => void>()
const termDataCbs = new Map<string, Set<(data: string) => void>>()
const termExitCbs = new Map<string, Set<(code: number) => void>>()
const streamCbs = new Map<string, { onChunk: (c: string) => void; resolve: (r: NetResponse) => void; reject: (e: Error) => void }>()
const maxChangeCbs = new Set<(maximized: boolean) => void>()

ipcRenderer.on('fs:events', (_e, payload: { watchId: string; events: FsEvent[] }) => {
  watchCbs.get(payload.watchId)?.(payload.events)
})

ipcRenderer.on('term:data', (_e, payload: { id: string; data: string }) => {
  termDataCbs.get(payload.id)?.forEach((cb) => cb(payload.data))
})

ipcRenderer.on('term:exit', (_e, payload: { id: string; code: number }) => {
  termExitCbs.get(payload.id)?.forEach((cb) => cb(payload.code))
  termDataCbs.delete(payload.id)
  termExitCbs.delete(payload.id)
})

ipcRenderer.on('net:chunk', (_e, payload: { requestId: string; chunk: string }) => {
  streamCbs.get(payload.requestId)?.onChunk(payload.chunk)
})

ipcRenderer.on('net:end', (_e, payload: { requestId: string; status: number; statusText: string; error?: string }) => {
  const pending = streamCbs.get(payload.requestId)
  if (!pending) return
  streamCbs.delete(payload.requestId)
  if (payload.error) pending.reject(new Error(payload.error))
  else pending.resolve({ status: payload.status, statusText: payload.statusText, headers: {}, body: '' })
})

ipcRenderer.on('win:maximized', (_e, maximized: boolean) => {
  maxChangeCbs.forEach((cb) => cb(maximized))
})

/* ------------------------------ exposed API ------------------------------- */

const api: KineticAPI = {
  system: {
    info: () => ipcRenderer.invoke('system:info'),
    openFolder: () => ipcRenderer.invoke('system:openFolder'),
    showItemInFolder: (path) => ipcRenderer.invoke('system:showItemInFolder', path),
    openExternal: (url) => ipcRenderer.invoke('system:openExternal', url),
    exec: (command, opts) => ipcRenderer.invoke('system:exec', { command, opts }),
  },
  fs: {
    list: (path) => ipcRenderer.invoke('fs:list', path),
    tree: (path, maxDepth) => ipcRenderer.invoke('fs:tree', { path, maxDepth }),
    read: (path) => ipcRenderer.invoke('fs:read', path),
    write: (path, content) => ipcRenderer.invoke('fs:write', { path, content }),
    mkdir: (path) => ipcRenderer.invoke('fs:mkdir', path),
    remove: (path) => ipcRenderer.invoke('fs:remove', path),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', { oldPath, newPath }),
    stat: (path) => ipcRenderer.invoke('fs:stat', path),
    watch: async (path, cb) => {
      const watchId: string = await ipcRenderer.invoke('fs:watch', path)
      watchCbs.set(watchId, cb)
      return () => {
        watchCbs.delete(watchId)
        void ipcRenderer.invoke('fs:unwatch', watchId)
      }
    },
  },
  search: {
    query: (root, text, maxResults) => ipcRenderer.invoke('search:query', { root, text, maxResults }),
  },
  git: {
    status: (root) => ipcRenderer.invoke('git:status', root),
    stage: (root, paths: string[]) => ipcRenderer.invoke('git:stage', { root, paths }),
    unstage: (root, paths: string[]) => ipcRenderer.invoke('git:unstage', { root, paths }),
    discard: (root, paths: string[]) => ipcRenderer.invoke('git:discard', { root, paths }),
    commit: (root, message) => ipcRenderer.invoke('git:commit', { root, message }),
    init: (root) => ipcRenderer.invoke('git:init', root),
  },
  terminal: {
    create: (opts: TerminalOptions) => ipcRenderer.invoke('term:create', opts),
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('term:kill', { id }),
    onData: (id, cb) => {
      let set = termDataCbs.get(id)
      if (!set) {
        set = new Set()
        termDataCbs.set(id, set)
      }
      set.add(cb)
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
    fetch: (req: NetRequest) => ipcRenderer.invoke('net:fetch', req),
    fetchStream: (req: NetRequest, onChunk: (chunk: string) => void) => {
      const requestId = Math.random().toString(36).slice(2)
      return new Promise<NetResponse>((resolve, reject) => {
        streamCbs.set(requestId, { onChunk, resolve, reject })
        ipcRenderer.invoke('net:stream', { requestId, req }).catch((err) => {
          streamCbs.delete(requestId)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: SettingsBag) => ipcRenderer.invoke('settings:set', patch),
  },
  projectIndex: {
    get: (root: string) =>
      ipcRenderer.invoke('project-index:get', root) as Promise<import('../shared/types').ProjectIndexSnapshot>,
    rescan: (root: string) =>
      ipcRenderer.invoke('project-index:rescan', root) as Promise<import('../shared/types').ProjectIndexSnapshot>,
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (cb) => {
      maxChangeCbs.add(cb)
      return () => {
        maxChangeCbs.delete(cb)
      }
    },
    editRole: (role) => ipcRenderer.send('win:editRole', role),
  },
}

contextBridge.exposeInMainWorld('kinetic', api)

// Referenced only for type-checking of GitFile usage in this module.
export type { GitFile }
