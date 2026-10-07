import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { runAgent, type AgentToolEvent } from '../ai/agent'
import { streamChat } from '../ai/providers'
import type { AIMessage, AIStreamEvent, AIToolCall } from '../ai/types'
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
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string
  mode: 'chat' | 'agent'
  messages: ChatMessage[]
  createdAt: number
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
        }
        set((s) => ({ sessions: [session, ...s.sessions].slice(0, 30), activeId: session.id }))
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
        const settings = useSettingsStore.getState()
        let session = get().activeSession()
        if (!session) {
          const id = get().newSession('chat')
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
        const assistantMsg: ChatMessage = {
          id: uid(),
          role: 'assistant',
          content: '',
          pending: true,
          createdAt: Date.now(),
        }
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

        const { provider, model } = resolveChatModel(settings)
        if (!provider || !model) {
          set((s) => ({
            sessions: patchMessage(s.sessions, sessionId, assistantMsg.id, {
              pending: false,
              error:
                'No AI model configured yet. Open Settings → Providers to connect Ollama (local) or add a frontier API key.',
            }),
          }))
          return
        }

        const controller = new AbortController()
        set({ streaming: true, abort: controller })

        const current = get().activeSession()
        const history: AIMessage[] = (current?.messages || [])
          .filter((m) => m.id !== assistantMsg.id && !m.pending)
          .map(toAIMessage)

        const patch = (p: Partial<ChatMessage>) =>
          set((s) => ({ sessions: patchMessage(s.sessions, sessionId, assistantMsg.id, p) }))

        try {
          if (session.mode === 'agent') {
            let content = ''
            const toolEvents: ToolEventEntry[] = []
            const onEvent = (evt: AIStreamEvent | AgentToolEvent) => {
              if (evt.type === 'text') {
                content += evt.text
                patch({ content })
              } else if (evt.type === 'tool_call') {
                set((s) => ({
                  sessions: patchMessage(s.sessions, sessionId, assistantMsg.id, {
                    toolCalls: [...(s.sessions.find((x) => x.id === sessionId)?.messages.find((m) => m.id === assistantMsg.id)?.toolCalls || []), evt.call],
                  }),
                }))
                toolEvents.push({ call: evt.call, status: 'running' })
                patch({ toolEvents: [...toolEvents] })
              } else if (evt.type === 'tool_start') {
                const idx = toolEvents.findIndex((e) => e.call.id === evt.call.id)
                if (idx >= 0) {
                  toolEvents[idx] = { ...toolEvents[idx], status: 'running' }
                  patch({ toolEvents: [...toolEvents] })
                }
              } else if (evt.type === 'tool_end') {
                const idx = toolEvents.findIndex((e) => e.call.id === evt.call.id)
                if (idx >= 0) {
                  toolEvents[idx] = {
                    ...toolEvents[idx],
                    status: evt.error ? 'error' : 'done',
                    result: evt.result,
                  }
                  patch({ toolEvents: [...toolEvents] })
                }
              } else if (evt.type === 'error') {
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
            patch({ pending: false, content })
          } else {
            let content = ''
            for await (const evt of streamChat({
              provider,
              model,
              messages: history,
              signal: controller.signal,
            })) {
              if (evt.type === 'text') {
                content += evt.text
                patch({ content })
              } else if (evt.type === 'error') {
                throw new Error(evt.error)
              }
            }
            patch({ pending: false, content })
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            patch({
              pending: false,
              error: err instanceof Error ? err.message : String(err),
            })
          } else {
            patch({ pending: false })
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
        sessions: s.sessions.slice(0, 20).map((x) => ({
          ...x,
          messages: x.messages.slice(-40),
        })),
        activeId: s.activeId,
      }),
    },
  ),
)
