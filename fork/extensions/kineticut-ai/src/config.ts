import * as vscode from 'vscode'
import { DEFAULT_BASE_URLS, type ProviderConfig, type ProviderType } from './providers'

const SECTION = 'kineticut'

function get<T>(key: string, fallback: T): T {
  const value = vscode.workspace.getConfiguration(SECTION).get<T>(key)
  return value === undefined ? fallback : value
}

/** Read the current provider configuration. */
export function getProviderConfig(): ProviderConfig {
  const type = get<ProviderType>('provider.type', 'ollama')
  return {
    type,
    baseUrl: get<string>('provider.baseUrl', DEFAULT_BASE_URLS[type]),
    apiKey: get<string>('provider.apiKey', '') || undefined,
  }
}

export function getChatModel(): string {
  return get<string>('chat.model', '')
}

export function getInlineModel(): string {
  return get<string>('inline.model', '')
}

export function inlineCompletionsEnabled(): boolean {
  return get<boolean>('inline.enabled', true)
}

export function agentAutoApprove(): boolean {
  return get<boolean>('agent.autoApprove', false)
}

/** Resolve the effective chat model: configured → first available. */
export async function resolveChatModel(
  provider: ProviderConfig,
  listModels: () => Promise<string[]>,
): Promise<string | null> {
  const configured = getChatModel().trim()
  if (configured) return configured
  try {
    const models = await listModels()
    return models[0] || null
  } catch {
    return null
  }
}

export function onConfigChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) listener()
  })
}
