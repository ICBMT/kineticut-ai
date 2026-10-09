import React, { cloneElement, isValidElement, useEffect, useRef, useState } from 'react'
import { Loader2, X, type LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'

/* ------------------------------- primitives --------------------------------- */

export function IconButton({
  icon: Icon,
  onClick,
  tooltip,
  size = 16,
  disabled,
  className,
}: {
  icon: LucideIcon
  onClick?: () => void
  tooltip?: string
  size?: number
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      className={cn('icon-btn', className)}
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      aria-label={tooltip}
    >
      <Icon size={size} />
    </button>
  )
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('spin', className)} />
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="kbd">{children}</span>
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange(v: boolean): void
  label?: string
}) {
  return (
    <button
      className={cn('switch', on && 'on')}
      onClick={() => onChange(!on)}
      aria-label={label}
      title={label}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; icon?: LucideIcon }[]
  onChange(v: T): void
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={cn(o.value === value && 'active')}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <o.icon size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon?: LucideIcon
  title: string
  text?: string
  action?: { label: string; onClick(): void }
}) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={30} className="mb-1" color="var(--text-faint)" />}
      <div className="font-semibold text-[var(--text)]">{title}</div>
      {text && <div className="text-xs max-w-[250px] leading-5">{text}</div>}
      {action && (
        <button className="btn btn-primary mt-3 text-xs" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/* ---------------------------------- modal ----------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onClose(): void
  title?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={cn('modal', wide && 'modal-wide')}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="modal-header">
            <span>{title}</span>
            <IconButton icon={X} onClick={onClose} size={15} />
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

/* ------------------------------ menus (dropdown) ---------------------------- */

export interface MenuItem {
  type?: 'item' | 'separator' | 'header'
  icon?: LucideIcon
  label?: string
  shortcut?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  header?: string
}

function MenuItems({ items, onDone }: { items: MenuItem[]; onDone(): void }) {
  return (
    <>
      {items.map((item, i) => {
        if (item.type === 'separator') return <div key={i} className="menu-sep" />
        if (item.type === 'header')
          return (
            <div key={i} className="menu-header">
              {item.header}
            </div>
          )
        return (
          <button
            key={i}
            className={cn('menu-item', item.danger && 'danger')}
            disabled={item.disabled}
            onClick={() => {
              onDone()
              item.onClick?.()
            }}
          >
            {item.icon && <item.icon size={14} className="shrink-0" />}
            <span className="truncate">{item.label}</span>
            {item.shortcut && <span className="mi-shortcut">{item.shortcut}</span>}
          </button>
        )
      })}
    </>
  )
}

export function Dropdown({
  trigger,
  items,
  align = 'left',
  width,
}: {
  trigger: React.ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((v) => !v)}>
        {isValidElement(trigger)
          ? cloneElement(trigger as React.ReactElement<{ 'aria-expanded'?: boolean }>, { 'aria-expanded': open })
          : trigger}
      </div>
      {open && (
        <div
          className={cn('menu-pop', align === 'right' ? 'right-0' : 'left-0')}
          style={{ top: '100%', marginTop: 5, ...(width ? { minWidth: width } : {}) }}
        >
          <MenuItems items={items} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

/* ------------------------------ context menu -------------------------------- */

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)),
    })
  }, [x, y])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])
  return (
    <>
      <div
        className="fixed inset-0 z-[110]"
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={ref}
        className="menu-pop"
        style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 130 }}
      >
        <MenuItems items={items} onDone={onClose} />
      </div>
    </>
  )
}
