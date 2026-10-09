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
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { useSettingsStore } from '../store/settings'
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
    description: 'Read the full contents of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for text across all workspace files (grep).',
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
- Understand before you change. Use the project context, project_map and search_code to find the code that already does something similar, and follow its pattern (naming, folder layout, how it is registered or wired up).
- To build a feature: plan the files in one short list, create the new files with create_file, then wire them into the existing code (routes, registries, imports, menus, commands) with edit_file.
- To change an existing file, use edit_file with old_text copied exactly from the file. Keep old_text small but unique. Use write_file only for a small file or a full rewrite. Never guess file contents: recall_file or read_file first.
- Every write is reviewed by the user in a diff. If a write is rejected, do not repeat it: explain the change and ask how to proceed.
- Verify when the project has a check (typecheck, tests, build): run it with run_command and fix what it reports. run_command is non-interactive only; never run destructive commands without asking first.
- Answer concisely at the end: what you created or changed (with file paths), what you verified, and what the user should check next.`

export type AgentToolEvent =
  | { type: 'step_start'; step: number; maxSteps: number }
  | { type: 'tool_start'; call: AIToolCall }
  | { type: 'tool_end'; call: AIToolCall; result: string; error?: boolean }

export interface AgentRunArgs {
  provider: ProviderConfig
  model: string
  history: AIMessage[]
  maxSteps?: number
  signal?: AbortSignal
  /** Project brief about the open workspace, injected into the system prompt. */
  contextBrief?: string | null
  onEvent: (evt: AIStreamEvent | AgentToolEvent) => void
}

export async function runAgent(args: AgentRunArgs): Promise<void> {
  const { provider, model, history, maxSteps = 8, signal, contextBrief, onEvent } = args
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
      const { result, error } = await executeToolCall(call)
      onEvent({ type: 'tool_end', call, result, error })
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
    }
  }
}

/* ------------------------------ tool execution ----------------------------- */

async function executeToolCall(call: AIToolCall): Promise<{ result: string; error?: boolean }> {
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
        const res = await api.fs.read(resolvePath(args.path))
        if (res.binary) return { result: 'Error: file is binary.', error: true }
        return { result: truncate(res.content, 60000) }
      }
      case 'search_code': {
        const results = await api.search.query(
          folder || String(args.path || '.'),
          String(args.query || ''),
          200,
        )
        const lines: string[] = []
        for (const r of results.slice(0, 30)) {
          for (const h of r.hits.slice(0, 5)) {
            lines.push(`${r.file}:${h.line}:${h.column}: ${h.text.trim().slice(0, 200)}`)
          }
        }
        return { result: truncate(lines.join('\n') || 'no matches', 20000) }
      }
      case 'write_file': {
        const target = resolvePath(args.path)
        const content = String(args.content ?? '')
        const current = (await readCurrent(target)) ?? ''
        return proposeWrite(target, current, content, 'Agent wants to write a file')
      }
      case 'edit_file': {
        const target = resolvePath(args.path)
        const current = await readCurrent(target, true)
        if (current === null) {
          return { result: `Error: ${args.path} does not exist. Use create_file for a new file.`, error: true }
        }
        const edit = applyTextEdit(current, String(args.old_text ?? ''), String(args.new_text ?? ''), args.replace_all === true)
        if (!edit.ok) return { result: `Error: ${edit.reason}`, error: true }
        const outcome = await proposeWrite(target, current, edit.content, 'Agent wants to edit a file')
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
        return proposeWrite(target, '', String(args.content ?? ''), 'Agent wants to create a file')
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
async function readCurrent(target: string, missingAsNull = false): Promise<string | null> {
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
  content: string,
  title: string,
): Promise<{ result: string; error?: boolean }> {
  const app = useAppStore.getState()
  const settings = useSettingsStore.getState()
  if (settings.agentAutoApprove) {
    await api.fs.write(target, content)
    return { result: `Wrote ${displayPath(target)} (${content.length} bytes)` }
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
  return { result: `Wrote ${displayPath(target)} (${(written as string).length} bytes)` }
}

function displayPath(target: string): string {
  return target.split(/[\\/]/).slice(-3).join('/')
}
