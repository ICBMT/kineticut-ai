import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, relative } from 'node:path'
import chokidar from 'chokidar'
import { simpleGit } from 'simple-git'
import {
  codebaseBuild,
  codebasePending,
  codebaseSearch,
  codebaseSetVectors,
  projectFile,
  projectIndexSnapshot,
  rescanProjectIndex,
  setFileSummaries,
} from './projectIndex'
import type {
  ExecResult,
  FileEntry,
  FileTree,
  FsEvent,
  GitFileDiff,
  GitStatus,
  NetRequest,
  SearchResult,
  SettingsBag,
  SystemInfo,
  TerminalOptions,
} from '../shared/types'
import { fetchPageText, searchWeb } from '../shared/webFetch.mjs'

/* --------------------------------- helpers --------------------------------- */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.idea',
  'release',
])

const MAX_TREE_ENTRIES = 30000
const MAX_READ_BYTES = 8 * 1024 * 1024

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Decode a file buffer as text, honoring UTF-8/UTF-16 BOMs; flags true binaries. */
function decodeTextBuffer(buf: Buffer): { content: string; binary: boolean } {
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: buf.subarray(2).toString('utf16le'), binary: false }
  }
  // UTF-16 BE BOM (swap to LE)
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(Math.floor((buf.length - 2) / 2) * 2)
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return { content: swapped.toString('utf16le'), binary: false }
  }
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3).toString('utf8'), binary: false }
  }
  if (looksBinary(buf)) return { content: '', binary: true }
  return { content: buf.toString('utf8'), binary: false }
}

