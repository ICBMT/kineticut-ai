import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MonacoDiff } from './MonacoDiff'
import { Check, Sparkles, X, RotateCcw, Square } from 'lucide-react'
import { INLINE_SUGGESTIONS, useInlineEdit } from '../lib/inlineEdit'
import { basename } from '../lib/utils'
import { Spinner } from './ui'

const WIDTH = 560

export function InlineEditWidget() {
  const s = useInlineEdit()
  const cardRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [retrying, setRetrying] = useState(false)

  useLayoutEffect(() => {
    if (!s.open) return
    const h = cardRef.current?.offsetHeight ?? 260
    const left = Math.max(8, Math.min(s.anchor.x, window.innerWidth - WIDTH - 12))
    // Open below the code, or above it when there is no room.
    const below = s.anchor.y + h + 12 < window.innerHeight
    const top = below ? s.anchor.y : Math.max(8, s.anchor.y - h - 36)
    setPos({ left, top })
  }, [s.open, s.anchor.x, s.anchor.y, s.phase])

  // Keys: Esc closes or stops, Ctrl+Enter accepts a ready edit.
  useEffect(() => {
    if (!s.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (useInlineEdit.getState().phase === 'streaming') useInlineEdit.getState().stop()
        else useInlineEdit.getState().reject()
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && useInlineEdit.getState().phase === 'ready') {
        e.preventDefault()
        useInlineEdit.getState().accept()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [s.open])

  // Any phase change (a new request starting, a result landing) ends the retry prompt.
  useEffect(() => {
    setRetrying(false)
  }, [s.phase, s.open])

  if (!s.open) return null

  const showDiff = s.phase === 'streaming' || s.phase === 'ready'
  const busy = s.phase === 'streaming'

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Inline AI edit"
      className="inline-edit-card"
      style={{ left: pos.left, top: pos.top, width: WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="inline-edit-head">
        <Sparkles size={12} />
        <span className="inline-edit-title">
          Edit {basename(s.path)} · {s.scopeLabel}
        </span>
        <button className="inline-edit-x" onClick={() => s.reject()} aria-label="Close inline edit" title="Close (Esc)">
          <X size={13} />
        </button>
      </div>

      {(s.phase === 'prompt' || retrying) && (
        <div className="inline-edit-body">
          <input
            autoFocus
            className="inline-edit-input"
            placeholder="Describe the change…  (Enter to generate)"
            value={s.instruction}
            onChange={(e) => s.setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void s.submit()
              }
            }}
          />
          <div className="inline-edit-chips">
            {INLINE_SUGGESTIONS.map((text) => (
              <button key={text} className="inline-edit-chip" onClick={() => void s.submit(text)}>
                {text}
              </button>
            ))}
          </div>
        </div>
      )}

      {showDiff && !retrying && (
        <>
          <div className="inline-edit-status">
            {busy ? (
              <>
                <Spinner size={11} />
                <span>Writing the edit… {s.result.length} chars</span>
              </>
            ) : (
              <span className="inline-edit-ready">Ready. Review the change below.</span>
            )}
            <span className="inline-edit-ask">“{s.instruction}”</span>
          </div>
          <div className="inline-edit-diff">
            <MonacoDiff
              original={s.original}
              modified={s.result}
              language={s.language}
              inline
              height={Math.min(260, Math.max(90, (s.result.split('\n').length + 1) * 19))}
            />
          </div>
        </>
      )}

      {s.phase === 'error' && !retrying && (
        <div className="inline-edit-error">{s.error}</div>
      )}

      <div className="inline-edit-foot">
        {busy && (
          <button className="btn !py-0.5 !px-2 text-[11px]" onClick={() => s.stop()}>
            <Square size={10} /> Stop
          </button>
        )}
        {s.phase === 'ready' && !retrying && (
          <>
            <button className="btn !py-0.5 !px-2 text-[11px]" onClick={() => s.reject()} title="Reject (Esc)">
              Reject
            </button>
            <button
              className="btn !py-0.5 !px-2 text-[11px]"
              onClick={() => setRetrying(true)}
              title="Describe a different change"
            >
              <RotateCcw size={10} /> Retry
            </button>
            <button
              className="btn btn-primary !py-0.5 !px-2 text-[11px]"
              onClick={() => s.accept()}
              title="Accept (Ctrl+Enter)"
            >
              <Check size={11} /> Accept <span className="inline-edit-kbd">Ctrl+Enter</span>
            </button>
          </>
        )}
        {s.phase === 'error' && !retrying && (
          <button className="btn !py-0.5 !px-2 text-[11px]" onClick={() => setRetrying(true)}>
            <RotateCcw size={10} /> Try again
          </button>
        )}
        {(s.phase === 'prompt' || retrying) && (
          <span className="inline-edit-hint">Esc to cancel</span>
        )}
      </div>
    </div>
  )
}
