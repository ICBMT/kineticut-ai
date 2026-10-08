/**
 * Agent mode: a tool-use loop. The model can inspect the workspace, propose
 * file writes (reviewed in a diff modal) and run commands (with confirmation),
 * feeding results back until it produces a final answer.
 */
import { api } from '../api'
import { languageForPath } from '../lib/languages'
import { joinPath, truncate } from '../lib/utils'
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
    name: 'write_file',
    description:
      'Write a file, replacing its entire content. The user reviews the change in a diff before it is applied. Provide the complete new file content.',
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
You help with any software task: exploring codebases, writing features, fixing bugs, refactoring, testing and running commands.

Rules:
- The workspace root is the user's opened folder. Prefer workspace-relative paths in tool calls.
- Inspect code with read_file / list_dir / search_code before editing. Never guess file contents.
- Prefer small, surgical changes. Preserve existing style and formatting.
- write_file replaces the ENTIRE file — always include the complete new content, not a fragment.
- run_command is for non-interactive commands only (builds, tests, scripts). Never run destructive commands without asking the user first in your reply.
- After finishing, summarize what you changed and suggest next steps. Be concise.`

export type AgentToolEvent =
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
        let current = ''
        try {
          const res = await api.fs.read(target)
          current = res.binary ? '' : res.content
        } catch {
          /* new file */
        }
        const settings = useSettingsStore.getState()
        if (settings.agentAutoApprove) {
          await api.fs.write(target, content)
        } else {
          const approved = await new Promise<boolean>((resolve) => {
            app.requestDiff({
              path: target,
              original: current,
              modified: content,
              language: languageForPath(target),
              title: 'Agent wants to write a file',
              resolve,
            })
          })
          if (!approved) {
            return {
              result:
                'The user rejected this write. Do not retry the same write; explain what you wanted to change and ask how to proceed.',
              error: true,
            }
          }
          await api.fs.write(target, content)
        }
        return { result: `Wrote ${args.path} (${content.length} bytes)` }
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
