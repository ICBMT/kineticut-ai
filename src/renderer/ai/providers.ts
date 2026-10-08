/**
 * AI provider layer.
 *
 * Normalizes four backends behind one streaming interface:
 *   - ollama    — local models via Ollama's OpenAI-compatible endpoint
 *   - openai    — OpenAI-compatible APIs (OpenAI, OpenRouter, vLLM, LM Studio…)
 *   - anthropic — Claude (messages API)
 *   - gemini    — Google Gemini (streamGenerate)
 */
import { aiFetch, aiFetchTextStream } from '../lib/aiFetch'
import type {
  AIMessage,
  AIStreamEvent,
  AIToolDef,
  ProviderConfig,
  ProviderType,
} from './types'

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
}

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** Parse an SSE byte stream (as text chunks) into JSON event objects. */
export async function* parseSSE(stream: AsyncGenerator<string>): AsyncGenerator<any> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += chunk
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
        /* keepalive / partial */
      }
    }
  }
}

export interface StreamChatArgs {
  provider: ProviderConfig
  model: string
  messages: AIMessage[]
  tools?: AIToolDef[]
  signal?: AbortSignal
  maxTokens?: number
}

export async function* streamChat(args: StreamChatArgs): AsyncGenerator<AIStreamEvent> {
  const { provider, model, messages, tools, signal, maxTokens } = args
  try {
    switch (provider.type) {
      case 'ollama':
      case 'openai':
        yield* streamOpenAICompat(provider, model, messages, { tools, signal, maxTokens })
        break
      case 'anthropic':
        yield* streamAnthropic(provider, model, messages, { tools, signal, maxTokens })
        break
      case 'gemini':
        yield* streamGemini(provider, model, messages, { tools, signal, maxTokens })
        break
      default:
        throw new Error(`Unknown provider type: ${(provider as any).type}`)
    }
    yield { type: 'done' }
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      yield { type: 'done' }
      return
    }
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/* --------------------------- OpenAI-compatible ---------------------------- */

interface InternalOpts {
  tools?: AIToolDef[]
  signal?: AbortSignal
  maxTokens?: number
}

async function* streamOpenAICompat(
  provider: ProviderConfig,
  model: string,
  messages: AIMessage[],
  opts: InternalOpts,
): AsyncGenerator<AIStreamEvent> {
  const url = joinUrl(provider.baseUrl, '/v1/chat/completions')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      }
      return { role: m.role, content: m.content }
    }),
    stream: true,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    body.tool_choice = 'auto'
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens

  const stream = aiFetchTextStream(
    { url, method: 'POST', headers, body: JSON.stringify(body) },
    opts.signal,
  )
  const pending = new Map<number, { id: string; name: string; args: string }>()
  const flushPending = function* (): Generator<AIStreamEvent> {
    for (const p of pending.values()) {
      yield { type: 'tool_call', call: { id: p.id, name: p.name, arguments: p.args } }
    }
    pending.clear()
  }
  for await (const evt of parseSSE(stream)) {
    if (opts.signal?.aborted) return
    const choice = evt?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    // Reasoning-capable models (Ollama thinking models, DeepSeek-style APIs)
    // stream their thinking in a separate delta field.
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning }
    if (delta.content) yield { type: 'text', text: delta.content }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        let p = pending.get(idx)
        if (!p) {
          p = { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args: '' }
          pending.set(idx, p)
        }
        if (tc.id) p.id = tc.id
        if (tc.function?.name) p.name = tc.function.name
        if (tc.function?.arguments) p.args += tc.function.arguments
      }
    }
    if (choice.finish_reason) {
      yield* flushPending()
    }
  }
  yield* flushPending()
}

/* --------------------------------- Anthropic -------------------------------- */

