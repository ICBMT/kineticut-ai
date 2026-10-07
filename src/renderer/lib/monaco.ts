/**
 * Monaco setup: web workers, custom themes, AI inline completions,
 * "Fix with AI" code actions, model lifecycle and editor options.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { api } from '../api'
import { streamChat } from '../ai/providers'
import { setSnapshot, useEditorStore } from '../store/editor'
import { resolveInlineModel, useSettingsStore } from '../store/settings'
import { fixProblems } from './aiActions'
import { languageForPath } from './languages'
import { stripCodeFences } from './markdown'
import { sleep } from './utils'

let configured = false

export function setupMonaco(): void {
  if (configured) return
  configured = true

  // Use the locally bundled Monaco (not the @monaco-editor/react CDN loader),
  // so the editor works fully offline and inside the packaged app.
  loader.config({ monaco })

  ;(self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    },
  }

  defineThemes()
  registerInlineCompletions()
  registerAICodeActions()
}

/* --------------------------------- themes ---------------------------------- */

function defineThemes(): void {
  monaco.editor.defineTheme('kinetic-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e6e6ef', background: '0d0d14' },
      { token: 'comment', foreground: '6b7394', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'bb9af7' },
      { token: 'string', foreground: '9ece6a' },
      { token: 'number', foreground: 'ff9e64' },
      { token: 'regexp', foreground: 'b4f9f8' },
      { token: 'type', foreground: '2ac3de' },
      { token: 'class', foreground: 'e0af68' },
      { token: 'function', foreground: '7aa2f7' },
      { token: 'variable', foreground: 'e6e6ef' },
      { token: 'variable.predefined', foreground: 'ff9e64' },
      { token: 'constant', foreground: 'ff9e64' },
      { token: 'tag', foreground: 'f7768e' },
      { token: 'attribute.name', foreground: 'bb9af7' },
      { token: 'attribute.value', foreground: '9ece6a' },
      { token: 'delimiter', foreground: '89ddff' },
      { token: 'identifier', foreground: 'e6e6ef' },
      { token: 'type.identifier', foreground: '2ac3de' },
    ],
    colors: {
      'editor.background': '#0d0d14',
      'editor.foreground': '#e6e6ef',
      'editorGutter.background': '#0d0d14',
      'editorLineNumber.foreground': '#4a4a5e',
      'editorLineNumber.activeForeground': '#7aa2f7',
      'editor.selectionBackground': '#28304a',
      'editor.selectionHighlightBackground': '#1d2438',
      'editor.lineHighlightBackground': '#14141d',
      'editorCursor.foreground': '#7aa2f7',
      'editorWhitespace.foreground': '#2a2a3c',
      'editorIndentGuide.background1': '#1c1c2c',
      'editorIndentGuide.activeBackground1': '#34345a',
      'editorBracketMatch.background': '#28304a',
      'editorBracketMatch.border': '#3d5a9e',
      'editorWidget.background': '#12121b',
      'editorWidget.border': '#26263a',
      'editorSuggestWidget.background': '#12121b',
      'editorSuggestWidget.border': '#26263a',
      'editorSuggestWidget.foreground': '#c8c8d8',
      'editorSuggestWidget.selectedBackground': '#1d2438',
      'editorSuggestWidget.highlightForeground': '#7aa2f7',
      'editorHoverWidget.background': '#12121b',
      'editorHoverWidget.border': '#26263a',
      'editor.findMatchBackground': '#3b2f6b',
      'editor.findMatchHighlightBackground': '#2a2350',
      'scrollbarSlider.background': '#26263a80',
      'scrollbarSlider.hoverBackground': '#34345a99',
      'scrollbarSlider.activeBackground': '#4a4a7099',
      'minimap.background': '#0b0b10',
      'editorMarkerNavigationError.background': '#f7768e',
      'editorMarkerNavigationWarning.background': '#e0af68',
      'editorMarkerNavigationInfo.background': '#7aa2f7',
      'diffEditor.insertedTextBackground': '#1d3a2d',
      'diffEditor.removedTextBackground': '#3d1f28',
      'diffEditor.insertedLineBackground': '#14251d',
      'diffEditor.removedLineBackground': '#2a181f',
      'badge.background': '#1d2438',
      'badge.foreground': '#c8c8d8',
      'button.background': '#1d2438',
      'button.foreground': '#e6e6ef',
      'button.hoverBackground': '#28304a',
      'input.background': '#101018',
      'input.border': '#26263a',
      'input.foreground': '#e6e6ef',
      'focusBorder': '#7aa2f7',
      'panel.background': '#0d0d14',
      'panel.border': '#232336',
      'titleBar.activeBackground': '#0b0b10',
      'activityBar.background': '#0b0b10',
      'sideBar.background': '#0d0d14',
      'statusBar.background': '#0b0b10',
      'tab.activeBackground': '#0d0d14',
      'tab.inactiveBackground': '#101018',
      'tab.border': '#232336',
      'list.hoverBackground': '#1a1a26',
      'list.activeSelectionBackground': '#1d2438',
      'list.inactiveSelectionBackground': '#161624',
    },
  })

  monaco.editor.defineTheme('kinetic-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '24292f', background: 'ffffff' },
      { token: 'comment', foreground: '6e7781', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'cf222e' },
      { token: 'string', foreground: '0a3069' },
      { token: 'number', foreground: '0550ae' },
      { token: 'regexp', foreground: '0a7ea4' },
      { token: 'type', foreground: '953800' },
      { token: 'class', foreground: '8250df' },
      { token: 'function', foreground: '6639ba' },
      { token: 'variable', foreground: '24292f' },
      { token: 'constant', foreground: '0550ae' },
      { token: 'tag', foreground: '116329' },
      { token: 'attribute.name', foreground: '0550ae' },
      { token: 'attribute.value', foreground: '0a3069' },
      { token: 'delimiter', foreground: '24292f' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#24292f',
      'editorGutter.background': '#ffffff',
      'editorLineNumber.foreground': '#8c959f',
      'editorLineNumber.activeForeground': '#0550ae',
      'editor.selectionBackground': '#b6e3ff',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editorCursor.foreground': '#0550ae',
      'editorWidget.background': '#f6f8fa',
      'editorWidget.border': '#d0d7de',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#d0d7de',
      'editorSuggestWidget.selectedBackground': '#ddf4ff',
      'editorHoverWidget.background': '#ffffff',
      'editorHoverWidget.border': '#d0d7de',
      'scrollbarSlider.background': '#c9ced680',
      'scrollbarSlider.hoverBackground': '#aab2bd99',
      'scrollbarSlider.activeBackground': '#8c959f99',
      'focusBorder': '#0550ae',
      'input.background': '#ffffff',
      'input.border': '#d0d7de',
      'input.foreground': '#24292f',
      'badge.background': '#ddf4ff',
      'badge.foreground': '#24292f',
    },
  })
}

