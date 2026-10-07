import { create } from 'zustand'
import { api } from '../api'
import { DEFAULT_BASE_URLS, probeProvider } from '../ai/providers'
import type { ProviderConfig } from '../ai/types'

export type Theme = 'dark' | 'light'

const PERSIST_KEYS = [
  'providers',
  'activeProviderId',
  'chatModel',
  'inlineModel',
  'inlineCompletions',
  'agentAutoApprove',
  'agentMaxSteps',
  'theme',
  'editorFontSize',
  'wordWrap',
  'minimap',
] as const

export type ProviderStatus = 'unknown' | 'ok' | 'error'

export interface SettingsState {
  loaded: boolean
  providers: ProviderConfig[]
  activeProviderId: string | null
  chatModel: string | null
  inlineModel: string | null
  inlineCompletions: boolean
  agentAutoApprove: boolean
  agentMaxSteps: number
  theme: Theme
  editorFontSize: number
  wordWrap: boolean
  minimap: boolean
  providerStatus: Record<string, ProviderStatus>

  load(): Promise<void>
  persist(): void
  upsertProvider(p: ProviderConfig): void
  removeProvider(id: string): void
  setProviderStatus(id: string, status: ProviderStatus): void
  refreshProviderModels(id: string): Promise<string[]>
  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  loaded: false,
  providers: [],
  activeProviderId: null,
  chatModel: null,
  inlineModel: null,
  inlineCompletions: true,
  agentAutoApprove: false,
  agentMaxSteps: 8,
  theme: 'dark',
  editorFontSize: 13,
  wordWrap: false,
  minimap: true,
  providerStatus: {},

  load: async () => {
    const bag = await api.settings.get()
    let providers = Array.isArray(bag.providers) ? (bag.providers as ProviderConfig[]) : []
    if (providers.length === 0) {
      providers = [
        {
          id: 'ollama-local',
          type: 'ollama',
          name: 'Ollama (local)',
          baseUrl: DEFAULT_BASE_URLS.ollama,
          models: [],
        },
      ]
    }
    set({
      loaded: true,
      providers,
      activeProviderId: (bag.activeProviderId as string) || providers[0]?.id || null,
      chatModel: (bag.chatModel as string) || null,
      inlineModel: (bag.inlineModel as string) || null,
      inlineCompletions: bag.inlineCompletions !== false,
      agentAutoApprove: bag.agentAutoApprove === true,
      agentMaxSteps: (bag.agentMaxSteps as number) || 8,
      theme: bag.theme === 'light' ? 'light' : 'dark',
      editorFontSize: (bag.editorFontSize as number) || 13,
      wordWrap: bag.wordWrap === true,
      minimap: bag.minimap !== false,
    })
    applyTheme(get().theme)
    // Probe providers in the background to discover models.
    for (const p of providers) void get().refreshProviderModels(p.id)
  },

  persist: () => {
    const s = get()
    const patch: Record<string, unknown> = {}
    for (const key of PERSIST_KEYS) patch[key] = s[key]
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void api.settings.set(patch)
    }, 300)
  },

  upsertProvider: (p) => {
    set((s) => {
      const exists = s.providers.some((x) => x.id === p.id)
      const providers = exists
        ? s.providers.map((x) => (x.id === p.id ? p : x))
        : [...s.providers, p]
      return { providers, activeProviderId: s.activeProviderId || p.id }
    })
    get().persist()
    void get().refreshProviderModels(p.id)
  },

  removeProvider: (id) => {
    set((s) => ({
      providers: s.providers.filter((x) => x.id !== id),
      activeProviderId: s.activeProviderId === id ? (s.providers[0]?.id ?? null) : s.activeProviderId,
    }))
    get().persist()
  },

  setProviderStatus: (id, status) =>
    set((s) => ({ providerStatus: { ...s.providerStatus, [id]: status } })),

  refreshProviderModels: async (id) => {
    const p = get().providers.find((x) => x.id === id)
    if (!p) return []
    set((s) => ({ providerStatus: { ...s.providerStatus, [id]: 'unknown' } }))
    const res = await probeProvider(p)
    if (res.ok && res.models) {
      set((s) => ({
        providerStatus: { ...s.providerStatus, [id]: 'ok' },
        providers: s.providers.map((x) => (x.id === id ? { ...x, models: res.models! } : x)),
      }))
      get().persist()
      return res.models
    }
    set((s) => ({ providerStatus: { ...s.providerStatus, [id]: 'error' } }))
    return p.models
  },

  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>)
    get().persist()
    if (key === 'theme') applyTheme(value as Theme)
  },
}))

/** Split a "providerId::model" reference. */
export function parseModelRef(
  ref: string | null | undefined,
  providers: ProviderConfig[],
): { provider: ProviderConfig | null; model: string | null } {
  if (!ref) return { provider: null, model: null }
  const idx = ref.indexOf('::')
  if (idx < 0) return { provider: null, model: ref }
  const providerId = ref.slice(0, idx)
  const model = ref.slice(idx + 2)
  return { provider: providers.find((p) => p.id === providerId) || null, model }
}

export function formatModelRef(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/** Best-effort chat model: explicit choice → active provider's first model → any model. */
export function resolveChatModel(
  state: SettingsState,
): { provider: ProviderConfig | null; model: string | null } {
  const explicit = parseModelRef(state.chatModel, state.providers)
  if (explicit.provider && explicit.model) return explicit
  const active = state.providers.find((p) => p.id === state.activeProviderId) || state.providers[0]
  if (active && active.models.length > 0) return { provider: active, model: active.models[0] }
  return { provider: active || null, model: null }
}

export function resolveInlineModel(
  state: SettingsState,
): { provider: ProviderConfig | null; model: string | null } {
  const explicit = parseModelRef(state.inlineModel, state.providers)
  if (explicit.provider && explicit.model) return explicit
  const active = state.providers.find((p) => p.id === state.activeProviderId) || state.providers[0]
  if (active && active.models.length > 0) return { provider: active, model: active.models[0] }
  return { provider: active || null, model: null }
}
