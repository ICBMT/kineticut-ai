/**
 * Inline edit (Ctrl+K): select code, say what should change, and review the
 * rewrite as a diff right where you are. Accept applies it as one undo step;
 * Reject leaves the file alone. The model's answer is never written until the
 * user accepts, and it is dropped if the code under the selection changed while
 * the model was thinking.
 */
import * as monaco from 'monaco-editor'
import { create } from 'zustand'
import type { AIMessage } from '../ai/types'
import { streamChat } from '../ai/providers'
import { editorRef } from './editorRef'
import { languageForPath } from './languages'
import { stripCodeFences } from './markdown'
import { loadRulesBlock } from './rules'
import { useAppStore } from '../store/app'
import { resolveChatModel, useSettingsStore } from '../store/settings'

/** Characters of surrounding code sent with the selection, on each side. */
export const INLINE_CONTEXT_CHARS = 2500

export const INLINE_SUGGESTIONS = [
  'Add error handling',
  'Add comments and types',
  'Simplify this',
  'Make it faster',
  'Write tests for this',
]

/** The rule the model follows: rewrite only the selection and return just code. */
export function buildInlineEditMessages(args: {
  instruction: string
  path: string
  language: string
  selection: string
  before: string
  after: string
  rules?: string
}): AIMessage[] {
  const system = [
    'You are an expert code editing assistant inside an IDE.',
    'Rewrite only the code inside <selection> so it does what the instruction asks.',
    'Return ONLY the replacement for the selection: no markdown fences, no explanation, and no code outside it.',
    "Keep the file's indentation style, naming and conventions. If the instruction cannot be done inside the selection, return the selection unchanged.",
    args.rules ? `\n${args.rules}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const user = [
    `File: ${args.path} (${args.language})`,
    args.before ? `<before>\n${args.before}\n</before>` : '',
    `<selection>\n${args.selection}\n</selection>`,
    args.after ? `<after>\n${args.after}\n</after>` : '',
    `Instruction: ${args.instruction}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Cut the context around a selection on a line boundary when possible. */
export function contextWindow(text: string, side: 'before' | 'after'): string {
  if (text.length <= INLINE_CONTEXT_CHARS) return text
  if (side === 'before') {
    const cut = text.slice(text.length - INLINE_CONTEXT_CHARS)
    const nl = cut.indexOf('\n')
    return nl >= 0 ? cut.slice(nl + 1) : cut
  }
  const cut = text.slice(0, INLINE_CONTEXT_CHARS)
  const nl = cut.lastIndexOf('\n')
  return nl > 0 ? cut.slice(0, nl) : cut
}

/** Apply only if the code under the selection is still what the model was given. */
export function canApplyInlineEdit(current: string, original: string): boolean {
  return current === original
}

export type InlinePhase = 'prompt' | 'streaming' | 'ready' | 'error'

export interface InlineEditState {
  open: boolean
  phase: InlinePhase
  path: string
  language: string
  range: monaco.IRange | null
  original: string
  scopeLabel: string
  anchor: { x: number; y: number }
  instruction: string
  result: string
  error: string | null
  setInstruction(text: string): void
  submit(instruction?: string): Promise<void>
  accept(): void
  reject(): void
  stop(): void
}

let activeEditor: monaco.editor.IStandaloneCodeEditor | null = null
let controller: AbortController | null = null
let scrollSub: monaco.IDisposable | null = null

/** Open the inline edit for the editor's selection, or the current line when nothing is selected. */
export function openInlineEdit(editor: monaco.editor.IStandaloneCodeEditor | null = editorRef.current): void {
  const model = editor?.getModel()
  if (!editor || !model) {
    useAppStore.getState().toast({ kind: 'info', title: 'Open a file first', message: 'Inline edit works in the editor.' })
    return
  }
  const sel = editor.getSelection()
  const hasSelection = !!sel && !sel.isEmpty()
  const range: monaco.IRange = hasSelection
    ? sel!
    : {
        startLineNumber: editor.getPosition()?.lineNumber ?? 1,
        startColumn: 1,
        endLineNumber: editor.getPosition()?.lineNumber ?? 1,
        endColumn: model.getLineMaxColumn(editor.getPosition()?.lineNumber ?? 1),
      }
  const original = model.getValueInRange(range)
  const lines = range.endLineNumber - range.startLineNumber + 1
  const scopeLabel = hasSelection
    ? lines === 1
      ? `line ${range.startLineNumber}`
      : `lines ${range.startLineNumber}–${range.endLineNumber}`
    : `line ${range.startLineNumber}`

  const pos = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn })
  const box = editor.getDomNode()?.getBoundingClientRect()
  const anchor = box && pos ? { x: box.left + pos.left, y: box.top + pos.top + pos.height + 6 } : { x: 120, y: 120 }

  activeEditor = editor
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
  scrollSub?.dispose()
  scrollSub = editor.onDidScrollChange(() => useInlineEdit.getState().reject())
  useInlineEdit.setState({
    open: true,
    phase: 'prompt',
    path,
    language: model.getLanguageId() || languageForPath(path),
    range,
    original,
    scopeLabel,
    anchor,
    instruction: '',
    result: '',
    error: null,
  })
}

