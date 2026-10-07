/**
 * Shared types for the Kineticut AI desktop API.
 *
 * This exact surface is implemented twice:
 *  - `src/preload/index.ts`  — Electron IPC bridge (exposed as `window.kinetic`)
 *  - `dev-server/index.mjs`  — HTTP/WebSocket dev server (used by the browser preview)
 *
 * Keeping one interface means the renderer runs identically as a desktop app
 * and as a web preview.
 */

export interface FileStat {
  exists: boolean
  type: 'file' | 'directory' | 'other'
  size: number
  mtime: number
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  mtime: number
}

export interface FileTree extends FileEntry {
  children?: FileTree[]
}

export interface ReadResult {
  path: string
  content: string
  binary: boolean
  size: number
  mtime: number
}

export type FsEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
export interface FsEvent {
  type: FsEventType
  path: string
}

export interface SearchHit {
  path: string
  line: number
  column: number
  text: string
}

export interface SearchResult {
  file: string
  hits: SearchHit[]
}

export interface GitFile {
  path: string
  status: string
}

export interface GitStatus {
  root: string
  branch: string | null
  tracking: string | null
  ahead: number
  behind: number
  staged: GitFile[]
  modified: GitFile[]
  untracked: GitFile[]
  conflicted: GitFile[]
}

export interface TerminalOptions {
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface NetRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface NetResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

export interface SystemInfo {
  platform: string
  arch: string
  home: string
  cwd: string
  hasRipgrep: boolean
  hasGit: boolean
  version: string
  isElectron: boolean
}

export type SettingsBag = Record<string, unknown>

export interface KineticAPI {
  system: {
    info(): Promise<SystemInfo>
    openFolder(): Promise<string | null>
    showItemInFolder(path: string): Promise<void>
    openExternal(url: string): Promise<void>
    exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  }
  fs: {
    list(path: string): Promise<FileEntry[]>
    tree(path: string, maxDepth?: number): Promise<FileTree>
    read(path: string): Promise<ReadResult>
    write(path: string, content: string): Promise<void>
    mkdir(path: string): Promise<void>
    remove(path: string): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    stat(path: string): Promise<FileStat>
    watch(path: string, cb: (events: FsEvent[]) => void): Promise<() => void>
  }
  search: {
    query(root: string, text: string, maxResults?: number): Promise<SearchResult[]>
  }
  git: {
    status(root: string): Promise<GitStatus>
    stage(root: string, paths: string[]): Promise<void>
    unstage(root: string, paths: string[]): Promise<void>
    /** Discard working-tree (and staged) changes for the given paths. */
    discard(root: string, paths: string[]): Promise<void>
    commit(root: string, message: string): Promise<void>
    init(root: string): Promise<void>
  }
  terminal: {
    create(opts: TerminalOptions): Promise<{ id: string }>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: (code: number) => void): () => void
  }
  net: {
    fetch(req: NetRequest): Promise<NetResponse>
    /** Streams response body chunks through `onChunk`; resolves with the final status. */
    fetchStream(req: NetRequest, onChunk: (chunk: string) => void): Promise<NetResponse>
  }
  settings: {
    get(): Promise<SettingsBag>
    set(patch: SettingsBag): Promise<SettingsBag>
  }
  win: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
    /** Native edit-role commands (undo/redo/cut/copy/paste/selectAll) routed to the focused window. */
    editRole(role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void
  }
}
