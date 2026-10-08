/**
 * Kineticut AI — dev API server.
 *
 * Mirrors the Electron IPC API (`src/shared/types.ts` → `KineticAPI`) over
 * HTTP + WebSocket so the exact same renderer can run in a browser as a live
 * preview. Vite proxies `/api/*` (including the WS upgrade) to this server.
 *
 *   node dev-server/index.mjs     # listens on 0.0.0.0:4890
 *
 * Dev/preview only — it exposes real fs/terminal access, so never expose it
 * beyond a trusted sandbox.
 */
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { projectIndexSnapshot, rescanProjectIndex, setFileSummaries } from './project-index.mjs'

const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')
const chokidar = require('chokidar')
const { simpleGit } = require('simple-git')

let nodePty = null
try {
  // Only load when the native binding actually exists (it may be absent when
  // the optional dependency could not be compiled — the fallbacks handle it).
  const { existsSync } = require('node:fs')
  const { join: joinPath } = require('node:path')
  const binding = joinPath(__dirname, '..', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
  if (existsSync(binding)) nodePty = require('node-pty')
} catch {
  nodePty = null
}

const PORT = Number(process.env.KINETICUT_API_PORT || 4890)
const ROOT = process.env.KINETICUT_ROOT || process.cwd()

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

const SETTINGS_FILE = join(homedir(), '.kineticut-dev-settings.json')

/* --------------------------------- helpers --------------------------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  })
  res.end(body)
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 64 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw) return {}
  return JSON.parse(raw)
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true
  return false
}

/** Decode a file buffer as text, honoring UTF-8/UTF-16 BOMs; flags true binaries. */
function decodeTextBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: buf.subarray(2).toString('utf16le'), binary: false }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(Math.floor((buf.length - 2) / 2) * 2)
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return { content: swapped.toString('utf16le'), binary: false }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3).toString('utf8'), binary: false }
  }
  if (looksBinary(buf)) return { content: '', binary: true }
  return { content: buf.toString('utf8'), binary: false }
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

async function toEntry(path, type) {
  let size = 0
  let mtime = 0
  try {
    const st = await fs.stat(path)
    size = st.size
    mtime = st.mtimeMs
  } catch {}
  return { name: path.split(/[/\\]/).pop() || path, path, type, size, mtime }
}

function rgAvailable() {
  try {
    const { spawnSync } = require('node:child_process')
    return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function rgSearch(root, text, maxResults) {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process')
    const args = [
      '--json', '--hidden', '--no-ignore', '--max-count', '100', '--max-filesize', '2M',
      '--glob', '!node_modules/**', '--glob', '!**/.git/**', '--glob', '!dist/**',
      '--glob', '!out/**', '--glob', '!release/**', '-F',
    ]
    if (text === text.toLowerCase()) args.push('-i')
    args.push('-e', text, root)
    const byFile = new Map()
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
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let evt
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }
        if (evt.type !== 'match') continue
        const file = evt.data?.path?.text
        const lineNo = evt.data?.line_number
        const text2 = (evt.data?.lines?.text || '').replace(/\r?\n$/, '')
        const col = (evt.data?.submatches?.[0]?.start ?? 0) + 1
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
          } catch {}
          finish()
          return
        }
      }
    })
    child.on('error', finish)
    child.on('close', finish)
  })
}

/* --------------------------------- terminals -------------------------------- */

const terminals = new Map()

function spawnTerminal(opts, hooks) {
  const shellPath = opts.shell || process.env.SHELL || '/bin/bash'
  const cwd = opts.cwd || ROOT
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(opts.env || {}) }

  if (nodePty) {
    try {
      const p = nodePty.spawn(shellPath, [], {
        name: 'xterm-256color',
        cols: opts.cols || 80,
        rows: opts.rows || 24,
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
          } catch {}
        },
        kill: () => {
          try {
            p.kill()
          } catch {}
        },
      }
    } catch {}
  }

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
    child.stdout.on('data', (d) => hooks.onData(d.toString()))
    child.stderr.on('data', (d) => hooks.onData(d.toString()))
    child.on('exit', (code) => {
      if (!dead) {
        dead = true
        hooks.onExit(code ?? 0)
      }
    })
    return {
      write: (d) => {
        if (!dead) child.stdin.write(d)
      },
      resize: () => {},
      kill: () => {
        if (!dead) {
          dead = true
          try {
            child.kill('SIGKILL')
          } catch {}
        }
      },
    }
  } catch {}

  const child = spawn(shellPath, [], { cwd, env })
  child.stdout.on('data', (d) => hooks.onData(d.toString()))
  child.stderr.on('data', (d) => hooks.onData(d.toString()))
  child.on('exit', (code) => hooks.onExit(code ?? 0))
  return {
    write: (d) => child.stdin.write(d),
    resize: () => {},
    kill: () => {
      try {
        child.kill('SIGKILL')
      } catch {}
    },
  }
}

