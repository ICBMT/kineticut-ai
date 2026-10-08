import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAppStore, type Toast } from '../store/app'

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
  warning: AlertTriangle,
} as const

const COLORS = {
  info: 'var(--accent)',
  success: 'var(--green)',
  error: 'var(--red)',
  warning: 'var(--yellow)',
} as const

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useAppStore((s) => s.dismissToast)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const duration = toast.duration ?? (toast.kind === 'error' ? 6000 : 4000)
    const timer = setTimeout(() => {
      setLeaving(true)
      setTimeout(() => dismiss(toast.id), 180)
    }, duration)
    return () => clearTimeout(timer)
  }, [toast.id, toast.duration, dismiss])

  const Icon = ICONS[toast.kind]
  return (
    <div className={cn('toast', leaving && 'leaving')}>
      <Icon size={16} style={{ color: COLORS[toast.kind] }} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-[var(--text)]">{toast.title}</div>
        {toast.message && (
          <div className="text-[11px] text-[var(--text-dim)] mt-0.5 break-words">
            {toast.message}
          </div>
        )}
      </div>
      <button
        className="icon-btn !w-5 !h-5"
        onClick={() => {
          setLeaving(true)
          setTimeout(() => dismiss(toast.id), 180)
        }}
      >
        <X size={11} />
      </button>
    </div>
  )
}

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts)
  return (
    <div className="fixed z-[300] flex flex-col gap-2" style={{ top: 'calc(var(--titlebar-h) + 10px)', right: 12 }}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
