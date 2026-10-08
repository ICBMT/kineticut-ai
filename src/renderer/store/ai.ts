import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { runAgent, type AgentToolEvent } from '../ai/agent'
import { streamChat } from '../ai/providers'
import type { AIMessage, AIStreamEvent, AIToolCall } from '../ai/types'
import {
  appendTrail,
  createActivity,
  fileBase,
  formatElapsed,
  statusLabel,
  summarizeToolResult,
  toolLabel,
  type ChatActivity,
  type TrailKind,
} from '../lib/activity'
import { currentBriefText } from '../lib/projectBrief'
import { retrieveContextForQuery } from '../lib/projectKnowledge'
import { useAppStore } from './app'
import { resolveChatModel, useSettingsStore } from './settings'

export interface ToolEventEntry {
  call: AIToolCall
  status: 'running' | 'done' | 'error'
  result?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: AIToolCall[]
  toolEvents?: ToolEventEntry[]
  pending?: boolean
  error?: string
  /** The model's reasoning trace, when the model streams one. */
  reasoning?: string
  /** Live (and final) record of what the assistant did for this turn. */
  activity?: ChatActivity
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string
  mode: 'chat' | 'agent'
  messages: ChatMessage[]
  createdAt: number
  /** The project the chat belongs to (null for chats from before projects were tracked). */
  folder?: string | null
}

/** How many chats the history keeps, and the storage budget for them (characters). */
const MAX_SESSIONS = 200
const STORE_BUDGET_CHARS = 3_500_000
const MAX_MESSAGES_PER_SESSION = 80

/** Keep the history small enough for storage: shorter tool results and reasoning. */
function slimMessage(m: ChatMessage): ChatMessage {
  return {
    ...m,
    reasoning: m.reasoning ? m.reasoning.slice(0, 2000) : undefined,
    toolEvents: m.toolEvents?.map((e) => ({ call: e.call, status: e.status })),
  }
}

/** Newest-first sessions that fit the storage budget. */
export function trimForStorage(sessions: ChatSession[]): ChatSession[] {
  const out: ChatSession[] = []
  let size = 0
  for (const s of sessions.slice(0, MAX_SESSIONS)) {
    const slim = { ...s, messages: s.messages.slice(-MAX_MESSAGES_PER_SESSION).map(slimMessage) }
    const cost = JSON.stringify(slim).length
    if (size + cost > STORE_BUDGET_CHARS) break
    size += cost
    out.push(slim)
  }
  return out
}

interface AIState {
  sessions: ChatSession[]
  activeId: string | null
  streaming: boolean
  abort: AbortController | null
  attach: { path: string; label: string; text: string } | null

  newSession(mode?: 'chat' | 'agent'): string
  setActive(id: string | null): void
  setMode(id: string, mode: 'chat' | 'agent'): void
  setAttach(a: { path: string; label: string; text: string } | null): void
  send(text: string): Promise<void>
  /** Re-generate the last assistant reply (answers the last user message again). */
  regenerate(): Promise<void>
  /** Replace a user message's text and re-answer from there. */
  editAndResend(messageId: string, text: string): Promise<void>
  /** Stream one assistant reply into `assistantId` for `query`. */
  runTurn(sessionId: string, assistantId: string, query: string): Promise<void>
  stop(): void
  clearActive(): void
  removeSession(id: string): void
  activeSession(): ChatSession | null
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function patchMessage(
  sessions: ChatSession[],
  sessionId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): ChatSession[] {
  return sessions.map((s) =>
    s.id === sessionId
      ? { ...s, messages: s.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }
      : s,
  )
}

function toAIMessage(m: ChatMessage): AIMessage {
  return {
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
  }
}

/**
 * Short live status of the reply currently in flight (any session), or null
 * when nothing is being generated. Used by the status bar.
 */
export function currentActivityLabel(s: Pick<AIState, 'sessions'>): string | null {
  for (const session of s.sessions) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m.role === 'assistant' && m.pending) {
        return m.activity ? statusLabel(m.activity) : 'Thinking…'
      }
    }
  }
  return null
}

