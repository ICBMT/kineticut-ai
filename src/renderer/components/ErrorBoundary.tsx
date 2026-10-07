import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last line of defense: if a component crashes, show a diagnostic screen
 * instead of a blank page.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[kineticut] component crashed:', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="splash">
          <div
            className="logo-mark"
            style={{ background: 'linear-gradient(135deg, #f7768e, #e0af68)' }}
          >
            <AlertTriangle size={28} />
          </div>
          <div className="text-sm font-semibold text-[var(--text)]">
            Something went wrong
          </div>
          <div className="max-w-[520px] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 font-mono text-[11px] text-[var(--red)] overflow-auto">
            {this.state.error.message}
            {this.state.error.stack ? (
              <div className="mt-2 whitespace-pre-wrap text-[var(--text-faint)]">
                {this.state.error.stack.split('\n').slice(0, 8).join('\n')}
              </div>
            ) : null}
          </div>
          <button
            className="btn btn-primary mt-2"
            onClick={() => {
              this.setState({ error: null })
              location.reload()
            }}
          >
            <RefreshCw size={14} />
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
