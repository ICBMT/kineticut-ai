/**
 * Kineticut AI — VS Code extension entry point.
 *
 * Wires up:
 *  - the `@kineticut` chat participant (with /explain /refactor /tests /fix)
 *  - an agent loop with tools (read/search/write/run) that proposes edits
 *    as reviewable workspace edits and asks before running commands
 *  - AI inline (ghost text) completions
 *  - "Fix with AI" code actions on warnings/errors
 *  - editor context-menu commands + a status bar model indicator
 */
import * as vscode from 'vscode'
import {
  agentAutoApprove,
  getProviderConfig,
  inlineCompletionsEnabled,
  onConfigChange,
  resolveChatModel,
} from './config'
import {
  listModels,
  streamChat,
  type ChatMessage,
  type ProviderConfig,
  type ToolDef,
} from './providers'

/* ------------------------------- shared state ------------------------------- */

let statusBar: vscode.StatusBarItem | undefined
let cachedModels: string[] = []
let modelsCacheTime = 0

async function getModels(provider: ProviderConfig): Promise<string[]> {
  if (cachedModels.length > 0 && Date.now() - modelsCacheTime < 60_000) return cachedModels
  try {
    cachedModels = await listModels(provider)
    modelsCacheTime = Date.now()
  } catch {
    /* keep stale cache */
  }
  return cachedModels
}

/* ---------------------------------- tools ----------------------------------- */

const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file in the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries of a workspace directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative directory path.' } },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for text across workspace files.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'write_file',
    description:
      'Replace the entire content of a file. The change is applied as a reviewable edit. Provide the complete new content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Complete new file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a non-interactive shell command in the workspace terminal.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to run.' } },
      required: ['command'],
    },
  },
]

const AGENT_SYSTEM = `You are Kineticut AI Agent, an expert software engineer inside VS Code.
Inspect code with read_file / list_dir / search_code before editing. Prefer small, surgical changes.
write_file replaces the ENTIRE file — always provide complete content. run_command is for
non-interactive commands only. Summarize your changes when done.`

