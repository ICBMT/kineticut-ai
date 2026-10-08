export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini'

export interface ProviderConfig {
  id: string
  type: ProviderType
  name: string
  baseUrl: string
  apiKey?: string
  models: string[]
}

export interface AIToolCall {
  id: string
  name: string
  /** Raw JSON string of arguments. */
  arguments: string
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: AIToolCall[]
  toolCallId?: string
  name?: string
}

export interface AIToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type AIStreamEvent =
  | { type: 'text'; text: string }
  /** The model's visible reasoning / thinking trace (reasoning-capable models only). */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: AIToolCall }
  | { type: 'error'; error: string }
  | { type: 'done' }