/* ---------------------------------- server ---------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method || 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    })
    res.end()
    return
  }

  try {
    /* ------------------------------- system ------------------------------- */
    if (path === '/api/health') return sendJson(res, 200, { ok: true, root: ROOT })

    if (path === '/api/system' && method === 'GET') {
      return sendJson(res, 200, {
        platform: process.platform,
        arch: process.arch,
        home: homedir(),
        cwd: ROOT,
        hasRipgrep: rgAvailable(),
        hasGit: true,
        version: 'dev-web',
        isElectron: false,
      })
    }

    if (path === '/api/system/exec' && method === 'POST') {
      const { command, opts } = await readJson(req)
      const timeoutMs = opts?.timeoutMs ?? 60000
      const result = await new Promise((resolve) => {
        execFile(
          '/bin/sh',
          ['-c', command],
          { cwd: opts?.cwd || ROOT, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(opts?.env || {}) } },
          (error, stdout, stderr) =>
            resolve({
              code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
              stdout: stdout ?? '',
              stderr: stderr ?? (error ? String(error.message) : ''),
            }),
        )
      })
      return sendJson(res, 200, result)
    }

    /* --------------------------------- fs --------------------------------- */
    if (path === '/api/fs/list' && method === 'GET') {
      const target = url.searchParams.get('path') || ROOT
      const dirents = await fs.readdir(target, { withFileTypes: true })
      const entries = await Promise.all(
        dirents
          .filter((d) => !(d.isDirectory() && SKIP_DIRS.has(d.name)))
          .map(async (d) => toEntry(join(target, d.name), d.isDirectory() ? 'directory' : 'file')),
      )
      return sendJson(res, 200, sortEntries(entries))
    }

    if (path === '/api/fs/tree' && method === 'POST') {
      const { path: target, maxDepth = 8 } = await readJson(req)
      const state = { count: 0 }
      const build = async (p, depth) => {
        const st = await fs.stat(p)
        const node = { name: p.split(/[/\\]/).pop() || p, path: p, type: 'directory', size: st.size, mtime: st.mtimeMs }
        if (depth >= maxDepth) return node
        let dirents
        try {
          dirents = await fs.readdir(p, { withFileTypes: true })
        } catch {
          return node
        }
        const children = []
        for (const d of dirents) {
          if (state.count > MAX_TREE_ENTRIES) break
          const childPath = join(p, d.name)
          if (d.isDirectory()) {
            if (SKIP_DIRS.has(d.name)) continue
            state.count++
            children.push(await build(childPath, depth + 1))
          } else if (d.isFile()) {
            state.count++
            children.push(await toEntry(childPath, 'file'))
          }
        }
        node.children = sortEntries(children)
        return node
      }
      return sendJson(res, 200, await build(target || ROOT, 0))
    }

    if (path === '/api/fs/read' && method === 'POST') {
      const { path: target } = await readJson(req)
      const buf = await fs.readFile(target)
      const st = await fs.stat(target)
      const { content, binary } = decodeTextBuffer(buf)
      return sendJson(res, 200, {
        path: target,
        content: binary ? '' : content.slice(0, MAX_READ_BYTES),
        binary,
        size: buf.length,
        mtime: st.mtimeMs,
        truncated: !binary && content.length > MAX_READ_BYTES,
      })
    }

    if (path === '/api/fs/write' && method === 'POST') {
      const { path: target, content } = await readJson(req)
      await fs.mkdir(join(target, '..'), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/fs/mkdir' && method === 'POST') {
      const { path: target } = await readJson(req)
      await fs.mkdir(target, { recursive: true })
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/fs/remove' && method === 'POST') {
      const { path: target } = await readJson(req)
      await fs.rm(target, { recursive: true, force: true })
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/fs/rename' && method === 'POST') {
      const { oldPath, newPath } = await readJson(req)
      await fs.mkdir(join(newPath, '..'), { recursive: true })
      await fs.rename(oldPath, newPath)
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/fs/stat' && method === 'GET') {
      const target = url.searchParams.get('path') || ''
      try {
        const st = await fs.stat(target)
        return sendJson(res, 200, {
          exists: true,
          type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
          size: st.size,
          mtime: st.mtimeMs,
        })
      } catch {
        return sendJson(res, 200, { exists: false, type: 'other', size: 0, mtime: 0 })
      }
    }

    if (path === '/api/fs/watch' && method === 'GET') {
      const target = url.searchParams.get('path') || ROOT
      sseHeaders(res)
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`)
      const watcher = chokidar.watch(target, {
        ignoreInitial: true,
        depth: 24,
        ignored: (p) => SKIP_DIRS.has(p.split(/[/\\]/).pop() || ''),
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 40 },
      })
      let queue = []
      let timer = null
      const flush = () => {
        if (queue.length === 0) return
        const events = queue
        queue = []
        timer = null
        res.write(`data: ${JSON.stringify({ events })}\n\n`)
      }
      const push = (type, p) => {
        const idx = queue.findIndex((e) => e.path === p)
        if (idx >= 0) {
          if (type === 'unlink' || type === 'unlinkDir') queue[idx] = { type, path: p }
          return
        }
        queue.push({ type, path: p })
        if (!timer) timer = setTimeout(flush, 200)
      }
      watcher.on('add', (p) => push('add', p))
      watcher.on('change', (p) => push('change', p))
      watcher.on('unlink', (p) => push('unlink', p))
      watcher.on('addDir', (p) => push('addDir', p))
      watcher.on('unlinkDir', (p) => push('unlinkDir', p))
      req.on('close', () => {
        if (timer) clearTimeout(timer)
        watcher.close()
      })
      return
    }

    /* -------------------------------- search -------------------------------- */
    if (path === '/api/search' && method === 'POST') {
      const { root, text, maxResults = 1000 } = await readJson(req)
      if (!text || !text.trim()) return sendJson(res, 200, [])
      if (rgAvailable()) {
        const results = await rgSearch(root || ROOT, text, maxResults)
        return sendJson(res, 200, results)
      }
      return sendJson(res, 200, [])
    }

    /* --------------------------------- git ---------------------------------- */
    const emptyStatus = (root) => ({
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

    if (path === '/api/git/status' && method === 'GET') {
      const root = url.searchParams.get('root') || ROOT
      try {
        const status = await simpleGit(root).status()
        const map = (files) => files.map((p) => ({ path: p, status: '' }))
        return sendJson(res, 200, {
          root,
          branch: status.current,
          tracking: status.tracking,
          ahead: status.ahead,
          behind: status.behind,
          staged: map(status.staged),
          modified: map(status.modified),
          untracked: map(status.not_added),
          conflicted: map(status.conflicted),
        })
      } catch {
        return sendJson(res, 200, emptyStatus(root))
      }
    }

    if (path === '/api/git/stage' && method === 'POST') {
      const { root, paths } = await readJson(req)
      await simpleGit(root || ROOT).add(paths)
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/git/unstage' && method === 'POST') {
      const { root, paths } = await readJson(req)
      const git = simpleGit(root || ROOT)
      try {
        await git.reset(['HEAD', '--', ...paths])
      } catch {
        await git.rm(['--cached', ...paths])
      }
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/git/discard' && method === 'POST') {
      const { root, paths } = await readJson(req)
      const git = simpleGit(root || ROOT)
      const status = await git.status()
      const untracked = new Set(status.not_added)
      const tracked = paths.filter((p) => !untracked.has(p))
      const untrackedPaths = paths.filter((p) => untracked.has(p))
      if (tracked.length > 0) await git.raw(['restore', '--staged', '--worktree', '--', ...tracked])
      if (untrackedPaths.length > 0) await git.raw(['clean', '-f', '--', ...untrackedPaths])
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/git/commit' && method === 'POST') {
      const { root, message } = await readJson(req)
      if (!message || !message.trim()) return sendJson(res, 400, { error: 'empty message' })
      await simpleGit(root || ROOT).commit(message.trim())
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/api/git/init' && method === 'POST') {
      const { root } = await readJson(req)
      await simpleGit(root || ROOT).init()
      return sendJson(res, 200, { ok: true })
    }

    /* ------------------------------- terminal ------------------------------- */
    if (path === '/api/term' && method === 'POST') {
      const opts = await readJson(req)
      const id = randomUUID()
      const handle = spawnTerminal(opts, {
        onData: (data) => {
          for (const client of wss.clients) {
            if (client.readyState === 1 && client.termId === id) {
              client.send(JSON.stringify({ t: 'd', d: data }))
            }
          }
        },
        onExit: (code) => {
          for (const client of wss.clients) {
            if (client.readyState === 1 && client.termId === id) {
              client.send(JSON.stringify({ t: 'x', code }))
            }
          }
          terminals.delete(id)
        },
      })
      terminals.set(id, handle)
      return sendJson(res, 200, { id })
    }

    /* ----------------------------- net (proxy) ------------------------------ */
    if (path === '/api/net/fetch' && method === 'POST') {
      const req2 = await readJson(req)
      const upstream = await fetch(req2.url, {
        method: req2.method || 'GET',
        headers: req2.headers,
        body: req2.body,
      })
      const headers = {}
      upstream.headers.forEach((v, k) => {
        headers[k] = v
      })
      const body = await upstream.text()
      return sendJson(res, 200, { status: upstream.status, statusText: upstream.statusText, headers, body })
    }

    if (path === '/api/net/stream' && method === 'POST') {
      const req2 = await readJson(req)
      sseHeaders(res)
      try {
        const upstream = await fetch(req2.url, {
          method: req2.method || 'POST',
          headers: req2.headers,
          body: req2.body,
        })
        if (!upstream.body) {
          res.write(`data: ${JSON.stringify({ chunk: await upstream.text() })}\n\n`)
          res.write(`data: ${JSON.stringify({ done: true, status: upstream.status, statusText: upstream.statusText })}\n\n`)
          res.end()
          return
        }
        const reader = upstream.body.getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(`data: ${JSON.stringify({ chunk: dec.decode(value, { stream: true }) })}\n\n`)
        }
        const tail = dec.decode()
        if (tail) res.write(`data: ${JSON.stringify({ chunk: tail })}\n\n`)
        res.write(`data: ${JSON.stringify({ done: true, status: upstream.status, statusText: upstream.statusText })}\n\n`)
        res.end()
      } catch (err) {
        res.write(`data: ${JSON.stringify({ done: true, status: 0, statusText: '', error: String(err) })}\n\n`)
        res.end()
      }
      return
    }

    /* ------------------------------- settings ------------------------------- */
    if (path === '/api/settings' && method === 'GET') {
      try {
        const raw = await fs.readFile(SETTINGS_FILE, 'utf8')
        return sendJson(res, 200, JSON.parse(raw))
      } catch {
        return sendJson(res, 200, {})
      }
    }

    if (path === '/api/settings' && method === 'POST') {
      const patch = await readJson(req)
      let current = {}
      try {
        current = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'))
      } catch {}
      const next = { ...current, ...patch }
      await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
      return sendJson(res, 200, next)
    }

    /* ----------------------------- project index ---------------------------- */
    if (path === '/api/project-index' && method === 'GET') {
      const root = url.searchParams.get('root') || ROOT
      return sendJson(res, 200, await projectIndexSnapshot(root))
    }

    if (path === '/api/project-index/rescan' && method === 'POST') {
      const { root } = await readJson(req)
      return sendJson(res, 200, await rescanProjectIndex(root || ROOT))
    }

    if (path === '/api/project-index/summaries' && method === 'POST') {
      const { root, items } = await readJson(req)
      await setFileSummaries(root || ROOT, items || [])
      return sendJson(res, 200, { ok: true })
    }

    return sendText(res, 404, 'not found')
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message || err) })
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (!url.pathname.startsWith('/api/term/ws')) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.termId = url.searchParams.get('id')
    ws.on('message', (raw) => {
      const handle = terminals.get(ws.termId)
      if (!handle) return
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t === 'i') handle.write(msg.d ?? '')
      else if (msg.t === 'r') handle.resize(msg.cols || 80, msg.rows || 24)
      else if (msg.t === 'k') handle.kill()
    })
    ws.on('close', () => {
      // Keep the pty alive; the tab close path kills it explicitly.
    })
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[kineticut] dev API server listening on http://0.0.0.0:${PORT} (root: ${ROOT})`)
  console.log(`[kineticut] node-pty: ${nodePty ? 'available' : 'not available (using fallback)'}`)
})