async function executeTool(
  call: { id: string; name: string; arguments: string },
  root: vscode.Uri | undefined,
  token: vscode.CancellationToken,
): Promise<string> {
  let args: any
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {
    return 'Error: invalid tool arguments.'
  }
  const rel = String(args.path || '')
  const abs = root ? vscode.Uri.joinPath(root, rel) : undefined
  try {
    switch (call.name) {
      case 'read_file': {
        if (!abs) return 'Error: no workspace folder.'
        const doc = await vscode.workspace.openTextDocument(abs)
        return doc.getText().slice(0, 60000)
      }
      case 'list_dir': {
        if (!abs) return 'Error: no workspace folder.'
        const entries = await vscode.workspace.fs.readDirectory(abs)
        return entries
          .map(([name, type]) => `${type === vscode.FileType.Directory ? '[dir] ' : '      '}${name}`)
          .join('\n')
      }
      case 'search_code': {
        const results = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 2000)
        const query: string = String(args.query || '').toLowerCase()
        const out: string[] = []
        for (const uri of results) {
          if (token.isCancellationRequested) break
          try {
            const doc = await vscode.workspace.openTextDocument(uri)
            const text = doc.getText()
            if (text.length > 500_000) continue
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                out.push(`${vscode.workspace.asRelativePath(uri)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
                if (out.length > 200) break
              }
            }
          } catch {
            /* skip binary */
          }
          if (out.length > 200) break
        }
        return out.join('\n') || 'no matches'
      }
      case 'write_file': {
        if (!abs) return 'Error: no workspace folder.'
        const content = String(args.content ?? '')
        const edit = new vscode.WorkspaceEdit()
        let current = ''
        try {
          current = (await vscode.workspace.openTextDocument(abs)).getText()
        } catch {
          /* new file */
        }
        const fullRange = new vscode.Range(0, 0, Math.max(0, current.split('\n').length), 0)
        edit.replace(abs, fullRange, content)
        const ok = await vscode.workspace.applyEdit(edit)
        return ok ? `Wrote ${rel} (${content.length} bytes, review the diff)` : 'Error: edit rejected.'
      }
      case 'run_command': {
        const command = String(args.command || '')
        if (!agentAutoApprove()) {
          const choice = await vscode.window.showWarningMessage(
            `Kineticut AI wants to run: ${command}`,
            { modal: true },
            'Run',
            'Cancel',
          )
          if (choice !== 'Run') return 'User rejected the command.'
        }
        const terminal = vscode.window.createTerminal({ name: 'Kineticut AI', cwd: root?.fsPath })
        terminal.show(false)
        terminal.sendText(command)
        return `Sent to terminal: ${command}`
      }
      default:
        return `Error: unknown tool ${call.name}`
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Run the agent loop for a chat request, streaming into `stream`. */
async function runAgent(
  provider: ProviderConfig,
  model: string,
  history: ChatMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  root: vscode.Uri | undefined,
): Promise<void> {
  const messages: ChatMessage[] = [{ role: 'system', content: AGENT_SYSTEM }, ...history]
  for (let step = 0; step < 8; step++) {
    if (token.isCancellationRequested) return
    const assistant: ChatMessage = { role: 'assistant', content: '' }
    for await (const evt of streamChat(provider, model, messages, { tools: TOOLS, signal: token })) {
      if (evt.type === 'text') {
        assistant.content += evt.text
        stream.markdown(evt.text)
      } else if (evt.type === 'tool_call') {
        assistant.toolCalls = [...(assistant.toolCalls || []), evt.call]
        stream.markdown(`\n\n🔧 `${'```'}\n${evt.call.name} ${summarizeArgs(evt.call.arguments)}\n${'```'}\n\n`)
      } else if (evt.type === 'error') {
        stream.markdown(`\n\n⚠️ ${evt.error}`)
        return
      }
    }
    messages.push(assistant)
    if (!assistant.toolCalls?.length) return
    for (const call of assistant.toolCalls) {
      if (token.isCancellationRequested) return
      const result = await executeTool(call, root, token)
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
    }
  }
}

function summarizeArgs(args: string): string {
  try {
    const parsed = JSON.parse(args)
    if (parsed.path) return `(${parsed.path})`
    if (parsed.command) return `(${parsed.command})`
    if (parsed.query) return `(${parsed.query})`
  } catch {
    /* ignore */
  }
  return ''
}

/* ---------------------------- inline completions ---------------------------- */

function registerInlineCompletions(context: vscode.ExtensionContext): void {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      if (!inlineCompletionsEnabled()) return []
      const provider = getProviderConfig()
      const model =
        (await import('./config')).getInlineModel().trim() ||
        (await resolveChatModel(provider, () => getModels(provider)))
      if (!model) return []

      const prefix = document
        .getText(
          new vscode.Range(
            new vscode.Position(Math.max(0, position.line - 150), 0),
            position,
          ),
        )
        .slice(-4000)
      const suffix = document
        .getText(
          new vscode.Range(
            position,
            new vscode.Position(Math.min(document.lineCount - 1, position.line + 80), 0),
          ),
        )
        .slice(0, 2000)

      const controller = new AbortController()
      token.onCancellationRequested(() => controller.abort())
      let completion = ''
      try {
        for await (const evt of streamChat(
          provider,
          model,
          [
            {
              role: 'system',
              content:
                'You are an inline code completion engine. Output ONLY the code to insert at the cursor. No explanations, no markdown fences, no repeating existing code. Match indentation. Output nothing if nothing should be inserted.',
            },
            {
              role: 'user',
              content: `<file path="${document.uri.fsPath}">\n<before>\n${prefix}\n</before>\n<after>\n${suffix}\n</after>\n</file>`,
            },
          ],
          { signal: controller.signal, maxTokens: 256 },
        )) {
          if (evt.type === 'text') {
            completion += evt.text
            if (completion.length > 1500) {
              controller.abort()
              break
            }
          }
        }
      } catch {
        /* aborted */
      }
      completion = completion.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
      if (!completion.trim()) return []
      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position),
        ),
      ]
    },
  }
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
  )
}

/* ------------------------------ code actions -------------------------------- */

function registerCodeActions(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionProvider({ scheme: 'file' }, {
      provideCodeActions(document, _range, context2) {
        const markers = context2.diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Warning || d.severity === vscode.DiagnosticSeverity.Error,
        )
        if (markers.length === 0) return []
        const action = new vscode.CodeAction('✦ Fix with AI', vscode.CodeActionKind.QuickFix)
        action.isPreferred = true
        action.command = {
          command: 'kineticut-ai.fixProblems',
          title: 'Fix with AI',
        }
        action.diagnostics = markers
        return [action]
      },
    }),
  )
}

