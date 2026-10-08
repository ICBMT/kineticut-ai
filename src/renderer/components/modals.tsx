import { useEffect, useRef, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { cn } from '../lib/utils'
import { diffEditorOptions, monacoThemeName } from '../lib/monaco'
import { basename } from '../lib/utils'
import { useAppStore } from '../store/app'
import { Modal } from './ui'

/** Review AI-proposed changes in a side-by-side diff before applying. */
export function DiffModal() {
  const req = useAppStore((s) => s.diffRequest)
  const clearDiff = useAppStore((s) => s.clearDiff)
  const [modified, setModified] = useState('')
  const diffRef = useRef<any>(null)

  useEffect(() => {
    if (req) setModified(req.modified)
  }, [req])

  if (!req) return null

  // Without onApply the diff is a read-only review (e.g. Show Changes).
  const readOnly = !req.onApply

  const cancel = () => {
    req.resolve(false)
    clearDiff()
  }

  const apply = async () => {
    const value: string =
      diffRef.current?.getModifiedEditor?.().getValue() ?? modified
    try {
      await req.onApply?.(value)
      req.resolve(true)
      clearDiff()
      useAppStore.getState().toast({
        kind: 'success',
        title: 'Applied',
        message: basename(req.path),
        duration: 1800,
      })
    } catch (err) {
      useAppStore.getState().toast({
        kind: 'error',
        title: 'Apply failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Modal
      open
      onClose={cancel}
      wide
      title={
        <span className="flex items-center gap-2">
          <span>{req.title || 'Review changes'}</span>
          <span className="font-mono text-[11px] text-[var(--text-faint)]">{req.path}</span>
        </span>
      }
      footer={
        readOnly ? (
          <button className="btn btn-primary" onClick={cancel}>
            Close
          </button>
        ) : (
          <>
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void apply()}>
              Apply changes
            </button>
          </>
        )
      }
    >
      <DiffEditor
        original={req.original}
        modified={modified}
        language={req.language}
        theme={monacoThemeName()}
        options={{ ...diffEditorOptions(), readOnly }}
        height="62vh"
        onMount={(editor: any) => {
          diffRef.current = editor
        }}
      />
    </Modal>
  )
}

export function ConfirmModal() {
  const req = useAppStore((s) => s.confirmRequest)
  const clearConfirm = useAppStore((s) => s.clearConfirm)
  if (!req) return null
  const close = (ok: boolean) => {
    req.resolve(ok)
    clearConfirm()
  }
  return (
    <Modal
      open
      onClose={() => close(false)}
      title={req.title}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button
            className={cn('btn', req.danger ? 'btn-danger' : 'btn-primary')}
            onClick={() => close(true)}
          >
            {req.confirmLabel || 'Confirm'}
          </button>
        </>
      }
    >
      <div className="text-sm text-[var(--text-dim)] break-words">{req.message}</div>
      {req.detail && (
        <div className="mt-2 rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] p-2 font-mono text-[11px] text-[var(--text-faint)] break-all">
          {req.detail}
        </div>
      )}
    </Modal>
  )
}

export function PromptModal() {
  const req = useAppStore((s) => s.promptRequest)
  const clearPrompt = useAppStore((s) => s.clearPrompt)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (req) setValue(req.initial || '')
  }, [req])

  if (!req) return null

  const submit = () => {
    req.resolve(value.trim() ? value : null)
    clearPrompt()
  }

  return (
    <Modal
      open
      onClose={() => {
        req.resolve(null)
        clearPrompt()
      }}
      title={req.title}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              req.resolve(null)
              clearPrompt()
            }}
          >
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            OK
          </button>
        </>
      }
    >
      <label className="field-label">{req.label}</label>
      <input
        className="field-input"
        autoFocus
        value={value}
        placeholder={req.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
    </Modal>
  )
}