function closeInline(): void {
  controller?.abort()
  controller = null
  scrollSub?.dispose()
  scrollSub = null
  activeEditor = null
  useInlineEdit.setState({ open: false, phase: 'prompt', instruction: '', result: '', error: null })
  editorRef.current?.focus()
}

export const useInlineEdit = create<InlineEditState>()((set, get) => ({
  open: false,
  phase: 'prompt',
  path: '',
  language: 'plaintext',
  range: null,
  original: '',
  scopeLabel: '',
  anchor: { x: 0, y: 0 },
  instruction: '',
  result: '',
  error: null,

  setInstruction: (text) => set({ instruction: text }),

  submit: async (instructionArg) => {
    const instruction = (instructionArg ?? get().instruction).trim()
    const { range, original, path, language } = get()
    if (!instruction || !range) return
    const settings = useSettingsStore.getState()
    const { provider, model } = resolveChatModel(settings)
    if (!provider || !model) {
      set({ phase: 'error', error: 'No AI model configured. Open Settings → Providers first.' })
      return
    }

    const editor = activeEditor
    const fullText = editor?.getModel()?.getValue() ?? original
    const startOffset = editor?.getModel()?.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }) ?? 0
    const endOffset = editor?.getModel()?.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }) ?? original.length
    const messages = buildInlineEditMessages({
      instruction,
      path,
      language,
      selection: original,
      before: contextWindow(fullText.slice(0, startOffset), 'before'),
      after: contextWindow(fullText.slice(endOffset), 'after'),
      rules: await loadRulesBlock(),
    })

    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    set({ phase: 'streaming', instruction, result: '', error: null })
    let out = ''
    try {
      for await (const evt of streamChat({ provider, model, messages, signal })) {
        if (signal.aborted) break
        if (evt.type === 'text') {
          out += evt.text
          set({ result: stripCodeFences(out) })
        } else if (evt.type === 'error') {
          throw new Error(evt.error)
        }
      }
      if (signal.aborted) return
      const cleaned = stripCodeFences(out.trim())
      if (!cleaned.trim()) throw new Error('The model returned no code. Try a more specific instruction.')
      set({ phase: 'ready', result: cleaned })
    } catch (err) {
      if (signal.aborted) return
      set({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (controller?.signal === signal) controller = null
    }
  },

  accept: () => {
    const { range, original, result } = get()
    const editor = activeEditor
    const model = editor?.getModel()
    if (!editor || !model || !range) {
      closeInline()
      return
    }
    if (!canApplyInlineEdit(model.getValueInRange(range), original)) {
      useAppStore.getState().toast({
        kind: 'warning',
        title: 'Code changed while the AI was working',
        message: 'Nothing was applied. Select the code again and retry.',
      })
      set({ phase: 'error', error: 'The selected code changed, so this edit no longer fits. Retry on the current code.' })
      return
    }
    editor.executeEdits('kineticut-inline-edit', [{ range, text: result }])
    editor.pushUndoStop()
    closeInline()
  },

  reject: () => closeInline(),

  stop: () => {
    controller?.abort()
    controller = null
    set({ phase: get().result ? 'ready' : 'prompt' })
  },
}))