/* ------------------------------- AI actions --------------------------------- */

async function produceEdit(
  instruction: string,
  scope: { path: string; text: string; language: string; wholeFile: boolean },
): Promise<string | null> {
  const provider = getProviderConfig()
  const model = await resolveChatModel(provider, () => getModels(provider))
  if (!model) {
    void vscode.window.showErrorMessage(
      'Kineticut AI: no model configured. Set kineticut.chat.model or start Ollama.',
    )
    return null
  }
  const target = scope.wholeFile ? 'file' : 'selection'
  let out = ''
  for await (const evt of streamChat(provider, model, [
    {
      role: 'system',
      content: `You are an expert code editing assistant. ${instruction}\nReturn ONLY the complete replacement code — no markdown fences, no explanations.`,
    },
    {
      role: 'user',
      content: `<${target} path="${scope.path}" language="${scope.language}">\n${scope.text}\n</${target}>`,
    },
  ])) {
    if (evt.type === 'text') out += evt.text
    else if (evt.type === 'error') {
      void vscode.window.showErrorMessage(`Kineticut AI: ${evt.error}`)
      return null
    }
  }
  const cleaned = out.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
  return cleaned.trim() ? cleaned : null
}

function activeScope(wholeFileFallback: boolean) {
  const editor = vscode.window.activeTextEditor
  if (!editor) return null
  const doc = editor.document
  const sel = editor.selection
  if (!sel.isEmpty) {
    return {
      uri: doc.uri,
      text: doc.getText(sel),
      language: doc.languageId,
      range: sel,
      wholeFile: false,
    }
  }
  if (wholeFileFallback) {
    return {
      uri: doc.uri,
      text: doc.getText().slice(0, 60000),
      language: doc.languageId,
      range: new vscode.Range(0, 0, doc.lineCount, 0),
      wholeFile: true,
    }
  }
  return null
}

async function explainSelection(): Promise<void> {
  const scope = activeScope(true)
  if (!scope) return
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: `Explain this ${scope.wholeFile ? 'file' : 'code'} (${vscode.workspace.asRelativePath(scope.uri)}):\n\n${scope.text.slice(0, 16000)}`,
  })
}

async function refactorSelection(): Promise<void> {
  const scope = activeScope(false)
  if (!scope) {
    void vscode.window.showInformationMessage('Kineticut AI: select some code first.')
    return
  }
  const out = await produceEdit(
    'Refactor this code to improve readability, structure and naming while preserving behavior exactly.',
    { path: scope.uri.fsPath, text: scope.text, language: scope.language, wholeFile: false },
  )
  if (out == null) return
  const edit = new vscode.WorkspaceEdit()
  edit.replace(scope.uri, scope.range, out)
  await vscode.workspace.applyEdit(edit)
}

async function generateTests(): Promise<void> {
  const scope = activeScope(true)
  if (!scope) return
  const out = await produceEdit(
    'Write a complete, runnable test suite for this code. Use the project conventions when obvious; include meaningful edge cases.',
    { path: scope.uri.fsPath, text: scope.text, language: scope.language, wholeFile: true },
  )
  if (out == null) return
  const edit = new vscode.WorkspaceEdit()
  edit.replace(scope.uri, scope.range, out)
  await vscode.workspace.applyEdit(edit)
}

async function fixProblems(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) return
  const markers = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Warning || d.severity === vscode.DiagnosticSeverity.Error,
    )
  if (markers.length === 0) {
    void vscode.window.showInformationMessage('Kineticut AI: no problems in the active file.')
    return
  }
  const problems = markers
    .map((m) => `- [${vscode.DiagnosticSeverity[m.severity].toLowerCase()}] ${m.message} (line ${m.range.start.line + 1})`)
    .join('\n')
  const out = await produceEdit(
    `Fix all of these problems:\n${problems}\nPreserve behavior except where a change is required.`,
    {
      path: editor.document.uri.fsPath,
      text: editor.document.getText().slice(0, 60000),
      language: editor.document.languageId,
      wholeFile: true,
    },
  )
  if (out == null) return
  const edit = new vscode.WorkspaceEdit()
  edit.replace(editor.document.uri, new vscode.Range(0, 0, editor.document.lineCount, 0), out)
  await vscode.workspace.applyEdit(edit)
}

