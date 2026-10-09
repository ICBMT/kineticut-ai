import { useState } from 'react'
import {
  Check,
  Cloud,
  Download,
  FileCode,
  Globe,
  KeyRound,
  Monitor,
  PanelLeft,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import { DEFAULT_BASE_URLS, PROVIDER_LABELS, probeProvider, pullOllamaModel } from '../ai/providers'
import type { ProviderConfig, ProviderType } from '../ai/types'
import { ACCENTS, ACCENT_IDS, EDITOR_FONTS, type EditorFontId } from '../lib/accents'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useSettingsStore } from '../store/settings'
import { ModelSelect } from './ModelSelect'
import { EmptyState, IconButton, Segmented, Spinner, Toggle } from './ui'

/* ------------------------------ provider form ------------------------------- */

interface FormState {
  id?: string
  type: ProviderType
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
}

function ProviderForm({
  initial,
  onClose,
}: {
  initial: ProviderConfig | null
  onClose(): void
}) {
  const upsert = useSettingsStore((s) => s.upsertProvider)
  const [type, setType] = useState<ProviderType>(initial?.type || 'ollama')
  const [name, setName] = useState(initial?.name || '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || DEFAULT_BASE_URLS[initial?.type || 'ollama'])
  const [apiKey, setApiKey] = useState(initial?.apiKey || '')
  const [models, setModels] = useState<string[]>(initial?.models || [])
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchModels = async () => {
    setFetching(true)
    setError(null)
    const probe: ProviderConfig = {
      id: initial?.id || 'new',
      type,
      name: name || PROVIDER_LABELS[type],
      baseUrl,
      apiKey: apiKey || undefined,
      models: [],
    }
    const res = await probeProvider(probe)
    setFetching(false)
    if (res.ok && res.models) {
      setModels(res.models)
    } else {
      setError(res.error || 'Could not reach provider')
    }
  }

  const save = () => {
    upsert({
      id: initial?.id || `provider-${Date.now().toString(36)}`,
      type,
      name: name || PROVIDER_LABELS[type],
      baseUrl,
      apiKey: apiKey || undefined,
      models,
    })
    onClose()
  }

  return (
    <div className="card flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="field-label">Type</label>
          <select
            className="field-input"
            value={type}
            onChange={(e) => {
              const t = e.target.value as ProviderType
              setType(t)
              setBaseUrl(DEFAULT_BASE_URLS[t])
            }}
          >
            <option value="ollama">Ollama (local)</option>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </div>
        <div>
          <label className="field-label">Name</label>
          <input
            className="field-input"
            value={name}
            placeholder={PROVIDER_LABELS[type]}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="field-label">Base URL</label>
        <input
          className="field-input font-mono !text-xs"
          value={baseUrl}
          placeholder={DEFAULT_BASE_URLS[type]}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
      {type !== 'ollama' && (
        <div>
          <label className="field-label">API key</label>
          <input
            className="field-input font-mono !text-xs"
            type="password"
            value={apiKey}
            placeholder="sk-…"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <button className="btn !py-1.5 text-xs" disabled={fetching} onClick={() => void fetchModels()}>
          {fetching ? <Spinner size={12} /> : <RefreshCw size={12} />}
          {fetching ? 'Fetching…' : 'Fetch models'}
        </button>
        {models.length > 0 && (
          <span className="text-[11px] text-[var(--text-faint)]">{models.length} models found</span>
        )}
      </div>
      {error && <div className="text-[11px] text-[var(--red)]">{error}</div>}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.slice(0, 24).map((m) => (
            <span
              key={m}
              className="tool-chip !font-sans !text-[10.5px]"
              title={m}
            >
              {m.length > 28 ? m.slice(0, 28) + '…' : m}
            </span>
          ))}
          {models.length > 24 && (
            <span className="tool-chip !font-sans">+{models.length - 24} more</span>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button className="btn !py-1.5 text-xs" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary !py-1.5 text-xs" onClick={save}>
          <Check size={12} />
          Save provider
        </button>
      </div>
    </div>
  )
}

/* ------------------------------ ollama pull --------------------------------- */

function PullModel({ provider }: { provider: ProviderConfig }) {
  const refresh = useSettingsStore((s) => s.refreshProviderModels)
  const [name, setName] = useState('')
  const [pulling, setPulling] = useState(false)
  const [progress, setProgress] = useState<{ completed: number; total: number; status: string } | null>(null)

  const pull = async () => {
    const model = name.trim()
    if (!model || pulling) return
    setPulling(true)
    setProgress(null)
    try {
      await pullOllamaModel(provider, model, (p) => setProgress(p))
      useAppStore.getState().toast({ kind: 'success', title: `Pulled ${model}` })
      await refresh(provider.id)
    } catch (err) {
      useAppStore.getState().toast({
        kind: 'error',
        title: 'Pull failed',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setPulling(false)
      setProgress(null)
      setName('')
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <input
          className="field-input !text-xs !py-1.5 font-mono flex-1"
          placeholder="model to pull, e.g. qwen2.5-coder:7b"
          value={name}
          disabled={pulling}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void pull()
          }}
        />
        <button className="btn !py-1.5 text-xs" disabled={pulling || !name.trim()} onClick={() => void pull()}>
          {pulling ? <Spinner size={12} /> : <Download size={12} />}
          Pull
        </button>
      </div>
      {progress && (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 w-full rounded-full bg-[var(--bg-hover)] overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] transition-all"
              style={{
                width: progress.total > 0 ? `${Math.min(100, (progress.completed / progress.total) * 100)}%` : '30%',
              }}
            />
          </div>
          <div className="text-[10px] text-[var(--text-faint)] font-mono">
            {progress.status} —{' '}
            {progress.total > 0
              ? `${(progress.completed / 1024 / 1024).toFixed(0)} / ${(progress.total / 1024 / 1024).toFixed(0)} MB`
              : '…'}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ provider card ------------------------------- */

const TYPE_ICONS: Record<ProviderType, LucideIcon> = {
  ollama: Server,
  openai: Cloud,
  anthropic: Sparkles,
  gemini: Globe,
}

function ProviderCard({ provider }: { provider: ProviderConfig }) {
  const settings = useSettingsStore()
  const [editing, setEditing] = useState(false)
  const status = settings.providerStatus[provider.id] || 'unknown'
  const TypeIcon = TYPE_ICONS[provider.type]

  if (editing) {
    return (
      <ProviderForm
        initial={provider}
        onClose={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="card flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <TypeIcon size={15} className="shrink-0 text-[var(--accent)]" />
        <span className="text-[13px] font-semibold flex-1 truncate">{provider.name}</span>
        <span
          className="sb-dot"
          title={status === 'ok' ? 'Connected' : status === 'error' ? 'Connection failed' : 'Unknown'}
          style={{
            background:
              status === 'ok' ? 'var(--green)' : status === 'error' ? 'var(--red)' : 'var(--text-faint)',
          }}
        />
      </div>
      <div className="text-[10.5px] text-[var(--text-faint)] font-mono truncate">{provider.baseUrl}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="tool-chip !font-sans">{PROVIDER_LABELS[provider.type]}</span>
        <span className="text-[10.5px] text-[var(--text-faint)]">
          {provider.models.length > 0 ? `${provider.models.length} models` : 'no models'}
        </span>
      </div>
      <div className="flex items-center gap-1 mt-1">
        <button className="btn !py-1 text-[11px]" onClick={() => settings.refreshProviderModels(provider.id)}>
          <RefreshCw size={11} />
          Refresh
        </button>
        <button className="btn !py-1 text-[11px]" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          className="btn btn-danger !py-1 text-[11px]"
          onClick={() => settings.removeProvider(provider.id)}
        >
          <Trash2 size={11} />
          Remove
        </button>
      </div>
      {provider.type === 'ollama' && <PullModel provider={provider} />}
    </div>
  )
}

/* -------------------------------- sections ---------------------------------- */

function SectionTitle({ icon: Icon, title, desc }: { icon: LucideIcon; title: string; desc?: string }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-5 first:mt-0">
      <Icon size={14} className="text-[var(--accent)]" />
      <div>
        <div className="text-[12px] font-semibold">{title}</div>
        {desc && <div className="text-[10.5px] text-[var(--text-faint)]">{desc}</div>}
      </div>
    </div>
  )
}

function SettingRow({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="min-w-0">
        <div className="setting-title">{title}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl+P', 'Quick open file'],
  ['Ctrl+Shift+P', 'Command palette'],
  ['Ctrl+S', 'Save'],
  ['Ctrl+`', 'Toggle terminal'],
  ['Ctrl+B', 'Toggle sidebar'],
  ['Ctrl+I', 'Explain code with AI'],
  ['Ctrl+Shift+A', 'Toggle agent mode'],
  ['Tab', 'Accept inline completion'],
]

export function SettingsPanel() {
  const settings = useSettingsStore()
  const [adding, setAdding] = useState(false)

  return (
    <div className="sidebar-inner">
      <div className="panel-header">
        <span>Settings</span>
      </div>
      <div className="sidebar-scroll px-3">
        <SectionTitle
          icon={Cloud}
          title="AI Providers"
          desc="Local models via Ollama, frontier models via API keys."
        />
        <div className="flex flex-col gap-2">
          {settings.providers.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
          {adding ? (
            <ProviderForm initial={null} onClose={() => setAdding(false)} />
          ) : (
            <button
              className="btn w-full !py-2 text-xs border-dashed"
              onClick={() => setAdding(true)}
            >
              <Plus size={13} />
              Add provider
            </button>
          )}
        </div>

        <SectionTitle icon={Wand2} title="AI" desc="Models and agent behavior." />
        <div className="card">
          <div className="flex flex-col gap-3">
            <div>
              <div className="setting-title mb-1.5">Default chat model</div>
              <ModelSelect kind="chat" />
            </div>
            <div>
              <div className="setting-title mb-1.5">Inline completion model</div>
              <ModelSelect kind="inline" />
            </div>
            <SettingRow
              title="Inline completions"
              desc="Show AI ghost-text completions as you type (Tab to accept)."
            >
              <Toggle
                on={settings.inlineCompletions}
                onChange={(v) => settings.set('inlineCompletions', v)}
                label="Inline completions"
              />
            </SettingRow>
            <SettingRow
              title="Agent auto-approve"
              desc="Apply agent file edits and commands without asking each time."
            >
              <Toggle
                on={settings.agentAutoApprove}
                onChange={(v) => settings.set('agentAutoApprove', v)}
                label="Agent auto-approve"
              />
            </SettingRow>
            <SettingRow
              title="Review agent changes"
              desc="Review at the end stages every agent write and lets you accept or reject each file and hunk together. Each write shows its own diff."
            >
              <select
                className="field-input !w-44 !py-1 !text-xs"
                value={settings.agentReview}
                onChange={(e) => settings.set('agentReview', e.target.value as 'batch' | 'each')}
                aria-label="Review agent changes"
              >
                <option value="batch">Review at the end</option>
                <option value="each">Diff for each write</option>
              </select>
            </SettingRow>
            <SettingRow title="Agent max steps" desc="Maximum tool-use rounds per agent request.">
              <input
                className="field-input !w-20 !py-1 !text-xs text-center"
                type="number"
                min={2}
                max={30}
                value={settings.agentMaxSteps}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) settings.set('agentMaxSteps', Math.min(30, Math.max(2, n)))
                }}
              />
            </SettingRow>
          </div>
        </div>

        <SectionTitle icon={Monitor} title="Appearance" />
        <div className="card">
          <SettingRow title="Color theme">
            <Segmented
              value={settings.theme}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(v) => settings.set('theme', v)}
            />
          </SettingRow>
          <SettingRow title="Accent" desc="UI and editor accent color">
            <div className="flex gap-1.5">
              {ACCENT_IDS.map((id) => (
                <button
                  key={id}
                  title={ACCENTS[id].label}
                  onClick={() => settings.set('accent', id)}
                  className={cn(
                    'w-6 h-6 rounded-full border-2 transition-transform',
                    settings.accent === id
                      ? 'border-[var(--text)] scale-110'
                      : 'border-transparent opacity-70 hover:opacity-100',
                  )}
                  style={{
                    background: `linear-gradient(135deg, ${ACCENTS[id].accent}, ${ACCENTS[id].accent2})`,
                  }}
                />
              ))}
            </div>
          </SettingRow>
          <SettingRow title="UI density">
            <Segmented
              value={settings.density}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
              onChange={(v) => settings.set('density', v)}
            />
          </SettingRow>
          <SettingRow title="Animations" desc="Transitions and motion effects">
            <Toggle
              on={settings.animations}
              onChange={(v) => settings.set('animations', v)}
              label="Animations"
            />
          </SettingRow>
        </div>

        <SectionTitle icon={FileCode} title="Editor" />
        <div className="card">
          <SettingRow title="Font family">
            <select
              className="field-input !w-44 !py-1 !text-xs"
              value={settings.editorFontFamily}
              onChange={(e) =>
                settings.set('editorFontFamily', e.target.value as EditorFontId)
              }
            >
              {EDITOR_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title="Font size">
            <div className="flex items-center gap-1">
              <button
                className="btn !py-1 !px-2 text-xs"
                onClick={() => settings.set('editorFontSize', Math.max(9, settings.editorFontSize - 1))}
              >
                −
              </button>
              <span className="w-8 text-center text-xs font-mono">{settings.editorFontSize}</span>
              <button
                className="btn !py-1 !px-2 text-xs"
                onClick={() => settings.set('editorFontSize', Math.min(28, settings.editorFontSize + 1))}
              >
                +
              </button>
            </div>
          </SettingRow>
          <SettingRow title="Line height">
            <div className="flex items-center gap-1">
              <button
                className="btn !py-1 !px-2 text-xs"
                onClick={() =>
                  settings.set('editorLineHeight', Math.max(14, settings.editorLineHeight - 1))
                }
              >
                −
              </button>
              <span className="w-8 text-center text-xs font-mono">{settings.editorLineHeight}</span>
              <button
                className="btn !py-1 !px-2 text-xs"
                onClick={() =>
                  settings.set('editorLineHeight', Math.min(40, settings.editorLineHeight + 1))
                }
              >
                +
              </button>
            </div>
          </SettingRow>
          <SettingRow title="Word wrap">
            <Toggle
              on={settings.wordWrap}
              onChange={(v) => settings.set('wordWrap', v)}
              label="Word wrap"
            />
          </SettingRow>
          <SettingRow title="Minimap">
            <Toggle
              on={settings.minimap}
              onChange={(v) => settings.set('minimap', v)}
              label="Minimap"
            />
          </SettingRow>
          <SettingRow title="Format on save" desc="Run the language formatter when saving">
            <Toggle
              on={settings.formatOnSave}
              onChange={(v) => settings.set('formatOnSave', v)}
              label="Format on save"
            />
          </SettingRow>
          <SettingRow title="Auto save" desc="Save files automatically while you work (no formatting)">
            <Segmented
              value={settings.autoSave}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'afterDelay', label: 'After delay' },
                { value: 'onFocusChange', label: 'On focus change' },
              ]}
              onChange={(v) => settings.set('autoSave', v)}
            />
          </SettingRow>
          {settings.autoSave === 'afterDelay' && (
            <SettingRow title="Auto save delay" desc="How long to wait after you stop typing">
              <Segmented
                value={String(settings.autoSaveDelay)}
                options={[
                  { value: '500', label: '0.5s' },
                  { value: '1000', label: '1s' },
                  { value: '2000', label: '2s' },
                  { value: '5000', label: '5s' },
                ]}
                onChange={(v) => settings.set('autoSaveDelay', Number(v))}
              />
            </SettingRow>
          )}
        </div>

        <SectionTitle icon={PanelLeft} title="Layout" />
        <div className="card">
          <SettingRow title="Project sidebar position" desc="Explorer / search / git / settings">
            <Segmented
              value={settings.sidebarPosition}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(v) => settings.set('sidebarPosition', v)}
            />
          </SettingRow>
          <SettingRow title="AI chat sidebar position" desc="Shown side by side with the project sidebar">
            <Segmented
              value={settings.chatPosition}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(v) => settings.set('chatPosition', v)}
            />
          </SettingRow>
          <SettingRow title="Panel position" desc="Where the terminal panel lives">
            <Segmented
              value={settings.panelPosition}
              options={[
                { value: 'bottom', label: 'Bottom' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(v) => settings.set('panelPosition', v)}
            />
          </SettingRow>
          <SettingRow title="Split direction" desc="How split editor groups are arranged">
            <Segmented
              value={settings.splitDirection}
              options={[
                { value: 'horizontal', label: 'Side by side' },
                { value: 'vertical', label: 'Stacked' },
              ]}
              onChange={(v) => settings.set('splitDirection', v)}
            />
          </SettingRow>
        </div>

        <SectionTitle icon={KeyRound} title="Keyboard shortcuts" />
        <div className="card grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {SHORTCUTS.map(([combo, label]) => (
            <div key={combo} className="contents">
              <span className="font-mono text-[var(--text-faint)]">{combo}</span>
              <span className="text-[var(--text-dim)]">{label}</span>
            </div>
          ))}
        </div>

        <div className="h-4" />
      </div>
    </div>
  )
}
