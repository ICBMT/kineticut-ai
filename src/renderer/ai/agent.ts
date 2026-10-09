/**
 * Agent mode: a tool-use loop. The model can inspect the workspace, propose
 * file writes (reviewed in a diff modal) and run commands (with confirmation),
 * feeding results back until it produces a final answer.
 */
import { api } from '../api'
import { codeProfileLine, dirLine, recallFile } from '../lib/projectKnowledge'
import { languageForPath } from '../lib/languages'
import { joinPath, truncate } from '../lib/utils'
import { applyTextEdit } from '../lib/textEdit'
import { formatHits, searchCodebase } from '../lib/codebase'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { useSettingsStore } from '../store/settings'
import { MAX_STAGED_CHARS, stagedContent, useReviewStore } from '../store/review'
import { streamChat } from './providers'
import type {
  AIMessage,
  AIToolCall,
  AIToolDef,
  AIStreamEvent,
  ProviderConfig,
} from './types'

export const AGENT_TOOLS: AIToolDef[] = [
  {
    name: 'list_dir',
    description: 'List the entries of a directory in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file, or only the lines start_line to end_line (1-based, inclusive). Prefer a line range for large files: find the lines with codebase_search or grep_search first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
        start_line: { type: 'integer', description: 'First line to return (1-based).' },
        end_line: { type: 'integer', description: 'Last line to return (inclusive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codebase_search',
    description:
      'Search the whole codebase index by meaning and keywords (like Cursor codebase search). Returns the best matching code snippets with file and line ranges. Use it to find where something is implemented before reading files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in natural language or with identifiers.' },
        limit: { type: 'integer', description: 'Number of snippets (1-15). Default 8.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grep_search',
    description:
      'Exact text search across the workspace files, like grep (case-insensitive literal match). Use it for identifiers, strings, and exact usages. Files excluded by .gitignore or .cursorignore are skipped.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to search for.' },
        path: { type: 'string', description: 'Optional directory to restrict the search to.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'file_search',
    description:
      'Find project files by name or path fragment (fuzzy, like Cursor file search). Returns the best matching project paths. Use it to locate a file before reading it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A file name or part of a path, e.g. "codebase", "store/ai".' },
        limit: { type: 'integer', description: 'Maximum paths to return (1-50). Default 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Change part of an existing file by replacing exact text. Preferred for every change to an existing file: copy old_text exactly from the file (read it first) and give the new_text. The user reviews a diff before it is applied.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
        old_text: {
          type: 'string',
          description: 'The exact existing text to replace, including indentation. Must match once unless replace_all is true.',
        },
        new_text: { type: 'string', description: 'The text that replaces old_text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_text (default false).' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Read a web page as text: documentation, an API reference, a changelog. Use when the answer depends on something outside the workspace. The user is asked to confirm each address first.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full http or https address.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a text file in the workspace. The user is asked to confirm first. Use only when the user asked for the removal or it is clearly part of the task.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'rename_file',
    description:
      'Move or rename a text file. Fails if the destination exists. Imports and references elsewhere are not updated automatically: find them with grep_search and edit them.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current path (absolute or relative to the workspace root).' },
        to: { type: 'string', description: 'New path (absolute or relative to the workspace root).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'create_file',
    description:
      'Create a new file (parent folders are created). Fails if the file already exists: use edit_file to change an existing file. The user reviews the new file before it is written.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete content of the new file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'write_file',
    description:
      'Replace the entire content of a file. Use only for small files or a full rewrite; prefer edit_file for changes. The user reviews the change in a diff before it is applied.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace and return its output (non-interactive, 2 minute timeout).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'project_map',
    description:
      'Get the project map from project memory: what the project is for, its languages, frameworks and entry points, a digest of each directory, and a one-line summary of each file. Use it to navigate before reading files.',
    parameters: {
      type: 'object',
      properties: {
        maxFiles: { type: 'number', description: 'Maximum files to list (default 150).' },
      },
    },
  },
  {
    name: 'recall_file',
    description:
      'Recall any file from project memory at any moment: returns its full content straight from memory (no disk round trip) with its summary. Accepts a workspace-relative path or just a file name.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path (e.g. src/main/ipc.ts) or a file name.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'open_file',
    description: 'Open a file in the editor so the user can see it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
]

export const AGENT_SYSTEM_PROMPT = `You are Kineticut AI Agent, an expert software engineer working inside the user's code editor.
You know this project: its purpose, stack, directory map, relevant files and how they connect are in the project context below. You can read any file from project memory instantly with recall_file, and you can change the project.

How to work:
- Understand before you change. Use the project context, project_map, codebase_search and grep_search to find the code that already does something similar, and follow its pattern (naming, folder layout, how it is registered or wired up).
- To build a feature: plan the files in one short list, create the new files with create_file, then wire them into the existing code (routes, registries, imports, menus, commands) with edit_file.
- For library or API questions, read the official docs with fetch_url when the workspace does not answer them.
- To delete or rename a file, use delete_file or rename_file, then find and update references with grep_search and edit_file.
- To change an existing file, use edit_file with old_text copied exactly from the file. Keep old_text small but unique. Use write_file only for a small file or a full rewrite. Never guess file contents: recall_file or read_file first.
- To find code, call codebase_search first (it searches the whole project by meaning and keywords), then read only the lines you need with read_file start_line/end_line. Use grep_search for exact text and file_search to find a file by name.
- The user reviews every change. A write is either shown in a diff at once, or "staged" for one review at the end (the tool result says which). Staged changes are not on disk yet, but later reads and edits see them. If the user rejects a change, do not repeat it: explain the change and ask how to proceed.
- Verify when the project has a check (typecheck, tests, build): run it with run_command and fix what it reports. run_command is non-interactive only; never run destructive commands without asking first.
- Answer concisely at the end: what you created or changed (with file paths), what you verified, and what the user should check next.`

export type AgentToolEvent =
  | { type: 'step_start'; step: number; maxSteps: number }
  | { type: 'tool_start'; call: AIToolCall }
  | { type: 'tool_end'; call: AIToolCall; result: string; error?: boolean }

/** One file the agent actually wrote. `before` is null when the file was created. */
/** A file change the agent made. `after: null` means the file was deleted. */
export interface AgentWrite {
  path: string
  before: string | null
  after: string | null
}

export interface AgentRunArgs {
  provider: ProviderConfig
  model: string
  history: AIMessage[]
  maxSteps?: number
  signal?: AbortSignal
  /** Project brief about the open workspace, injected into the system prompt. */
  contextBrief?: string | null
  onEvent: (evt: AIStreamEvent | AgentToolEvent) => void
  /** Called after every write the user approved, so the turn can be undone. */
  onWrite?: (write: AgentWrite) => void
  /** The chat turn this run belongs to; staged changes are recorded against it. */
  review?: { sessionId: string; messageId: string }
}

/** Per-run context for the write tools. */
interface ToolContext {
  onWrite?: (write: AgentWrite) => void
  review?: { sessionId: string; messageId: string }
}

export async function runAgent(args: AgentRunArgs): Promise<void> {
  const { provider, model, history, maxSteps = 8, signal, contextBrief, onEvent, onWrite, review } = args
  const systemPrompt = contextBrief
    ? `${AGENT_SYSTEM_PROMPT}\n\nProject context (the user's open workspace):\n${contextBrief}`
    : AGENT_SYSTEM_PROMPT
  const messages: AIMessage[] = [{ role: 'system', content: systemPrompt }, ...history]

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return
    onEvent({ type: 'step_start', step: step + 1, maxSteps })
    const assistant: AIMessage = { role: 'assistant', content: '' }
    for await (const evt of streamChat({
      provider,
      model,
      messages,
      tools: AGENT_TOOLS,
      signal,
    })) {
      if (evt.type === 'text') {
        assistant.content += evt.text
        onEvent(evt)
      } else if (evt.type === 'reasoning') {
        onEvent(evt)
      } else if (evt.type === 'tool_call') {
        assistant.toolCalls = [...(assistant.toolCalls || []), evt.call]
        onEvent(evt)
      } else if (evt.type === 'error') {
        onEvent(evt)
        return
      }
    }
    messages.push(assistant)
    if (!assistant.toolCalls?.length) return

    for (const call of assistant.toolCalls) {
      if (signal?.aborted) return
      onEvent({ type: 'tool_start', call })
      const { result, error } = await executeToolCall(call, { onWrite, review })
      onEvent({ type: 'tool_end', call, result, error })
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
    }
  }
}

/* ------------------------------ tool execution ----------------------------- */

/** Project-relative, forward-slash form of a search result path. */
function relFrom(file: string, folder: string | null): string {
  let f = String(file).replace(/\\/g, '/').replace(/^\.\//, '')
  if (folder) {
    const root = folder.replace(/\\/g, '/').replace(/\/+$/, '')
    if (f.startsWith(`${root}/`)) f = f.slice(root.length + 1)
  }
  return f
}

/** Project paths the index keeps (ignore rules already applied), or null when no index is ready. */
async function indexedPaths(folder: string | null): Promise<Set<string> | null> {
  if (!folder) return null
  const snap = await api.projectIndex.get(folder).catch(() => null)
  if (!snap) return null
  return new Set(snap.entries.map((e) => e.rel))
}

/** How well a query matches a project path (0 = not at all). Name matches rank first. */
export function fileNameScore(query: string, rel: string): number {
  const r = rel.toLowerCase()
  const base = r.slice(r.lastIndexOf('/') + 1)
  if (base === query) return 100
  if (base.startsWith(query)) return 80
  if (base.includes(query)) return 60
  if (r.includes(query)) return 45
  const words = query.split(/\s+/).filter(Boolean)
  if (words.length > 1 && words.every((w) => r.includes(w))) return 35
  // Characters in order inside the file name (fuzzy).
  let i = 0
  for (const ch of query.replace(/\s+/g, '')) {
    i = base.indexOf(ch, i)
    if (i < 0) return 0
    i++
  }
  return 15
}

async function executeToolCall(
  call: AIToolCall,
  ctx: ToolContext = {},
): Promise<{ result: string; error?: boolean }> {
  let args: any
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {
    return { result: 'Error: could not parse tool arguments as JSON.', error: true }
  }

  const app = useAppStore.getState()
  const folder = app.folder
  const resolvePath = (p: string) => (folder ? joinPath(folder, String(p)) : String(p))

  try {
    switch (call.name) {
      case 'list_dir': {
        const entries = await api.fs.list(resolvePath(args.path))
        const text =
          entries.map((e) => `${e.type === 'directory' ? '[dir] ' : '      '}${e.name}`).join('\n') ||
          '(empty directory)'
        return { result: truncate(text, 20000) }
      }
      case 'read_file': {
        const target = resolvePath(args.path)
        // Read what the agent has already proposed, so edits build on it.
        const staged = stagedContent(target)
        const content = staged !== undefined ? staged : null
        let text = content
        if (text === null) {
          const res = await api.fs.read(target)
          if (res.binary) return { result: 'Error: file is binary.', error: true }
          text = res.content
        }
        const from = Number(args.start_line)
        const to = Number(args.end_line)
        if (Number.isFinite(from) || Number.isFinite(to)) {
          const lines = text.split('\n')
          const a = Math.max(1, Number.isFinite(from) ? Math.floor(from) : 1)
          const b = Math.min(lines.length, Number.isFinite(to) ? Math.floor(to) : lines.length)
          if (a > lines.length) return { result: `Error: the file has ${lines.length} lines.`, error: true }
          const body = lines
            .slice(a - 1, b)
            .map((l, i) => `${a + i}: ${l}`)
            .join('\n')
          return { result: truncate(`${displayPath(target)} lines ${a}-${b} of ${lines.length}:\n${body}`, 60000) }
        }
        return { result: truncate(text, 60000) }
      }
      case 'codebase_search': {
        const query = String(args.query || '').trim()
        if (!query) return { result: 'Error: query is empty.', error: true }
        if (!folder) return { result: 'Error: no project is open.', error: true }
        const limit = Math.min(15, Math.max(1, Number(args.limit) || 8))
        const { hits, semantic } = await searchCodebase(folder, query, limit)
        if (hits.length === 0) return { result: 'No matching code in the index.' }
        const header = semantic ? 'Matches (keyword and meaning):' : 'Matches (keyword search):'
        return { result: truncate(`${header}\n\n${formatHits(hits, 40000)}`, 40000) }
      }
      case 'grep_search': {
        const query = String(args.query || '')
        if (!query.trim()) return { result: 'Error: query is empty.', error: true }
        const root = args.path ? resolvePath(args.path) : folder || '.'
        const indexed = await indexedPaths(folder)
        const results = await api.search.query(root, query, 400)
        const lines: string[] = []
        for (const r of results) {
          if (indexed && !indexed.has(relFrom(r.file, folder))) continue
          for (const h of r.hits.slice(0, 5)) {
            lines.push(`${relFrom(r.file, folder)}:${h.line}:${h.column}: ${h.text.trim().slice(0, 200)}`)
          }
          if (lines.length >= 120) break
        }
        return { result: truncate(lines.join('\n') || 'no matches', 20000) }
      }
      case 'file_search': {
        const query = String(args.query || '').trim().toLowerCase()
        if (!query) return { result: 'Error: query is empty.', error: true }
        if (!folder) return { result: 'Error: no project is open.', error: true }
        const snap = await api.projectIndex.get(folder).catch(() => null)
        if (!snap) return { result: 'Error: the project index is not ready yet.', error: true }
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
        const ranked = snap.entries
          .map((e) => ({ rel: e.rel, score: fileNameScore(query, e.rel) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
          .slice(0, limit)
        return { result: ranked.length ? ranked.map((x) => x.rel).join('\n') : `No project files match "${query}".` }
      }
      case 'write_file': {
        const target = resolvePath(args.path)
        const content = String(args.content ?? '')
        const prior = await readCurrent(target, true)
        return proposeWrite(target, prior ?? '', prior, content, 'Agent wants to write a file', ctx)
      }
      case 'edit_file': {
        const target = resolvePath(args.path)
        const current = await readCurrent(target, true)
        if (current === null) {
          return { result: `Error: ${args.path} does not exist. Use create_file for a new file.`, error: true }
        }
        const edit = applyTextEdit(current, String(args.old_text ?? ''), String(args.new_text ?? ''), args.replace_all === true)
        if (!edit.ok) return { result: `Error: ${edit.reason}`, error: true }
        const outcome = await proposeWrite(target, current, current, edit.content, 'Agent wants to edit a file', ctx)
        if (outcome.error) return outcome
        return { result: `Edited ${args.path}: ${edit.replacements} replacement${edit.replacements === 1 ? '' : 's'}.` }
      }
      case 'create_file': {
        const target = resolvePath(args.path)
        const existing = await readCurrent(target, true)
        if (existing !== null) {
          return {
            result: `Error: ${args.path} already exists. Use edit_file to change it, or write_file for a full rewrite.`,
            error: true,
          }
        }
        return proposeWrite(target, '', null, String(args.content ?? ''), 'Agent wants to create a file', ctx)
      }
      case 'fetch_url': {
        const url = String(args.url || '').trim()
        if (!useSettingsStore.getState().agentAutoApprove) {
          const ok = await new Promise<boolean>((resolve) => {
            app.requestConfirm({
              title: 'Read a web page',
              message: url,
              detail: 'The AI agent wants to read this page and use its text in the answer.',
              confirmLabel: 'Read',
              resolve,
            })
          })
          if (!ok) return { result: 'The user did not allow reading this page.', error: true }
        }
        try {
          const page = await api.web.fetch(url)
          const head = `${page.title ? `${page.title} — ` : ''}${page.url} (${page.contentType})`
          const note = page.truncated ? '\n[The page is longer; only the start is shown.]' : ''
          return { result: truncate(`${head}\n\n${page.text}${note}`, 14000) }
        } catch (err) {
          return { result: `Error: ${err instanceof Error ? err.message : String(err)}`, error: true }
        }
      }
      case 'delete_file': {
        const target = resolvePath(args.path)
        const check = await removable(target)
        if (!check.ok) return { result: check.error, error: true }
        const ok = await new Promise<boolean>((resolve) => {
          app.requestConfirm({
            title: 'Delete file',
            message: displayPath(target),
            detail: 'The AI agent wants to delete this file. Undo in the chat can restore it.',
            confirmLabel: 'Delete',
            resolve,
          })
        })
        if (!ok) return { result: 'The user rejected deleting this file.', error: true }
        await api.fs.remove(target)
        ctx.onWrite?.({ path: target, before: check.content, after: null })
        return { result: `Deleted ${displayPath(target)}` }
      }
      case 'rename_file': {
        const from = resolvePath(args.from)
        const to = resolvePath(args.to)
        const check = await removable(from)
        if (!check.ok) return { result: check.error, error: true }
        if ((await readCurrent(to, true)) !== null) {
          return { result: `Error: ${args.to} already exists. Choose another name.`, error: true }
        }
        if (!useSettingsStore.getState().agentAutoApprove) {
          const ok = await new Promise<boolean>((resolve) => {
            app.requestConfirm({
              title: 'Rename file',
              message: `${displayPath(from)} → ${displayPath(to)}`,
              detail: 'The AI agent wants to move this file.',
              confirmLabel: 'Rename',
              resolve,
            })
          })
          if (!ok) return { result: 'The user rejected this rename.', error: true }
        }
        await api.fs.rename(from, to)
        ctx.onWrite?.({ path: from, before: check.content, after: null })
        ctx.onWrite?.({ path: to, before: null, after: check.content })
        return { result: `Renamed ${displayPath(from)} to ${displayPath(to)}` }
      }
      case 'run_command': {
        const command = String(args.command || '')
        const settings = useSettingsStore.getState()
        if (!settings.agentAutoApprove) {
          const ok = await new Promise<boolean>((resolve) => {
            app.requestConfirm({
              title: 'Run command',
              message: `$ ${command}`,
              detail: 'The AI agent wants to run this command in the workspace.',
              confirmLabel: 'Run',
              resolve,
            })
          })
          if (!ok) return { result: 'The user rejected this command.', error: true }
        }
        const res = await api.system.exec(command, { cwd: folder || undefined, timeoutMs: 120000 })
        const output = `$ ${command}\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}\n[exit code ${res.code}]`
        return { result: truncate(output, 20000) }
      }
      case 'project_map': {
        const folder = app.folder
        if (!folder) return { result: 'Error: no workspace folder.', error: true }
        const snap = await api.projectIndex.get(folder)
        const all = [...(snap.entries || [])].sort(
          (a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel),
        )
        const max = Math.min(Number(args.maxFiles) || 150, 400)
        const summarized = all.filter((e) => e.summary).length
        const dirs = (snap.dirs || []).filter((d) => d.depth <= 2).slice(0, 30).map(dirLine)
        const files = all
          .slice(0, max)
          .map((e) => `- ${e.rel} (${e.language})${e.summary ? `: ${e.summary}` : ''}`)
        const lines = [
          `Project: ${snap.name} (${snap.fileCount} files)`,
          snap.purpose ? `Purpose: ${snap.purpose}` : '',
          codeProfileLine(snap),
          `Understood: ${summarized}/${all.length} files have summaries`,
          '',
          'Directories:',
          ...dirs,
          '',
          'Files:',
          ...files,
        ].filter((l) => l !== '')
        return { result: truncate(lines.join('\n'), 20000) }
      }
      case 'recall_file': {
        const folder = app.folder
        if (!folder) return { result: 'Error: no workspace folder.', error: true }
        const res = await recallFile(folder, String(args.path || args.name || ''))
        if (!res.ok) return { result: `Error: ${res.message}`, error: true }
        const f = res.file
        if (f.binary) {
          return { result: `${f.rel} is a binary file (${f.size} bytes); its content cannot be shown.` }
        }
        const header = [
          `File: ${f.rel} (${f.language}, ${f.size} bytes, from ${f.source === 'memory' ? 'project memory' : 'disk'})`,
          f.summary ? `Summary: ${f.summary}` : '',
          f.truncated ? '[content truncated]' : '',
        ].filter(Boolean)
        return { result: `${header.join('\n')}\n\n${f.content}` }
      }
      case 'open_file': {
        const target = resolvePath(args.path)
        useEditorStore.getState().openTab(target)
        return { result: `Opened ${args.path}` }
      }
      default:
        return { result: `Error: unknown tool "${call.name}".`, error: true }
    }
  } catch (err) {
    return { result: `Error: ${err instanceof Error ? err.message : String(err)}`, error: true }
  }
}

/* ------------------------------- file writes ------------------------------- */

/**
 * The current text of a file, or '' (or null with `missingAsNull`) when it does
 * not exist yet. Binary files read as empty text: the agent cannot edit them.
 */
/**
 * Whether a file can be deleted or renamed and still be undone: it must exist,
 * be text (binary content cannot be stored for undo), and have no staged review change.
 */
async function removable(target: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (stagedContent(target) !== undefined) {
    return { ok: false, error: `Error: ${displayPath(target)} has changes waiting in the review. Resolve them first.` }
  }
  try {
    const res = await api.fs.read(target)
    if (res.binary) {
      return { ok: false, error: `Error: ${displayPath(target)} is a binary file. Ask the user to remove it by hand.` }
    }
    return { ok: true, content: res.content }
  } catch {
    return { ok: false, error: `Error: ${displayPath(target)} does not exist.` }
  }
}

async function readCurrent(target: string, missingAsNull = false): Promise<string | null> {
  // A file the agent already changed in this review reads as its staged text.
  const staged = stagedContent(target)
  if (staged !== undefined) return staged
  try {
    const res = await api.fs.read(target)
    return res.binary ? '' : res.content
  } catch {
    return missingAsNull ? null : ''
  }
}

/**
 * Show the proposed content as a diff and write it once the user accepts. With
 * auto-approve on, it is written straight away. Every write path goes through
 * here, so the review rule cannot be bypassed by a tool.
 */
async function proposeWrite(
  target: string,
  current: string,
  before: string | null,
  content: string,
  title: string,
  ctx: ToolContext = {},
): Promise<{ result: string; error?: boolean }> {
  const app = useAppStore.getState()
  const settings = useSettingsStore.getState()
  if (settings.agentAutoApprove) {
    await api.fs.write(target, content)
    ctx.onWrite?.({ path: target, before, after: content })
    return { result: `Wrote ${displayPath(target)} (${content.length} bytes)` }
  }
  // Review at the end: stage the change and keep going. The user accepts or
  // rejects every staged file and hunk together, so the agent never waits on a dialog.
  if (
    settings.agentReview === 'batch' &&
    ctx.review &&
    content.length <= MAX_STAGED_CHARS
  ) {
    useReviewStore.getState().stage({
      path: target,
      before,
      after: content,
      sessionId: ctx.review.sessionId,
      messageId: ctx.review.messageId,
    })
    return {
      result: `Staged ${displayPath(target)} for the user's review. It is not written yet: the user will accept or reject it together with the other staged changes. Keep going; later edits to this file build on the staged version.`,
    }
  }
  // The diff's Apply button calls onApply with what the user accepted (which
  // they may have edited in the diff) and then resolves true. Without onApply
  // the modal is read-only, so an agent write could never be approved.
  let written: string | null = null
  const approved = await new Promise<boolean>((resolve) => {
    app.requestDiff({
      path: target,
      original: current,
      modified: content,
      language: languageForPath(target),
      title,
      onApply: async (value) => {
        await api.fs.write(target, value)
        written = value
      },
      resolve,
    })
  })
  if (!approved || written === null) {
    return {
      result:
        'The user rejected this change. Do not retry the same change; explain what you wanted to change and ask how to proceed.',
      error: true,
    }
  }
  ctx.onWrite?.({ path: target, before, after: written as string })
  return { result: `Wrote ${displayPath(target)} (${(written as string).length} bytes)` }
}

function displayPath(target: string): string {
  return target.split(/[\\/]/).slice(-3).join('/')
}