/* ------------------------------ chat participant ---------------------------- */

function registerChatParticipant(context: vscode.ExtensionContext): void {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    const provider = getProviderConfig()
    const model = await resolveChatModel(provider, () => getModels(provider))
    if (!model) {
      stream.markdown(
        '⚠️ No AI model available. Start Ollama locally (`ollama serve`) or configure a frontier provider in **Kineticut AI** settings.',
      )
      return { metadata: { command: '' } }
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    const history: ChatMessage[] = []
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        history.push({ role: 'user', content: turn.prompt })
      } else if (turn instanceof vscode.ChatResponseTurn) {
        let text = ''
        for (const part of turn.response) {
          if (part instanceof vscode.ChatResponseMarkdownPart) text += part.value.value
        }
        if (text) history.push({ role: 'assistant', content: text })
      }
    }

    // Slash commands map to focused prompts.
    const command = request.command || ''
    let prompt = request.prompt
    if (command === 'explain') {
      prompt = `Explain the following code or file clearly and concisely:\n\n${request.prompt}`
    } else if (command === 'refactor') {
      prompt = `Refactor the following code to improve readability while preserving behavior. Return the full refactored code:\n\n${request.prompt}`
    } else if (command === 'tests') {
      prompt = `Write a complete test suite for the following code:\n\n${request.prompt}`
    } else if (command === 'fix') {
      const editor = vscode.window.activeTextEditor
      const diagnostics = editor
        ? vscode.languages.getDiagnostics(editor.document.uri)
        : []
      const list = diagnostics
        .map((d) => `- ${d.message} (line ${d.range.start.line + 1})`)
        .join('\n')
      prompt = `Fix these problems in ${editor ? editor.document.uri.fsPath : 'the active file'}:\n${list}\n\n${request.prompt}`
    }

    history.push({ role: 'user', content: prompt })

    // Agent mode when the user asks for changes (or uses no command with action-y wording).
    const wantsAgent =
      /\b(fix|refactor|implement|add|create|write|change|update|rename|delete|move|generate|make)\b/i.test(
        prompt,
      )
    if (wantsAgent) {
      await runAgent(provider, model, history, stream, token, root)
    } else {
      for await (const evt of streamChat(provider, model, history, { signal: token })) {
        if (evt.type === 'text') stream.markdown(evt.text)
        else if (evt.type === 'error') stream.markdown(`\n\n⚠️ ${evt.error}`)
      }
    }
    return { metadata: { command } }
  }

  const participant = vscode.chat.createChatParticipant('kineticut-ai.chat', handler)
  participant.iconPath = new vscode.ThemeIcon('sparkle')
  context.subscriptions.push(participant)
}

/* --------------------------------- activate --------------------------------- */

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10)
  statusBar.command = 'kineticut-ai.openChat'
  statusBar.text = '$(sparkle) Kineticut AI'
  statusBar.tooltip = 'Kineticut AI — click to open chat'
  statusBar.show()
  context.subscriptions.push(statusBar)

  const updateStatusBar = async () => {
    const provider = getProviderConfig()
    const model = await resolveChatModel(provider, () => getModels(provider))
    statusBar!.text = model ? `$(sparkle) ${model}` : '$(sparkle) Kineticut AI'
  }
  void updateStatusBar()
  context.subscriptions.push(onConfigChange(() => void updateStatusBar()))

  registerChatParticipant(context)
  registerInlineCompletions(context)
  registerCodeActions(context)

  context.subscriptions.push(
    vscode.commands.registerCommand('kineticut-ai.openChat', () =>
      vscode.commands.executeCommand('workbench.action.chat.open', { query: '@kineticut ' }),
    ),
    vscode.commands.registerCommand('kineticut-ai.explainSelection', () => void explainSelection()),
    vscode.commands.registerCommand('kineticut-ai.refactorSelection', () => void refactorSelection()),
    vscode.commands.registerCommand('kineticut-ai.generateTests', () => void generateTests()),
    vscode.commands.registerCommand('kineticut-ai.fixProblems', () => void fixProblems()),
    vscode.commands.registerCommand('kineticut-ai.configure', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'kineticut'),
    ),
  )
}

export function deactivate(): void {
  /* nothing to clean up */
}
