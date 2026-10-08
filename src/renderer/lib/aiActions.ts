/**
 * AI actions over the editor: explain / refactor / test / fix, plus
 * attaching the current selection to the chat. Heavy edits are reviewed
 * in a diff modal before being applied.
 */
import * as monaco from 'monaco-editor'
import { streamChat } from '../ai/providers'
import { editorRef } from './editorRef'
import { languageForPath } from './languages'
import { stripCodeFences } from './markdown'
import { useAppStore } from '../store/app'
import { useAIStore } from '../store/ai'
import { resolveChatModel, useSettingsStore } from '../store/settings'
import { basename } from './utils'

export interface SelectionContext {
  path: string
  text: string
  language: string
  range: monaco.Range
  wholeFile: boolean
}

export function getSelectionContext(allowWholeFile = true): SelectionContext | null {
  const editor = editorRef.current
  if (!editor) return null
  const model = editor.getModel()
  if (!model) return null
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
  const selection = editor.getSelection()
  if (selection && !selection.isEmpty()) {
    return {
      path,
      text: model.getValueInRange(selection),
      language: model.getLanguageId(),
      range: selection,
      wholeFile: false,
    }
  }
  if (allowWholeFile) {
    const full = model.getValue()
    return {
      path,
      text: full.slice(0, 40000),
      language: model.getLanguageId(),
      range: model.getFullModelRange(),
      wholeFile: true,
    }
  }
  return null
}

function requireModel(): { provider: any; model: string } | null {
  const settings = useSettingsStore.getState()
  const { provider, model } = resolveChatModel(settings)
  if (!provider || !model) {
    useAppStore.getState().toast({
      kind: 'error',
      title: 'No AI model configured',
      message: 'Add a provider in Settings → Providers (Ollama or a frontier API key).',
    })
    return null
  }
  return { provider, model }
}