async function* streamAnthropic(
  provider: ProviderConfig,
  model: string,
  messages: AIMessage[],
  opts: InternalOpts,
): AsyncGenerator<AIStreamEvent> {
  const url = joinUrl(provider.baseUrl || DEFAULT_BASE_URLS.anthropic, '/v1/messages')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    // Harmless for server-side calls; required for direct browser calls.
    'anthropic-dangerous-direct-browser-access': 'true',
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
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = bodyMessages[bodyMessages.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block)
      } else {
        bodyMessages.push({ role: 'user', content: [block] })
      }
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
          input = { raw: tc.arguments }
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

  const stream = aiFetchTextStream(
    { url, method: 'POST', headers, body: JSON.stringify(body) },
    opts.signal,
  )
  let currentTool: { id: string; name: string; args: string } | null = null
  for await (const evt of parseSSE(stream)) {
    if (opts.signal?.aborted) return
    if (evt.type === 'content_block_start') {
      const block = evt.content_block
      if (block?.type === 'tool_use') {
        currentTool = { id: block.id, name: block.name, args: '' }
      } else if (block?.type === 'text' && block.text) {
        yield { type: 'text', text: block.text }
      }
    } else if (evt.type === 'content_block_delta') {
      const delta = evt.delta
      if (delta?.type === 'text_delta' && delta.text) {
        yield { type: 'text', text: delta.text }
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        yield { type: 'reasoning', text: delta.thinking }
      } else if (delta?.type === 'input_json_delta' && delta.partial_json && currentTool) {
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

/* ---------------------------------- Gemini ---------------------------------- */

async function* streamGemini(
  provider: ProviderConfig,
  model: string,
  messages: AIMessage[],
  opts: InternalOpts,
): AsyncGenerator<AIStreamEvent> {
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
          {
            functionResponse: {
              name: m.name || 'tool',
              response: { content: m.content },
            },
          },
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

  const stream = aiFetchTextStream(
    { url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    opts.signal,
  )
  let toolIdx = 0
  for await (const evt of parseSSE(stream)) {
    if (opts.signal?.aborted) return
    const parts = evt?.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part.text) yield part.thought ? { type: 'reasoning', text: part.text } : { type: 'text', text: part.text }
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

/* ------------------------------ model listing ------------------------------- */

export async function listModels(provider: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  switch (provider.type) {
    case 'ollama': {
      const res = await aiFetch({ url: joinUrl(provider.baseUrl, '/api/tags') }, signal)
      if (res.status !== 200) throw new Error(`Ollama responded ${res.status}: ${res.body.slice(0, 200)}`)
      const json = JSON.parse(res.body)
      return (json.models || []).map((m: any) => m.name)
    }
    case 'openai': {
      const res = await aiFetch(
        {
          url: joinUrl(provider.baseUrl, '/v1/models'),
          headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined,
        },
        signal,
      )
      if (res.status !== 200) throw new Error(`API responded ${res.status}: ${res.body.slice(0, 200)}`)
      const json = JSON.parse(res.body)
      return (json.data || []).map((m: any) => m.id)
    }
    case 'anthropic': {
      const res = await aiFetch(
        {
          url: 'https://api.anthropic.com/v1/models',
          headers: {
            'x-api-key': provider.apiKey || '',
            'anthropic-version': '2023-06-01',
          },
        },
        signal,
      )
      if (res.status !== 200) throw new Error(`Anthropic responded ${res.status}: ${res.body.slice(0, 200)}`)
      const json = JSON.parse(res.body)
      return (json.data || []).map((m: any) => m.id)
    }
    case 'gemini': {
      const base = (provider.baseUrl || DEFAULT_BASE_URLS.gemini).replace(/\/+$/, '')
      const res = await aiFetch(
        { url: `${base}/v1beta/models?key=${encodeURIComponent(provider.apiKey || '')}` },
        signal,
      )
      if (res.status !== 200) throw new Error(`Gemini responded ${res.status}: ${res.body.slice(0, 200)}`)
      const json = JSON.parse(res.body)
      return (json.models || []).map((m: any) => String(m.name).replace(/^models\//, ''))
    }
    default:
      throw new Error(`Unknown provider type: ${(provider as any).type}`)
  }
}

export async function probeProvider(
  provider: ProviderConfig,
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const models = await listModels(provider, controller.signal)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Pull a model via Ollama, reporting NDJSON progress. */
export async function pullOllamaModel(
  provider: ProviderConfig,
  name: string,
  onProgress: (p: { status: string; completed: number; total: number }) => void,
  signal?: AbortSignal,
): Promise<void> {
  const stream = aiFetchTextStream(
    {
      url: joinUrl(provider.baseUrl, '/api/pull'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    },
    signal,
  )
  let buffer = ''
  for await (const chunk of stream) {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let evt: any
      try {
        evt = JSON.parse(line)
      } catch {
        continue
      }
      if (evt.error) throw new Error(String(evt.error))
      if (evt.status) {
        onProgress({ status: String(evt.status), completed: Number(evt.completed || 0), total: Number(evt.total || 0) })
      }
    }
  }
}
