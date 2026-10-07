import { useMemo } from 'react'
import { Check, ChevronDown, Settings2 } from 'lucide-react'
import { PROVIDER_LABELS } from '../ai/providers'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/app'
import { formatModelRef, useSettingsStore } from '../store/settings'
import { Dropdown, type MenuItem } from './ui'

/**
 * Provider/model picker. `kind` selects which setting the picker controls:
 * the chat model or the inline-completion model.
 */
export function ModelSelect({
  compact = false,
  kind = 'chat',
}: {
  compact?: boolean
  kind?: 'chat' | 'inline'
}) {
  const providers = useSettingsStore((s) => s.providers)
  const providerStatus = useSettingsStore((s) => s.providerStatus)
  const value = useSettingsStore((s) => (kind === 'chat' ? s.chatModel : s.inlineModel))
  const set = useSettingsStore((s) => s.set)

  const current = useMemo(() => {
    if (!value) return null
    const idx = value.indexOf('::')
    if (idx < 0) return null
    const provider = providers.find((p) => p.id === value.slice(0, idx))
    return { provider, model: value.slice(idx + 2) }
  }, [value, providers])

  const items: MenuItem[] = []
  for (const p of providers) {
    items.push({
      type: 'header',
      header: `${p.name} — ${PROVIDER_LABELS[p.type]}`,
    })
    if (p.models.length === 0) {
      items.push({
        label: providerStatus[p.id] === 'error' ? 'Connection failed' : 'No models found',
        disabled: true,
      })
    }
    for (const m of p.models) {
      const ref = formatModelRef(p.id, m)
      items.push({
        label: m,
        icon: value === ref ? Check : undefined,
        onClick: () =>
          set(kind === 'chat' ? 'chatModel' : 'inlineModel', ref),
      })
    }
  }
  items.push({ type: 'separator' })
  items.push({
    label: 'Manage providers…',
    icon: Settings2,
    onClick: () => useAppStore.getState().setSidebarView('settings'),
  })

  const label = current
    ? current.model.length > 26
      ? current.model.slice(0, 26) + '…'
      : current.model
    : 'Select model'

  const trigger = compact ? (
    <button
      className="no-drag flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-dim)] hover:text-[var(--text)] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors max-w-[180px]"
      title="Active AI model — click to change"
    >
      <span className="truncate">{label}</span>
      <ChevronDown size={11} className="shrink-0" />
    </button>
  ) : (
    <button className="no-drag flex items-center gap-2 w-full text-left text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-dim)] hover:border-[var(--accent)] transition-colors">
      <span className="truncate flex-1">{label}</span>
      <ChevronDown size={12} className="shrink-0" />
    </button>
  )

  return (
    <div className={cn(compact ? '' : 'w-full')}>
      <Dropdown trigger={trigger} items={items} align={compact ? 'right' : 'left'} width={280} />
    </div>
  )
}
