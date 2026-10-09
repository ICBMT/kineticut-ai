/**
 * Mock Ollama server for development & demos.
 *
 * Implements just enough of the Ollama API for the Kineticut AI preview:
 *   GET  /api/tags                  — list "installed" models
 *   POST /api/show                  — model info
 *   POST /api/pull                  — fake pull with NDJSON progress
 *   POST /v1/chat/completions       — OpenAI-compatible streaming chat (SSE)
 *   POST /api/chat                  — native Ollama streaming chat (NDJSON)
 *
 * The "model" is a small rule-based responder so the whole AI pipeline
 * (streaming, markdown, tool calls for agent mode, inline completions)
 * can be exercised without a real Ollama install or GPU.
 *
 *   node dev-server/mock-ollama.mjs     # listens on 0.0.0.0:11434
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_OLLAMA_PORT || 11434)

const MODELS = [
  {
    name: 'kinetic-coder:7b',
    size: 4_700_000_000,
    modified_at: new Date().toISOString(),
    details: { family: 'qwen2.5-coder', parameter_size: '7B', quantization_level: 'Q4_K_M' },
  },
  {
    name: 'kinetic-coder:14b',
    size: 9_300_000_000,
    modified_at: new Date().toISOString(),
    details: { family: 'qwen2.5-coder', parameter_size: '14B', quantization_level: 'Q4_K_M' },
  },
  {
    name: 'kinetic-coder:32b',
    size: 20_000_000_000,
    modified_at: new Date().toISOString(),
    details: { family: 'qwen2.5-coder', parameter_size: '32B', quantization_level: 'Q4_K_M' },
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, r && ms))

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(obj))
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

/** Stream a string word-by-word as SSE chat-completion deltas. */
async function streamText(res, text, model, toolCalls, thinking = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  })
  const send = (delta) =>
    sse(res, {
      id: 'mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })
  send({ role: 'assistant', content: '' })
  // Like a real model: a short pause before the first token, and an optional
  // reasoning trace streamed in the separate `reasoning_content` field.
  await sleep(400)
  if (thinking) {
    for (const w of thinking.split(/(\s+)/)) {
      if (!w) continue
      send({ reasoning_content: w })
      await sleep(22)
    }
  }
  if (toolCalls) {
    for (const tc of toolCalls) {
      send({ tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] })
    }
  }
  const words = text.split(/(\s+)/)
  for (const w of words) {
    if (!w) continue
    send({ content: w })
    await sleep(18)
  }
  sse(res, {
    id: 'mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content || '')
  }
  return ''
}

function hasToolResult(messages) {
  return messages.some((m) => m.role === 'tool')
}

function extractAttachedFile(messages) {
  const text = lastUserMessage(messages)
  const m = text.match(/<attached-selection file="([^"]+)"/)
  return m ? m[1] : null
}

