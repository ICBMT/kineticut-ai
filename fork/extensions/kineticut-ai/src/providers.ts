/**
 * Provider adapters for the Kineticut AI VS Code extension.
 * Zero runtime dependencies — uses the built-in fetch.
 *
 * Supports: Ollama (local), OpenAI-compatible APIs, Anthropic, Gemini.
 */

export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini'

export interface ProviderConfig {
  type: ProviderType
  baseUrl: string
  apiKey?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  toolCallId?: string
  name?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: { id: string; name: string; arguments: string } }
  | { type: 'error'; error: string }

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

async function* parseSSE(res: Response): AsyncGenerator<any> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data)
      } catch {
        /* keepalive */
      }
    }
  }
}

/** Stream a chat completion, normalized across providers. */
export async function* streamChat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number } = {},
): AsyncGenerator<StreamEvent> {
  try {
    if (provider.type === 'anthropic') {
      yield* streamAnthropic(provider, model, messages, opts)
    } else if (provider.type === 'gemini') {
      yield* streamGemini(provider, model, messages, opts)
    } else {
      yield* streamOpenAICompat(provider, model, messages, opts)
    }
  } catch (err) {
    if (opts.signal?.aborted) return
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

async function* streamOpenAICompat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number },
): AsyncGenerator<StreamEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) =>
      m.role === 'tool'
        ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        : m.role === 'assistant' && m.toolCalls?.length
          ? {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : { role: m.role, content: m.content },
    ),
    stream: true,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens

  const res = await fetch(joinUrl(provider.baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Provider error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const pending = new Map<number, { id: string; name: string; args: string }>()
  for await (const evt of parseSSE(res)) {
    const choice = evt?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (delta.content) yield { type: 'text', text: delta.content }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        let p = pending.get(idx)
        if (!p) {
          p = { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args: '' }
          pending.set(idx, p)
        }
        if (tc.function?.name) p.name = tc.function.name
        if (tc.function?.arguments) p.args += tc.function.arguments
      }
    }
    if (choice.finish_reason) {
      for (const p of pending.values()) {
        yield { type: 'tool_call', call: { id: p.id, name: p.name, arguments: p.args } }
      }
      pending.clear()
    }
  }
  for (const p of pending.values()) {
    yield { type: 'tool_call', call: { id: p.id, name: p.name, arguments: p.args } }
  }
}

async function* streamAnthropic(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number },
): AsyncGenerator<StreamEvent> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (provider.apiKey) headers['x-api-key'] = provider.apiKey
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const bodyMessages: any[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      bodyMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        let input: unknown = {}
        try {
          input = JSON.parse(tc.arguments || '{}')
        } catch {
          /* ignore */
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      bodyMessages.push({ role: 'assistant', content })
      continue
    }
    bodyMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: bodyMessages,
    stream: true,
  }
  if (systemText) body.system = systemText
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }
  const res = await fetch(joinUrl(provider.baseUrl || DEFAULT_BASE_URLS.anthropic, '/v1/messages'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  let currentTool: { id: string; name: string; args: string } | null = null
  for await (const evt of parseSSE(res)) {
    if (evt.type === 'content_block_start') {
      const block = evt.content_block
      if (block?.type === 'tool_use') currentTool = { id: block.id, name: block.name, args: '' }
      else if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text }
    } else if (evt.type === 'content_block_delta') {
      const delta = evt.delta
      if (delta?.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text }
      else if (delta?.type === 'input_json_delta' && delta.partial_json && currentTool) {
        currentTool.args += delta.partial_json
      }
    } else if (evt.type === 'content_block_stop') {
      if (currentTool) {
        yield {
          type: 'tool_call',
          call: { id: currentTool.id, name: currentTool.name, arguments: currentTool.args },
        }
        currentTool = null
      }
    } else if (evt.type === 'error') {
      yield { type: 'error', error: evt.error?.message || 'Anthropic API error' }
      return
    }
  }
}

async function* streamGemini(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number },
): AsyncGenerator<StreamEvent> {
  const base = (provider.baseUrl || DEFAULT_BASE_URLS.gemini).replace(/\/+$/, '')
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerate?alt=sse&key=${encodeURIComponent(provider.apiKey || '')}`
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const contents: any[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          { functionResponse: { name: m.name || 'tool', response: { content: m.content } } },
        ],
      })
      continue
    }
    if (m.role === 'assistant') {
      const parts: any[] = []
      if (m.content) parts.push({ text: m.content })
      for (const tc of m.toolCalls || []) {
        let args: unknown = {}
        try {
          args = JSON.parse(tc.arguments || '{}')
        } catch {
          /* ignore */
        }
        parts.push({ functionCall: { name: tc.name, args } })
      }
      contents.push({ role: 'model', parts })
      continue
    }
    contents.push({ role: 'user', parts: [{ text: m.content }] })
  }
  const body: Record<string, unknown> = { contents }
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] }
  if (opts.tools?.length) {
    body.tools = [
      {
        functionDeclarations: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ]
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  let toolIdx = 0
  for await (const evt of parseSSE(res)) {
    const parts = evt?.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part.text) yield { type: 'text', text: part.text }
      if (part.functionCall) {
        yield {
          type: 'tool_call',
          call: {
            id: `call_${toolIdx++}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        }
      }
    }
  }
}

/** List available models for the configured provider. */
export async function listModels(provider: ProviderConfig): Promise<string[]> {
  if (provider.type === 'ollama') {
    const res = await fetch(joinUrl(provider.baseUrl, '/api/tags'))
    if (!res.ok) throw new Error(`Ollama error ${res.status}`)
    const json = (await res.json()) as any
    return (json.models || []).map((m: any) => m.name)
  }
  if (provider.type === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
    })
    if (!res.ok) throw new Error(`Anthropic error ${res.status}`)
    const json = (await res.json()) as any
    return (json.data || []).map((m: any) => m.id)
  }
  if (provider.type === 'gemini') {
    const base = (provider.baseUrl || DEFAULT_BASE_URLS.gemini).replace(/\/+$/, '')
    const res = await fetch(
      `${base}/v1beta/models?key=${encodeURIComponent(provider.apiKey || '')}`,
    )
    if (!res.ok) throw new Error(`Gemini error ${res.status}`)
    const json = (await res.json()) as any
    return (json.models || []).map((m: any) => String(m.name).replace(/^models\//, ''))
  }
  const res = await fetch(joinUrl(provider.baseUrl, '/v1/models'), {
    headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined,
  })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  const json = (await res.json()) as any
  return (json.data || []).map((m: any) => m.id)
}