async function toEntry(path: string, type: 'file' | 'directory'): Promise<FileEntry> {
  let size = 0
  let mtime = 0
  try {
    const st = await fs.stat(path)
    size = st.size
    mtime = st.mtimeMs
  } catch {
    /* ignore */
  }
  return { name: path.split(/[/\\]/).pop() || path, path, type, size, mtime }
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/* ------------------------------ fs watchers -------------------------------- */

const watchers = new Map<string, { watcher: chokidar.FSWatcher; timer: NodeJS.Timeout | null; queue: FsEvent[] }>()

function flushWatch(watchId: string, getWin: () => BrowserWindow | null) {
  const rec = watchers.get(watchId)
  if (!rec || rec.queue.length === 0) return
  const events = rec.queue.splice(0, rec.queue.length)
  rec.timer = null
  getWin()?.webContents.send('fs:events', { watchId, events })
}

function pushWatchEvent(
  watchId: string,
  event: FsEvent,
  getWin: () => BrowserWindow | null,
) {
  const rec = watchers.get(watchId)
  if (!rec) return
  // Collapse add+change bursts for the same path.
  const existing = rec.queue.findIndex((e) => e.path === event.path)
  if (existing >= 0) {
    if (event.type === 'unlink' || event.type === 'unlinkDir') rec.queue[existing] = event
    return
  }
  rec.queue.push(event)
  if (!rec.timer) {
    rec.timer = setTimeout(() => flushWatch(watchId, getWin), 200)
  }
}

/* -------------------------------- terminals -------------------------------- */

interface TermHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const terminals = new Map<string, TermHandle>()

let nodePty: typeof import('node-pty') | null = null
try {
  // Only load when the native binding actually exists (it may be absent when
  // the optional dependency could not be compiled — the fallbacks handle it).
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { createRequire } = require('node:module') as typeof import('node:module')
  const req = createRequire(__filename)
  const binding = req.resolve('node-pty')
  const dir = join(binding, '..', '..', 'build', 'Release', 'pty.node')
  if (existsSync(dir)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nodePty = require('node-pty')
  }
} catch {
  nodePty = null
}

function spawnTerminal(
  opts: TerminalOptions,
  hooks: { onData(data: string): void; onExit(code: number): void },
): TermHandle {
  const shellPath = opts.shell || process.env.SHELL || '/bin/bash'
  const cwd = opts.cwd || homedir()
  const cols = opts.cols || 80
  const rows = opts.rows || 24
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...(opts.env || {}),
  } as Record<string, string>

  // Layer 1: node-pty (real pty, full fidelity)
  if (nodePty) {
    try {
      const p = nodePty.spawn(shellPath, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
      p.onData((d) => hooks.onData(d))
      p.onExit(({ exitCode }) => hooks.onExit(exitCode))
      return {
        write: (d) => p.write(d),
        resize: (c, r) => {
          try {
            p.resize(c, r)
          } catch {
            /* exited */
          }
        },
        kill: () => {
          try {
            p.kill()
          } catch {
            /* already dead */
          }
        },
      }
    } catch {
      /* fall through */
    }
  }

  // Layer 2: script(1) — util-linux/macOS pseudo-terminal wrapper
  try {
    const isDarwin = process.platform === 'darwin'
    const args = isDarwin ? ['-q', '/dev/null', shellPath] : ['-qec', shellPath, '/dev/null']
    const child = spawn('script', args, { cwd, env })
    let dead = false
    child.on('error', () => {
      if (!dead) {
        dead = true
        hooks.onExit(1)
      }
    })
    child.stdout?.on('data', (d) => hooks.onData(d.toString()))
    child.stderr?.on('data', (d) => hooks.onData(d.toString()))
    child.on('exit', (code) => {
      if (!dead) {
        dead = true
        hooks.onExit(code ?? 0)
      }
    })
    return {
      write: (d) => {
        if (!dead) child.stdin?.write(d)
      },
      resize: () => {
        /* not supported by the script wrapper */
      },
      kill: () => {
        if (!dead) {
          dead = true
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      },
    }
  } catch {
    /* fall through */
  }

  // Layer 3: plain pipes (degraded, but always works)
  const child = spawn(shellPath, [], { cwd, env })
  child.stdout?.on('data', (d) => hooks.onData(d.toString()))
  child.stderr?.on('data', (d) => hooks.onData(d.toString()))
  child.on('exit', (code) => hooks.onExit(code ?? 0))
  return {
    write: (d) => child.stdin?.write(d),
    resize: () => {},
    kill: () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    },
  }
}

/* ---------------------------------- search ---------------------------------- */

function rgAvailable(): boolean {
  try {
    const r = spawnSync('rg', ['--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

function rgSearch(root: string, text: string, maxResults: number): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const args = [
      '--json',
      '--hidden',
      '--no-ignore',
      '--max-count',
      '100',
      '--max-filesize',
      '2M',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!**/.git/**',
      '--glob',
      '!dist/**',
      '--glob',
      '!out/**',
      '--glob',
      '!release/**',
      '-F',
    ]
    // Smart case: case-insensitive unless the query has uppercase letters.
    if (text === text.toLowerCase()) args.push('-i')
    args.push('-e', text, root)

    const byFile = new Map<string, SearchResult>()
    let total = 0
    let done = false

    const finish = () => {
      if (!done) {
        done = true
        resolve(Array.from(byFile.values()))
      }
    }

    let child
    try {
      child = spawn('rg', args, { cwd: root })
    } catch {
      finish()
      return
    }

    let buf = ''
    child.stdout?.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let evt: any
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }
        if (evt.type !== 'match') continue
        const file: string = evt.data?.path?.text
        const lineNo: number = evt.data?.line_number
        const text2: string = (evt.data?.lines?.text || '').replace(/\r?\n$/, '')
        const col: number = (evt.data?.submatches?.[0]?.start ?? 0) + 1
        if (!file || !lineNo) continue
        let group = byFile.get(file)
        if (!group) {
          group = { file, hits: [] }
          byFile.set(file, group)
        }
        group.hits.push({ path: file, line: lineNo, column: col, text: text2.slice(0, 500) })
        total++
        if (total >= maxResults) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          finish()
          return
        }
      }
    })
    child.on('error', finish)
    child.on('close', finish)
  })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function walkSearch(
  dir: string,
  rx: RegExp,
  root: string,
  maxResults: number,
  byFile: Map<string, SearchResult>,
  state: { total: number },
): Promise<void> {
  if (state.total >= maxResults) return
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of dirents) {
    if (state.total >= maxResults) return
    const p = join(dir, d.name)
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue
      await walkSearch(p, rx, root, maxResults, byFile, state)
    } else if (d.isFile()) {
      if (SKIP_DIRS.has(d.name)) continue
      let content: string
      try {
        const buf = await fs.readFile(p)
        if (buf.length > 1024 * 1024 || looksBinary(buf)) continue
        content = buf.toString('utf8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (state.total >= maxResults) return
        const m = rx.exec(lines[i])
        if (m) {
          const rel = relative(root, p) || p
          let group = byFile.get(rel)
          if (!group) {
            group = { file: rel, hits: [] }
            byFile.set(rel, group)
          }
          group.hits.push({
            path: p,
            line: i + 1,
            column: (m.index ?? 0) + 1,
            text: lines[i].replace(/\r$/, '').slice(0, 500),
          })
          state.total++
        }
      }
    }
  }
}

/* --------------------------------- settings --------------------------------- */

function settingsPath(): string {
  return join(app.getPath('userData'), 'kineticut-settings.json')
}

async function readSettings(): Promise<SettingsBag> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    return JSON.parse(raw) as SettingsBag
  } catch {
    return {}
  }
}

/* --------------------------------- register --------------------------------- */



/* ---------------------------- git: show changes ---------------------------- */

const GIT_SHOW_MAX_BYTES = 2 * 1024 * 1024

/** Resolve a repo-relative path and refuse anything that escapes the root. */
function resolveInsideRoot(root: string, rel: string): string {
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error('Invalid path')
  const abs = join(root, rel)
  const back = relative(root, abs)
  if (!back || back.startsWith('..')) throw new Error('Path is outside the project')
  return abs
}

/** HEAD vs working-tree content for one file. Missing sides are empty. */
async function gitShowDiff(root: string, rel: string): Promise<GitFileDiff> {
  const abs = resolveInsideRoot(root, rel)
  const git = simpleGit(root)
  let original = ''
  let inHead = true
  try {
    original = await git.raw(['show', `HEAD:${rel}`])
  } catch {
    inHead = false
  }
  let modified = ''
  let onDisk = true
  let tooLarge = false
  let buf: Buffer | null = null
  try {
    const st = await fs.stat(abs)
    if (st.size > GIT_SHOW_MAX_BYTES) tooLarge = true
    else buf = await fs.readFile(abs)
  } catch {
    onDisk = false
  }
  if (!inHead && !onDisk) throw new Error(`Not a tracked or existing file: ${rel}`)
  if (buf) modified = buf.toString('utf8')
  const binary = (buf ? looksBinary(buf) : false) || original.slice(0, 8000).includes('\u0000')
  const status: GitFileDiff['status'] = !inHead && onDisk
    ? 'added'
    : inHead && !onDisk
      ? 'deleted'
      : original === modified
        ? 'unchanged'
        : 'modified'
  if (binary || tooLarge) return { path: rel, status, original: '', modified: '', binary, tooLarge }
  return { path: rel, status, original, modified, binary: false, tooLarge: false }
}

export function registerIpc(getWin: () => BrowserWindow | null) {
  /* --------------------------------- system --------------------------------- */

  ipcMain.handle('system:info', async (): Promise<SystemInfo> => {
    return {
      platform: process.platform,
      arch: process.arch,
      home: homedir(),
      cwd: process.cwd(),
      hasRipgrep: rgAvailable(),
      hasGit: (() => {
        try {
          return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
        } catch {
          return false
        }
      })(),
      version: app.getVersion(),
      isElectron: true,
    }
  })

  ipcMain.handle('system:openFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return res.canceled ? null : res.filePaths[0] ?? null
  })

  ipcMain.handle('system:showItemInFolder', async (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('system:openExternal', async (_e, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle('web:fetch', async (_e, url: string) => fetchPageText(url))
  ipcMain.handle(
    'web:search',
    async (_e, p: { query: string; apiKey: string | null; count?: number }) => searchWeb(p.query, p.apiKey, { count: p.count }),
  )

  ipcMain.handle('system:exec', async (_e, payload: { command: string; opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } }): Promise<ExecResult> => {
    const { command, opts } = payload
    const timeoutMs = opts?.timeoutMs ?? 60_000
    return new Promise((resolve) => {
      execFile(
        '/bin/sh',
        ['-c', command],
        { cwd: opts?.cwd || homedir(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(opts?.env || {}) } },
        (error, stdout, stderr) => {
          resolve({
            code: error && typeof (error as any).code === 'number' ? (error as any).code : error ? 1 : 0,
            stdout: stdout ?? '',
            stderr: stderr ?? (error ? String(error.message) : ''),
          })
        },
      )
    })
  })

  /* ----------------------------------- fs ----------------------------------- */

  ipcMain.handle('fs:list', async (_e, path: string): Promise<FileEntry[]> => {
    const dirents = await fs.readdir(path, { withFileTypes: true })
    const entries = await Promise.all(
      dirents
        .filter((d) => !(d.isDirectory() && SKIP_DIRS.has(d.name)))
        .map(async (d) =>
          toEntry(join(path, d.name), d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'directory'),
        ),
    )
    return sortEntries(entries)
  })

  ipcMain.handle('fs:tree', async (_e, payload: { path: string; maxDepth?: number }): Promise<FileTree> => {
    const maxDepth = payload.maxDepth ?? 8
    const state = { count: 0 }
    const build = async (path: string, depth: number): Promise<FileTree> => {
      const st = await fs.stat(path)
      const node: FileTree = {
        name: path.split(/[/\\]/).pop() || path,
        path,
        type: 'directory',
        size: st.size,
        mtime: st.mtimeMs,
      }
      if (depth >= maxDepth) return node
      let dirents
      try {
        dirents = await fs.readdir(path, { withFileTypes: true })
      } catch {
        return node
      }
      const children: FileTree[] = []
      for (const d of dirents) {
        if (state.count > MAX_TREE_ENTRIES) break
        const childPath = join(path, d.name)
        if (d.isDirectory()) {
          if (SKIP_DIRS.has(d.name)) continue
          state.count++
          children.push(await build(childPath, depth + 1))
        } else if (d.isFile()) {
          state.count++
          let size = 0
          let mtime = 0
          try {
            const s = await fs.stat(childPath)
            size = s.size
            mtime = s.mtimeMs
          } catch {
            /* ignore */
          }
          children.push({ name: d.name, path: childPath, type: 'file', size, mtime })
        }
      }
      node.children = sortEntries(children) as FileTree[]
      return node
    }
    return build(payload.path, 0)
  })

  ipcMain.handle('fs:read', async (_e, path: string) => {
    const buf = await fs.readFile(path)
    const st = await fs.stat(path)
    const { content, binary } = decodeTextBuffer(buf)
    return {
      path,
      content: binary ? '' : content.slice(0, MAX_READ_BYTES),
      binary,
      size: buf.length,
      mtime: st.mtimeMs,
      truncated: !binary && content.length > MAX_READ_BYTES,
    }
  })

  ipcMain.handle('fs:write', async (_e, payload: { path: string; content: string }) => {
    await fs.mkdir(join(payload.path, '..'), { recursive: true })
    await fs.writeFile(payload.path, payload.content, 'utf8')
  })

  ipcMain.handle('fs:mkdir', async (_e, path: string) => {
    await fs.mkdir(path, { recursive: true })
  })

  ipcMain.handle('fs:remove', async (_e, path: string) => {
    await fs.rm(path, { recursive: true, force: true })
  })

  ipcMain.handle('fs:rename', async (_e, payload: { oldPath: string; newPath: string }) => {
    await fs.mkdir(join(payload.newPath, '..'), { recursive: true })
    await fs.rename(payload.oldPath, payload.newPath)
  })

  ipcMain.handle('fs:stat', async (_e, path: string) => {
    try {
      const st = await fs.stat(path)
      return {
        exists: true,
        type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
        size: st.size,
        mtime: st.mtimeMs,
      }
    } catch {
      return { exists: false, type: 'other', size: 0, mtime: 0 }
    }
  })

  ipcMain.handle('fs:watch', async (_e, path: string) => {
    const watchId = randomUUID()
    const watcher = chokidar.watch(path, {
      ignoreInitial: true,
      depth: 24,
      ignored: (p: string) => {
        const base = p.split(/[/\\]/).pop() || ''
        return SKIP_DIRS.has(base)
      },
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 40 },
    })
    const rec = { watcher, timer: null as NodeJS.Timeout | null, queue: [] as FsEvent[] }
    watchers.set(watchId, rec)
    watcher.on('add', (p) => pushWatchEvent(watchId, { type: 'add', path: p }, getWin))
    watcher.on('change', (p) => pushWatchEvent(watchId, { type: 'change', path: p }, getWin))
    watcher.on('unlink', (p) => pushWatchEvent(watchId, { type: 'unlink', path: p }, getWin))
    watcher.on('addDir', (p) => pushWatchEvent(watchId, { type: 'addDir', path: p }, getWin))
    watcher.on('unlinkDir', (p) => pushWatchEvent(watchId, { type: 'unlinkDir', path: p }, getWin))
    return watchId
  })

  ipcMain.handle('fs:unwatch', async (_e, watchId: string) => {
    const rec = watchers.get(watchId)
    if (rec) {
      watchers.delete(watchId)
      if (rec.timer) clearTimeout(rec.timer)
      await rec.watcher.close()
    }
  })

  /* --------------------------------- search --------------------------------- */

  ipcMain.handle('search:query', async (_e, payload: { root: string; text: string; maxResults?: number }): Promise<SearchResult[]> => {
    const root = payload.root
    const text = payload.text
    const maxResults = payload.maxResults ?? 1000
    if (!text.trim()) return []
    if (rgAvailable()) {
      const results = await rgSearch(root, text, maxResults)
      if (results.length > 0 || text.length > 0) return results
    }
    // JS fallback
    const rx = new RegExp(escapeRegExp(text), text === text.toLowerCase() ? 'i' : '')
    const byFile = new Map<string, SearchResult>()
    const state = { total: 0 }
    await walkSearch(root, rx, root, maxResults, byFile, state)
    return Array.from(byFile.values())
  })

  /* ----------------------------------- git ---------------------------------- */

  const emptyStatus = (root: string): GitStatus => ({
    root,
    branch: null,
    tracking: null,
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    conflicted: [],
  })

  ipcMain.handle('git:status', async (_e, root: string): Promise<GitStatus> => {
    try {
      const git = simpleGit(root)
      const status = await git.status()
      const mapFiles = (files: string[]) => files.map((p) => ({ path: p, status: '' }))
      return {
        root,
        branch: status.current,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
        staged: mapFiles(status.staged),
        modified: mapFiles(status.modified),
        untracked: mapFiles(status.not_added),
        conflicted: mapFiles(status.conflicted),
      }
    } catch {
      return emptyStatus(root)
    }
  })

  ipcMain.handle('git:stage', async (_e, payload: { root: string; paths: string[] }) => {
    await simpleGit(payload.root).add(payload.paths)
  })

  ipcMain.handle('git:unstage', async (_e, payload: { root: string; paths: string[] }) => {
    const git = simpleGit(payload.root)
    try {
      await git.reset(['HEAD', '--', ...payload.paths])
    } catch {
      await git.rm(['--cached', ...payload.paths])
    }
  })

  ipcMain.handle('git:discard', async (_e, payload: { root: string; paths: string[] }) => {
    const git = simpleGit(payload.root)
    const status = await git.status()
    const untracked = new Set(status.not_added)
    const tracked = payload.paths.filter((p) => !untracked.has(p))
    const untrackedPaths = payload.paths.filter((p) => untracked.has(p))
    if (tracked.length > 0) {
      await git.raw(['restore', '--staged', '--worktree', '--', ...tracked])
    }
    if (untrackedPaths.length > 0) {
      await git.raw(['clean', '-f', '--', ...untrackedPaths])
    }
  })

  ipcMain.handle('git:commit', async (_e, payload: { root: string; message: string }) => {
    const msg = payload.message.trim()
    if (!msg) throw new Error('Commit message is empty')
    await simpleGit(payload.root).commit(msg)
  })

  ipcMain.handle('git:init', async (_e, root: string) => {
    await simpleGit(root).init()
  })

  ipcMain.handle('git:show', async (_e, payload: { root: string; path: string }) => {
    return gitShowDiff(payload.root, payload.path)
  })

  /* -------------------------------- terminal -------------------------------- */

  ipcMain.handle('term:create', async (_e, opts: TerminalOptions) => {
    const id = randomUUID()
    const handle = spawnTerminal(opts, {
      onData: (data) => getWin()?.webContents.send('term:data', { id, data }),
      onExit: (code) => getWin()?.webContents.send('term:exit', { id, code }),
    })
    terminals.set(id, handle)
    return { id }
  })

  ipcMain.on('term:write', (_e, payload: { id: string; data: string }) => {
    terminals.get(payload.id)?.write(payload.data)
  })

  ipcMain.on('term:resize', (_e, payload: { id: string; cols: number; rows: number }) => {
    terminals.get(payload.id)?.resize(payload.cols, payload.rows)
  })

  ipcMain.on('term:kill', (_e, payload: { id: string }) => {
    const handle = terminals.get(payload.id)
    if (handle) {
      terminals.delete(payload.id)
      handle.kill()
    }
  })

  /* ----------------------------------- net ---------------------------------- */

  ipcMain.handle('net:fetch', async (_e, req: NetRequest) => {
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers,
      body: req.body,
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    const body = await res.text()
    return { status: res.status, statusText: res.statusText, headers, body }
  })

  ipcMain.handle('net:stream', async (event, payload: { requestId: string; req: NetRequest }) => {
    const { requestId, req } = payload
    const send = (channel: string, obj: Record<string, unknown>) =>
      event.sender.send(channel, { requestId, ...obj })
    try {
      const res = await fetch(req.url, {
        method: req.method || 'POST',
        headers: req.headers,
        body: req.body,
      })
      if (!res.body) {
        send('net:chunk', { chunk: await res.text() })
        send('net:end', { status: res.status, statusText: res.statusText })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        send('net:chunk', { chunk: decoder.decode(value, { stream: true }) })
      }
      const tail = decoder.decode()
      if (tail) send('net:chunk', { chunk: tail })
      send('net:end', { status: res.status, statusText: res.statusText })
    } catch (err) {
      send('net:end', { status: 0, statusText: '', error: err instanceof Error ? err.message : String(err) })
    }
  })

  /* --------------------------------- settings -------------------------------- */

  ipcMain.handle('settings:get', async (): Promise<SettingsBag> => readSettings())

  ipcMain.handle('settings:set', async (_e, patch: SettingsBag): Promise<SettingsBag> => {
    const current = await readSettings()
    const next = { ...current, ...patch }
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
    return next
  })

  /* ------------------------------ project index ----------------------------- */

  ipcMain.handle('project-index:get', async (_e, root: string) => projectIndexSnapshot(root))
  ipcMain.handle('codebase:build', async (_e, root: string) => codebaseBuild(root))
  ipcMain.handle(
    'codebase:search',
    async (
      _e,
      p: { root: string; query: string; k?: number; model?: string | null; queryVector?: number[] | null },
    ) =>
    codebaseSearch(p.root, p.query, { k: p.k, model: p.model, queryVector: p.queryVector }),
  )
  ipcMain.handle('codebase:pending', async (_e, p: { root: string; model: string; limit?: number }) =>
    codebasePending(p.root, { model: p.model, limit: p.limit }),
  )
  ipcMain.handle('codebase:vectors', async (_e, p: { root: string; model: string; items: { id: string; hash: string; vector: number[] }[] }) =>
    codebaseSetVectors(p.root, { model: p.model, items: p.items }),
  )
  ipcMain.handle('project-index:rescan', async (_e, root: string) => rescanProjectIndex(root))
  ipcMain.handle('project-index:file', async (_e, payload: { root: string; rel: string }) =>
    projectFile(payload.root, payload.rel),
  )
  ipcMain.handle(
    'project-index:summaries',
    async (
      _e,
      payload: { root: string; items: { rel: string; summary: string; summaryAt: number }[] },
    ) => {
      await setFileSummaries(payload.root, payload.items)
    },
  )

  /* ---------------------------------- window --------------------------------- */

  ipcMain.on('win:minimize', () => getWin()?.minimize())
  ipcMain.on('win:maximize', () => {
    const w = getWin()
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', () => getWin()?.close())
  ipcMain.handle('win:isMaximized', async () => getWin()?.isMaximized() ?? false)

  ipcMain.on('win:editRole', (_e, role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const wc = getWin()?.webContents
    if (!wc) return
    try {
      ;(wc as any)[role]?.()
    } catch {
      /* ignore */
    }
  })
}