export function monacoThemeName(): string {
  return useSettingsStore.getState().theme === 'light' ? 'kinetic-light' : 'kinetic-dark'
}

/* --------------------------- inline completions ----------------------------- */

const INLINE_SYSTEM_PROMPT = `You are an inline code completion engine embedded in a code editor.
Given the file path, the code before the cursor (<before>) and the code after the cursor (<after>), output ONLY the code that should be inserted at the cursor position.
Rules:
- Output only raw code. No explanations, no markdown fences, no comments about what you are doing.
- Do not repeat code that is already present in <before> or <after>.
- Match the surrounding indentation and style exactly.
- If nothing should be inserted, output nothing.`

let inlineSeq = 0

function registerInlineCompletions(): void {
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      freeInlineCompletions() {},
      async provideInlineCompletions(model, position, _context, token) {
        const settings = useSettingsStore.getState()
        if (!settings.inlineCompletions) return { items: [] }
        const { provider, model: inlineModel } = resolveInlineModel(settings)
        if (!provider || !inlineModel) return { items: [] }

        // Debounce: only the most recent request proceeds.
        const seq = ++inlineSeq
        await sleep(350)
        if (seq !== inlineSeq || token.isCancellationRequested) return { items: [] }

        const path = model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path
        const prefix = model
          .getValueInRange({
            startLineNumber: Math.max(1, position.lineNumber - 150),
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          })
          .slice(-4000)
        const suffix = model
          .getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 80),
            endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 80)),
          })
          .slice(0, 2000)

        const controller = new AbortController()
        let completion = ''
        try {
          for await (const evt of streamChat({
            provider,
            model: inlineModel,
            messages: [
              { role: 'system', content: INLINE_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `<file path="${path}">\n<before>\n${prefix}\n</before>\n<after>\n${suffix}\n</after>\n</file>`,
              },
            ],
            signal: controller.signal,
            maxTokens: 256,
          })) {
            if (evt.type === 'text') {
              completion += evt.text
              if (completion.length > 1500) {
                controller.abort()
                break
              }
            } else if (evt.type === 'error') {
              break
            }
          }
        } catch {
          /* aborted or failed — no completion */
        }

        completion = stripCodeFences(completion.replace(/^\n+/, ''))
        if (!completion.trim()) return { items: [] }
        return {
          items: [
            {
              insertText: completion,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        }
      },
    },
  )
}

