import { useEffect, useRef, type MutableRefObject } from 'react'
import * as monaco from 'monaco-editor'
import { diffEditorOptions, monacoThemeName } from '../lib/monaco'

interface MonacoDiffProps {
  original: string
  modified: string
  language: string
  height: number | string
  /** When false the right-hand side can be edited; the editor keeps the user's text. */
  readOnly?: boolean
  /** Receives the diff editor, so callers can read the edited right-hand side. */
  diffRef?: MutableRefObject<monaco.editor.IStandaloneDiffEditor | null>
  /** Compact inline view (one column) instead of side by side. */
  inline?: boolean
}

/**
 * A Monaco diff driven directly, not through the React wrapper. Teardown follows
 * Monaco's own order: detach the models, dispose the editor, then dispose the
 * models on the next frame. Unmounting the wrapped DiffEditor disposed models
 * while a render was still queued, which threw inside the editor.
 */
export function MonacoDiff({ original, modified, language, height, readOnly = true, diffRef, inline = false }: MonacoDiffProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)

  // Create once per mount. Changing the original text is handled by remounting.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)
    const editor = monaco.editor.createDiffEditor(host, {
      ...diffEditorOptions(),
      theme: monacoThemeName(),
      renderSideBySide: !inline,
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    editor.getModifiedEditor().updateOptions({ readOnly })
    editorRef.current = editor
    modifiedModelRef.current = modifiedModel
    if (diffRef) diffRef.current = editor

    const observer = new ResizeObserver(() => editor.layout())
    observer.observe(host)

    return () => {
      observer.disconnect()
      if (diffRef && diffRef.current === editor) diffRef.current = null
      editor.setModel(null)
      editor.dispose()
      editorRef.current = null
      modifiedModelRef.current = null
      requestAnimationFrame(() => {
        originalModel.dispose()
        modifiedModel.dispose()
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The `modified` prop only changes from outside (streamed results, or the
  // modal filling in its text), never from the user's typing, so syncing it is safe.
  useEffect(() => {
    const model = modifiedModelRef.current
    if (model && model.getValue() !== modified) model.setValue(modified)
  }, [modified])

  useEffect(() => {
    editorRef.current?.getModifiedEditor().updateOptions({ readOnly })
  }, [readOnly])

  return <div ref={hostRef} style={{ height }} className="monaco-diff-host" />
}
