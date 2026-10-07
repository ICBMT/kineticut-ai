import { useEffect, useRef } from 'react'
import { ChevronDown, Plus, SquareTerminal, Trash2, X } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { api } from '../api'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useTerminalStore } from '../store/terminal'
import { IconButton } from './ui'

const XTERM_THEME = {
  background: '#0b0b10',
  foreground: '#e6e6ef',
  cursor: '#7aa2f7',
  cursorAccent: '#0b0b10',
  selectionBackground: '#28304a',
  black: '#1a1b26',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
}

function XTerm({ id, active }: { id: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false,
      tabStopWidth: 4,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      /* not visible yet */
    }

    const disposeData = api.terminal.onData(id, (d) => term.write(d))
    const disposeExit = api.terminal.onExit(id, (code) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
      useTerminalStore.getState().markExited(id)
    })
    const subData = term.onData((d) => api.terminal.write(id, d))
    const subResize = term.onResize(({ cols, rows }) => api.terminal.resize(id, cols, rows))
    term.focus()

    return () => {
      disposeData()
      disposeExit()
      subData.dispose()
      subResize.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  // Fit when the tab becomes visible or the container resizes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      if (active) {
        try {
          fitRef.current?.fit()
        } catch {
          /* ignore */
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [active])

  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      termRef.current?.focus()
    }
  }, [active])

  return (
    <div
      className="terminal-wrap"
      ref={containerRef}
      style={{ display: active ? 'block' : 'none' }}
    />
  )
}

export function TerminalPanel() {
  const panelOpen = useAppStore((s) => s.panelOpen)
  const panelHeight = useAppStore((s) => s.panelHeight)
  const folder = useAppStore((s) => s.folder)
  const terminals = useTerminalStore((s) => s.terminals)
  const activeId = useTerminalStore((s) => s.activeId)

  if (!panelOpen) return null

  const newTerminal = async () => {
    try {
      const { id } = await api.terminal.create({ cwd: folder || undefined, cols: 80, rows: 24 })
      const n = useTerminalStore.getState().terminals.length + 1
      useTerminalStore.getState().addTerminal({ id, title: `terminal ${n}` })
    } catch (err) {
      useAppStore.getState().toast({
        kind: 'error',
        title: 'Could not start terminal',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = panelHeight
    const onMove = (ev: MouseEvent) =>
      useAppStore.getState().setPanelHeight(startH - (ev.clientY - startY))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="terminal-panel" style={{ height: panelHeight }}>
      <div className="panel-resizer" onMouseDown={startResize} title="Drag to resize" />
      <div className="terminal-tabs">
        {terminals.map((t) => (
          <button
            key={t.id}
            className={cn('term-tab', t.id === activeId && 'active')}
            onClick={() => useTerminalStore.getState().setActive(t.id)}
          >
            <SquareTerminal size={12} className="shrink-0" />
            <span className="tname">{t.title}</span>
            {t.exited && <span className="text-[9px] text-[var(--text-faint)]">(exited)</span>}
            <span
              className="ml-0.5 rounded p-0.5 text-[var(--text-faint)] hover:bg-[var(--bg-active)] hover:text-[var(--text)]"
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation()
                api.terminal.kill(t.id)
                useTerminalStore.getState().removeTerminal(t.id)
              }}
            >
              <X size={11} />
            </span>
          </button>
        ))}
        <IconButton icon={Plus} size={13} tooltip="New terminal" onClick={() => void newTerminal()} />
        <div className="flex-1" />
        <IconButton
          icon={Trash2}
          size={13}
          tooltip="Kill active terminal"
          disabled={!activeId}
          onClick={() => {
            if (activeId) {
              api.terminal.kill(activeId)
              useTerminalStore.getState().markExited(activeId)
            }
          }}
        />
        <IconButton
          icon={ChevronDown}
          size={13}
          tooltip="Hide panel (Ctrl+`)"
          onClick={() => useAppStore.getState().setPanelOpen(false)}
        />
      </div>
      <div className="terminal-body">
        {terminals.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-[var(--text-faint)]">
            <SquareTerminal size={20} />
            <span>No terminal open</span>
            <button className="btn btn-primary !py-1.5 text-xs" onClick={() => void newTerminal()}>
              <Plus size={12} />
              New terminal
            </button>
          </div>
        ) : (
          terminals.map((t) => <XTerm key={t.id} id={t.id} active={t.id === activeId} />)
        )}
      </div>
    </div>
  )
}