/* ------------------------------ AI code actions ----------------------------- */

function registerAICodeActions(): void {
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, _range, context) {
      const markers = context.markers.filter(
        (m) => m.severity >= monaco.MarkerSeverity.Warning,
      )
      if (markers.length === 0) return { actions: [], dispose: () => {} }
      return {
        actions: [
          {
            title: '✦ Fix with AI',
            kind: 'quickfix',
            diagnostics: markers,
            isPreferred: true,
            run: async () => {
              await fixProblems(model, markers)
            },
          },
        ],
        dispose: () => {},
      }
    },
  })
}

/* ------------------------------ model lifecycle ----------------------------- */

export async function ensureModel(path: string): Promise<monaco.editor.ITextModel | null> {
  const uri = monaco.Uri.file(path)
  const existing = monaco.editor.getModel(uri)
  if (existing) return existing
  try {
    const res = await api.fs.read(path)
    if (res.binary) return null
    const model = monaco.editor.createModel(res.content, languageForPath(path), uri)
    setSnapshot(path, res.content)
    return model
  } catch {
    return null
  }
}

export function disposeModel(path: string): void {
  const model = monaco.editor.getModel(monaco.Uri.file(path))
  if (model) model.dispose()
}

/** Reload open, non-dirty models whose files changed on disk. */
export async function syncOpenModelsWithDisk(): Promise<void> {
  const dirty = useEditorStore.getState().dirty
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== 'file') continue
    const path = model.uri.fsPath
    if (dirty[path]) continue
    try {
      const res = await api.fs.read(path)
      if (res.binary) continue
      if (res.content !== model.getValue()) {
        model.setValue(res.content)
      }
    } catch {
      /* file deleted — keep the buffer */
    }
  }
}

/* ------------------------------ editor options ------------------------------ */

export function editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  const s = useSettingsStore.getState()
  return {
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: s.editorFontSize,
    fontLigatures: true,
    minimap: { enabled: s.minimap, showSlider: 'mouseover', renderCharacters: false },
    wordWrap: s.wordWrap ? 'on' : 'off',
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    cursorBlinking: 'smooth',
    renderWhitespace: 'none',
    bracketPairColorization: { enabled: true },
    guides: { indentation: true, bracketPairs: true, bracketPairsHorizontal: true },
    stickyScroll: { enabled: true },
    padding: { top: 10, bottom: 10 },
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      alwaysConsumeMouseWheel: false,
    },
    overviewRulerLanes: 2,
    renderLineHighlight: 'line',
    lineNumbersMinChars: 3,
    folding: true,
    showFoldingControls: 'mouseover',
    matchBrackets: 'always',
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    autoSurround: 'languageDefined',
    formatOnPaste: true,
    formatOnType: true,
    suggest: { preview: true },
    inlineSuggest: { enabled: true },
    quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
    parameterHints: { enabled: true },
    hover: { enabled: true, delay: 300 },
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
    trimAutoWhitespace: true,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
  }
}

export function diffEditorOptions(): monaco.editor.IStandaloneDiffEditorConstructionOptions {
  return {
    ...editorOptions(),
    renderSideBySide: true,
    originalEditable: false,
    readOnly: false,
    renderOverviewRuler: false,
  }
}