function cannedReply(messages, tools) {
  const user = lastUserMessage(messages).toLowerCase()

  // Inline-completion style request (system prompt asks for raw code only).
  const system = messages.find((m) => m.role === 'system')?.content || ''
  if (/inline code completion/i.test(system)) {
    return { text: "return items.map((item) => item?.value ?? null).filter(Boolean)\n", toolCalls: null }
  }

  // Test script for feature building: create a file, then edit it, then summarize.
  if (tools && tools.length && /mock:create-feature/.test(user)) {
    const last = [...messages].reverse().find((m) => m.role === 'tool')
    if (!last) {
      return {
        text: '',
        toolCalls: [{ id: 'call_feat_1', name: 'create_file', arguments: JSON.stringify({ path: 'scratch-feature/greet.ts', content: 'export function greet(name: string) {\n  return `Hello, ${name}`\n}\n' }) }],
      }
    }
    if (String(last.content).startsWith('Wrote ')) {
      return {
        text: '',
        toolCalls: [{ id: 'call_feat_2', name: 'edit_file', arguments: JSON.stringify({ path: 'scratch-feature/greet.ts', old_text: 'return `Hello, ${name}`', new_text: 'return `Hello, ${name}!`' }) }],
      }
    }
    return { text: 'Created `scratch-feature/greet.ts` and edited the greeting.', toolCalls: null }
  }

  // Agent mode: first turn → read a file; after tool results → summarize.
  if (tools && tools.length && !hasToolResult(messages)) {
    const file = extractAttachedFile(messages) || 'package.json'
    return {
      text: '',
      toolCalls: [
        { id: 'call_mock_1', name: 'read_file', arguments: JSON.stringify({ path: file }) },
      ],
    }
  }
  if (hasToolResult(messages)) {
    return {
      text:
        "I read the file as requested. Here's what I found:\n\n" +
        '- The project is **Kineticut AI**, an Electron-based AI-native code editor.\n' +
        "- It talks to Ollama locally and to frontier models over API.\n" +
        '- Agent mode can read, search, write (with your approval) and run commands.\n\n' +
        'Want me to refactor a file or generate tests next?',
      toolCalls: null,
    }
  }

  if (/hello|hi\b|hey/.test(user)) {
    return {
      text:
        "Hello! I'm the **Kineticut AI** mock model (standing in for Ollama).\n\n" +
        'I can chat, complete code inline, explain or refactor selections, and run as an agent with tools. ' +
        'Swap in a real Ollama server or a frontier API key in **Settings → Providers** for the full experience.',
      toolCalls: null,
    }
  }
  if (/test/.test(user)) {
    return {
      text:
        "Here's a test skeleton for this project:\n\n```ts\nimport { describe, it, expect } from 'vitest'\n\ndescribe('kineticut-ai', () => {\n  it('greets', () => {\n    expect('kinetic').toContain('kinetic')\n  })\n})\n```\n\nRun it with `npm test` once vitest is wired up.",
      toolCalls: null,
    }
  }
  if (/refactor/.test(user)) {
    return {
      text:
        'Sure — general refactoring advice:\n\n1. Extract repeated logic into small pure functions.\n2. Prefer explicit types at module boundaries.\n3. Keep components small and state close to where it is used.\n\nSelect code in the editor and use **AI → Refactor Selection** to apply this to real code.',
      toolCalls: null,
    }
  }
  if (/explain/.test(user)) {
    return {
      text:
        'This workspace is an **Electron + React + Monaco** app. The renderer talks to a `KineticAPI` surface that is implemented twice: Electron IPC (desktop) and this dev server (web preview). AI providers (Ollama, OpenAI-compatible, Anthropic, Gemini) are normalized behind one streaming adapter.',
      toolCalls: null,
    }
  }
  return {
    text:
      `You said: "${lastUserMessage(messages).slice(0, 200)}"\n\n` +
      "I'm the mock Ollama responder, so my knowledge is limited — but the full pipeline works: " +
      'streaming, markdown rendering, tool calls (try **Agent** mode), and inline completions. ' +
      'Configure a real provider in Settings for frontier-grade answers.',
    toolCalls: null,
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method || 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' })
    res.end()
    return
  }

  if (path === '/' || path === '/api/version') {
    return sendJson(res, 200, { version: '0.0.0-mock' })
  }

  if (path === '/api/tags' && method === 'GET') {
    return sendJson(res, 200, { models: MODELS })
  }

  if (path === '/api/show' && method === 'POST') {
    const { name } = JSON.parse(await readBody(req) || '{}')
    const model = MODELS.find((m) => m.name === name)
    if (!model) return sendJson(res, 404, { error: 'model not found' })
    return sendJson(res, 200, { modelfile: '', parameters: '', details: model.details })
  }

  if (path === '/api/pull' && method === 'POST') {
    const { name, stream = true } = JSON.parse(await readBody(req) || '{}')
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*' })
    const total = 4_700_000_000
    for (let i = 0; i <= 10; i++) {
      res.write(JSON.stringify({ status: i === 10 ? 'success' : 'pulling', total, completed: (total * i) / 10 }) + '\n')
      await sleep(120)
    }
    if (!MODELS.some((m) => m.name === name)) {
      MODELS.push({ name, size: total, modified_at: new Date().toISOString(), details: { family: 'mock', parameter_size: '?', quantization_level: 'Q4' } })
    }
    res.end()
    return
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}')
    const messages = body.messages || []
    const reply = cannedReply(messages, body.tools)
    // Questions that ask "why" / "think" / "reason" get a visible reasoning trace.
    const thinking = /\b(why|think|reason)/i.test(lastUserMessage(messages))
      ? 'The user wants the reasoning behind this. I will check the project context I was given, pick the files that matter, and answer concisely. '
      : null
    return streamText(res, reply.text, body.model || 'kinetic-coder:7b', reply.toolCalls, thinking)
  }

  if (path === '/v1/models' && method === 'GET') {
    return sendJson(res, 200, { object: 'list', data: MODELS.map((m) => ({ id: m.name, object: 'model', created: Date.now(), owned_by: 'ollama' })) })
  }

  if (path === '/api/chat' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}')
    const messages = body.messages || []
    const reply = cannedReply(messages, body.tools)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*' })
    if (reply.toolCalls) {
      for (const tc of reply.toolCalls) {
        res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: tc.name, arguments: JSON.parse(tc.arguments) } }] }, done: false }) + '\n')
      }
    }
    const words = reply.text.split(/(\s+)/)
    for (const w of words) {
      if (!w) continue
      res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: w }, done: false }) + '\n')
      await sleep(18)
    }
    res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true }) + '\n')
    res.end()
    return
  }

  return sendJson(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-ollama] listening on http://0.0.0.0:${PORT} — models: ${MODELS.map((m) => m.name).join(', ')}`)
})