function newAssistantMessage(): ChatMessage {
  const { model } = resolveChatModel(useSettingsStore.getState())
  return {
    id: uid(),
    role: 'assistant',
    content: '',
    pending: true,
    createdAt: Date.now(),
    activity: createActivity(model || undefined),
  }
}

export const useAIStore = create<AIState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeId: null,
      streaming: false,
      abort: null,
      attach: null,

      newSession: (mode = 'chat') => {
        const session: ChatSession = {
          id: uid(),
          title: '',
          mode,
          messages: [],
          createdAt: Date.now(),
          folder: useAppStore.getState().folder,
        }
        set((s) => ({ sessions: [session, ...s.sessions].slice(0, MAX_SESSIONS), activeId: session.id }))
        return session.id
      },

      setActive: (id) => set({ activeId: id }),
      setMode: (id, mode) =>
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === id ? { ...x, mode } : x)),
        })),
      setAttach: (a) => set({ attach: a }),

      activeSession: () => {
        const { sessions, activeId } = get()
        return sessions.find((s) => s.id === activeId) || null
      },

      send: async (text) => {
        if (get().streaming) return
        let session = get().activeSession()
        if (!session) {
          get().newSession('chat')
          session = get().activeSession()!
        }
        const sessionId = session.id
        const attach = get().attach
        const userContent = attach
          ? `${text}\n\n<attached-selection file="${attach.path}" label="${attach.label}">\n${attach.text.slice(0, 12000)}\n</attached-selection>`
          : text

        const userMsg: ChatMessage = {
          id: uid(),
          role: 'user',
          content: userContent,
          createdAt: Date.now(),
        }
        const assistantMsg = newAssistantMessage()
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === sessionId
              ? {
                  ...x,
                  messages: [...x.messages, userMsg, assistantMsg],
                  title: x.title || text.slice(0, 48),
                }
              : x,
          ),
          attach: null,
        }))
        await get().runTurn(sessionId, assistantMsg.id, userContent)
      },

      regenerate: async () => {
        if (get().streaming) return
        const session = get().activeSession()
        if (!session) return
        let idx = -1
        for (let i = session.messages.length - 1; i >= 0; i--) {
          if (session.messages[i].role === 'user') {
            idx = i
            break
          }
        }
        if (idx < 0) return
        const user = session.messages[idx]
        const assistantMsg = newAssistantMessage()
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === session.id ? { ...x, messages: [...x.messages.slice(0, idx + 1), assistantMsg] } : x,
          ),
        }))
        await get().runTurn(session.id, assistantMsg.id, user.content)
      },

      editAndResend: async (messageId, text) => {
        if (get().streaming) return
        const session = get().activeSession()
        if (!session) return
        const idx = session.messages.findIndex((m) => m.id === messageId)
        if (idx < 0 || session.messages[idx].role !== 'user') return
        // Keep the attached selection (if any) from the original message.
        const original = session.messages[idx].content
        const cut = original.indexOf('\n\n<attached-selection')
        const content = text.trim() + (cut >= 0 ? original.slice(cut) : '')
        const userMsg: ChatMessage = { ...session.messages[idx], content }
        const assistantMsg = newAssistantMessage()
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === session.id ? { ...x, messages: [...x.messages.slice(0, idx), userMsg, assistantMsg] } : x,
          ),
        }))
        await get().runTurn(session.id, assistantMsg.id, content)
      },

      /**
       * Stream one assistant reply into `assistantId`, answering `query`.
       * Shared by send, regenerate and edit-and-resend.
       */
      runTurn: async (sessionId, assistantId, query) => {
        const settings = useSettingsStore.getState()
        const mode = get().sessions.find((x) => x.id === sessionId)?.mode ?? 'chat'
        const { provider, model } = resolveChatModel(settings)
        if (!provider || !model) {
          const endedAt = Date.now()
          set((s) => ({
            sessions: patchMessage(s.sessions, sessionId, assistantId, {
              pending: false,
              error:
                'No AI model configured yet. Open Settings → Providers to connect Ollama (local) or add a frontier API key.',
              activity: {
                ...createActivity(),
                phase: 'error',
                endedAt,
                trail: [{ at: endedAt, text: 'No model configured', kind: 'err' }],
              },
            }),
          }))
          return
        }

        const controller = new AbortController()
        set({ streaming: true, abort: controller })

        const patch = (p: Partial<ChatMessage>) =>
          set((s) => ({ sessions: patchMessage(s.sessions, sessionId, assistantId, p) }))

        // This turn's live state. Every change is pushed to the message so the
        // chat UI (and the status bar) can show what the assistant is doing.
        let activity: ChatActivity = createActivity(model)
        let content = ''
        let reasoning = ''

        const update = (p: Partial<ChatActivity> = {}, extra: Partial<ChatMessage> = {}) => {
          activity = { ...activity, ...p }
          patch({ ...extra, activity })
        }
        const log = (text: string, kind: TrailKind = 'info', p: Partial<ChatActivity> = {}) =>
          update({ ...p, trail: appendTrail(activity.trail, { at: Date.now(), text, kind }) })

        const addReasoning = (t: string) => {
          if (!reasoning) log('Model is reasoning', 'info', { phase: 'thinking' })
          else if (activity.phase !== 'thinking') update({ phase: 'thinking' })
          reasoning += t
          patch({ reasoning })
        }

        const addText = (t: string) => {
          if (activity.phase !== 'writing') log('Writing the answer', 'ok', { phase: 'writing' })
          content += t
          update({ chars: content.length }, { content })
        }

        const finish = (outcome: 'done' | 'stopped' | 'error', error?: string) => {
          const took = formatElapsed(Date.now() - activity.startedAt)
          const outcomes = {
            done: { phase: 'done', text: `Finished in ${took}`, kind: 'ok' },
            stopped: { phase: 'stopped', text: `Stopped after ${took}`, kind: 'warn' },
            error: { phase: 'error', text: `Failed after ${took}`, kind: 'err' },
          } as const
          const o = outcomes[outcome]
          log(o.text, o.kind, { phase: o.phase, endedAt: Date.now(), currentTool: undefined })
          patch({ pending: false, ...(error ? { error } : {}) })
        }

        try {
          log('Searching the project knowledge base', 'info', { phase: 'context' })
          const current = get().sessions.find((x) => x.id === sessionId)
          const brief = currentBriefText()
          // Retrieve the specific files relevant to this question.
          const ctx = await retrieveContextForQuery(query)
          const more = ctx.files.length > 4 ? ` +${ctx.files.length - 4} more` : ''
          log(
            ctx.files.length
              ? `Pulled ${ctx.files.length} relevant file${ctx.files.length === 1 ? '' : 's'}: ${ctx.files.slice(0, 4).map(fileBase).join(', ')}${more}`
              : 'No indexed files matched — answering from the project brief',
            ctx.files.length ? 'ok' : 'info',
            { contextFiles: ctx.files },
          )

          const baseHistory: AIMessage[] = (current?.messages || [])
            .filter((m) => m.id !== assistantId && !m.pending)
            .map(toAIMessage)
          const systemParts: string[] = []
          if (brief) {
            systemParts.push(`Project context (the user's open workspace):\n${brief}`)
          }
          if (ctx.block) {
            systemParts.push(ctx.block)
          }
          const history: AIMessage[] = systemParts.length
            ? [{ role: 'system', content: systemParts.join('\n\n') }, ...baseHistory]
            : baseHistory

          log(`Sent to ${model}, waiting for the first token`, 'info', { phase: 'thinking', model })

          if (mode === 'agent') {
            const toolEvents: ToolEventEntry[] = []
            const onEvent = (evt: AIStreamEvent | AgentToolEvent) => {
              switch (evt.type) {
                case 'reasoning':
                  addReasoning(evt.text)
                  break
                case 'text':
                  addText(evt.text)
                  break
                case 'step_start':
                  log(
                    evt.step > 1
                      ? `Step ${evt.step} of ${evt.maxSteps}: reviewing the results`
                      : `Planning (step 1 of ${evt.maxSteps})`,
                    'info',
                    { phase: 'thinking', step: evt.step, maxSteps: evt.maxSteps },
                  )
                  break
                case 'tool_call': {
                  const prev =
                    get().sessions.find((x) => x.id === sessionId)?.messages.find((m) => m.id === assistantId)
                      ?.toolCalls || []
                  patch({ toolCalls: [...prev, evt.call] })
                  toolEvents.push({ call: evt.call, status: 'running' })
                  patch({ toolEvents: [...toolEvents] })
                  break
                }
                case 'tool_start': {
                  const idx = toolEvents.findIndex((e) => e.call.id === evt.call.id)
                  if (idx >= 0) {
                    toolEvents[idx] = { ...toolEvents[idx], status: 'running' }
                    patch({ toolEvents: [...toolEvents] })
                  }
                  const label = toolLabel(evt.call.arguments)
                  log(`${evt.call.name}${label ? ` ${label}` : ''}`, 'tool', {
                    phase: 'tool',
                    tools: activity.tools + 1,
                    currentTool: { id: evt.call.id, name: evt.call.name, label, startedAt: Date.now() },
                  })
                  break
                }
                case 'tool_end': {
                  const idx = toolEvents.findIndex((e) => e.call.id === evt.call.id)
                  if (idx >= 0) {
                    toolEvents[idx] = {
                      ...toolEvents[idx],
                      status: evt.error ? 'error' : 'done',
                      result: evt.result,
                    }
                    patch({ toolEvents: [...toolEvents] })
                  }
                  const label = toolLabel(evt.call.arguments)
                  const summary = summarizeToolResult(evt.call.name, evt.result, evt.error)
                  const opensFile =
                    Boolean(label) &&
                    !evt.error &&
                    (evt.call.name === 'read_file' || evt.call.name === 'list_dir')
                  const touchedFiles =
                    opensFile && !activity.touchedFiles.includes(label)
                      ? [...activity.touchedFiles, label]
                      : activity.touchedFiles
                  log(`${evt.call.name}${label ? ` ${label}` : ''} → ${summary}`, evt.error ? 'err' : 'ok', {
                    currentTool: undefined,
                    touchedFiles,
                  })
                  break
                }
                case 'error':
                  throw new Error(evt.error)
              }
            }
            await runAgent({
              provider,
              model,
              history,
              maxSteps: settings.agentMaxSteps,
              signal: controller.signal,
              onEvent,
            })
          } else {
            for await (const evt of streamChat({
              provider,
              model,
              messages: history,
              signal: controller.signal,
            })) {
              if (evt.type === 'reasoning') addReasoning(evt.text)
              else if (evt.type === 'text') addText(evt.text)
              else if (evt.type === 'error') throw new Error(evt.error)
            }
          }
          finish(controller.signal.aborted ? 'stopped' : 'done')
        } catch (err) {
          if (controller.signal.aborted) {
            finish('stopped')
          } else {
            finish('error', err instanceof Error ? err.message : String(err))
          }
        } finally {
          set({ streaming: false, abort: null })
        }
      },

      stop: () => {
        get().abort?.abort()
      },

      clearActive: () =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === s.activeId ? { ...x, messages: [], title: '' } : x,
          ),
        })),

      removeSession: (id) =>
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== id),
          activeId: s.activeId === id ? (s.sessions[0]?.id ?? null) : s.activeId,
        })),
    }),
    {
      name: 'kineticut.ai.v1',
      partialize: (s) => ({
        sessions: trimForStorage(s.sessions),
      }),
      // A launch starts with no active chat; the history is still there to resume.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as object),
        activeId: null,
      }),
    },
  ),
)