async function produceReplacement(instruction: string, scope: SelectionContext): Promise<string | null> {
  const resolved = requireModel()
  if (!resolved) return null
  const target = scope.wholeFile ? 'file' : 'selection'
  const system = `You are an expert code editing assistant embedded in an IDE. ${instruction}\nReturn ONLY the complete replacement code — no markdown fences, no explanations, no surrounding commentary.`
  const user = `<${target} path="${scope.path}" language="${scope.language}">\n${scope.text}\n</${target}>`
  let out = ''
  try {
    for await (const evt of streamChat({
      provider: resolved.provider,
      model: resolved.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })) {
      if (evt.type === 'text') out += evt.text
      else if (evt.type === 'error') throw new Error(evt.error)
    }
  } catch (err) {
    useAppStore.getState().toast({
      kind: 'error',
      title: 'AI request failed',
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  const cleaned = stripCodeFences(out.trim())
  if (!cleaned.trim()) {
    useAppStore.getState().toast({
      kind: 'warning',
      title: 'Empty AI response',
      message: 'The model did not return any code.',
    })
    return null
  }
  return cleaned
}

function requestReview(opts: {
  path: string
  original: string
  modified: string
  language: string
  title: string
  onApply: (modified: string) => void | Promise<void>
}): void {
  useAppStore.getState().requestDiff({ ...opts, resolve: () => {} })
}

/* --------------------------------- actions ---------------------------------- */

export function explainSelection(): void {
  const ctx = getSelectionContext(true)
  const app = useAppStore.getState()
  const ai = useAIStore.getState()
  if (!ai.activeSession()) ai.newSession('chat')
  app.setSidebarView('chat')
  const target = ctx
    ? `Explain this ${ctx.wholeFile ? 'file' : 'code'} (${basename(ctx.path)}):\n\n${ctx.text.slice(0, 16000)}`
    : 'Explain the current file.'
  void ai.send(target)
}

export async function refactorSelection(): Promise<void> {
  const ctx = getSelectionContext(false)
  if (!ctx) {
    useAppStore.getState().toast({
      kind: 'info',
      title: 'Select some code first',
      message: 'Highlight code in the editor, then run AI → Refactor Selection.',
    })
    return
  }
  const out = await produceReplacement(
    'Refactor the following code to improve readability, structure, naming and performance while preserving its behavior exactly.',
    ctx,
  )
  if (out == null) return
  requestReview({
    path: ctx.path,
    original: ctx.text,
    modified: out,
    language: ctx.language,
    title: 'Refactor selection',
    onApply: (modified) => {
      const editor = editorRef.current
      if (!editor) return
      editor.executeEdits('kineticut-ai', [{ range: ctx.range, text: modified }])
      editor.pushUndoStop()
    },
  })
}

export async function generateTests(): Promise<void> {
  const ctx = getSelectionContext(true)
  if (!ctx) return
  const out = await produceReplacement(
    'Write a complete, runnable test suite for the following code. Use the testing conventions of the project when they are obvious from the code; otherwise pick a sensible modern framework. Include meaningful edge cases.',
    ctx,
  )
  if (out == null) return
  requestReview({
    path: ctx.path,
    original: ctx.text,
    modified: out,
    language: ctx.language,
    title: 'Generated tests',
    onApply: async (modified) => {
      const editor = editorRef.current
      if (!editor) return
      // Replace the scope; for whole files this swaps the buffer content.
      editor.executeEdits('kineticut-ai', [{ range: ctx.range, text: modified }])
      editor.pushUndoStop()
    },
  })
}

export function fixProblemsFromMarkers(): void {
  const editor = editorRef.current
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
  if (markers.length === 0) {
    useAppStore.getState().toast({
      kind: 'info',
      title: 'No problems to fix',
      message: 'There are no warnings or errors in the active file.',
    })
    return
  }
  void fixProblems(model, markers)
}

export async function fixProblems(
  model: monaco.editor.ITextModel,
  markers: monaco.editor.IMarkerData[],
): Promise<void> {
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
  const problems = markers
    .map((m) => `- [${monaco.MarkerSeverity[m.severity].toLowerCase()}] ${m.message} (line ${m.startLineNumber})`)
    .join('\n')
  const scope: SelectionContext = {
    path,
    text: model.getValue().slice(0, 60000),
    language: model.getLanguageId(),
    range: model.getFullModelRange(),
    wholeFile: true,
  }
  const instruction = `Fix all of these problems in the following file:\n${problems}\nPreserve behavior except where the problem requires a change.`
  const out = await produceReplacement(instruction, scope)
  if (out == null) return
  requestReview({
    path,
    original: scope.text,
    modified: out,
    language: scope.language,
    title: 'Fix problems with AI',
    onApply: async (modified) => {
      const editor = editorRef.current
      if (!editor) return
      editor.executeEdits('kineticut-ai', [{ range: model.getFullModelRange(), text: modified }])
      editor.pushUndoStop()
    },
  })
}

export function attachSelectionToChat(): void {
  const editor = editorRef.current
  const app = useAppStore.getState()
  if (!editor) return
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (!model || !selection || selection.isEmpty()) {
    useAppStore.getState().toast({
      kind: 'info',
      title: 'No selection',
      message: 'Highlight some code first, then ask AI about it.',
    })
    return
  }
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
  useAIStore.getState().setAttach({
    path,
    label: `${basename(path)}:${selection.startLineNumber}-${selection.endLineNumber}`,
    text: model.getValueInRange(selection),
  })
  app.setSidebarView('chat')
}

/**
 * The code the user is looking at: the highlighted selection if there is one,
 * otherwise the whole active file (for commands like "/review" typed without a
 * selection). Null when no editor or no code is open.
 */
export function currentCodeAttachment(): { path: string; label: string; text: string } | null {
  const editor = editorRef.current
  if (!editor) return null
  const model = editor.getModel()
  if (!model) return null
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
  const selection = editor.getSelection()
  if (selection && !selection.isEmpty()) {
    return {
      path,
      label: `${basename(path)}:${selection.startLineNumber}-${selection.endLineNumber}`,
      text: model.getValueInRange(selection),
    }
  }
  const text = model.getValue()
  if (!text.trim()) return null
  return { path, label: basename(path), text: text.slice(0, 12000) }
}

export function triggerInlineCompletion(): void {
  const editor = editorRef.current
  if (!editor) return
  for (const cmd of [
    'editor.action.inlineCompletions.trigger',
    'editor.action.inlineSuggest.trigger',
  ]) {
    try {
      editor.trigger('kineticut-ai', cmd, null)
    } catch {
      /* try next */
    }
  }
}
