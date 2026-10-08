/**
 * Slash commands for the chat composer. Typing `/` opens the menu; a command
 * expands into a well-formed prompt, and the code it refers to (the selection,
 * or the open file) is attached automatically.
 */

export interface SlashCommand {
  name: string
  label: string
  hint: string
  /** Prompt template sent to the model. */
  prompt?: string
  /** Attach the code the user is looking at when no attachment is set. */
  needsCode?: boolean
  /** Built-in action instead of a prompt. */
  action?: 'clear'
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'explain',
    label: 'Explain',
    hint: 'Explain what the code does and how it works',
    needsCode: true,
    prompt:
      'Explain this code clearly: what it does, how it works step by step, and any non-obvious parts or pitfalls.',
  },
  {
    name: 'review',
    label: 'Review',
    hint: 'Find bugs, edge cases and readability issues',
    needsCode: true,
    prompt:
      'Review this code. List concrete bugs, edge cases and readability issues, most severe first, and give a suggested fix for each.',
  },
  {
    name: 'fix',
    label: 'Fix',
    hint: 'Find the root cause and give the corrected code',
    needsCode: true,
    prompt:
      'Find the bug or problem in this code, explain the root cause, and give the corrected code.',
  },
  {
    name: 'tests',
    label: 'Tests',
    hint: 'Write a unit test suite for this code',
    needsCode: true,
    prompt:
      'Write a focused unit test suite for this code covering the normal path, edge cases and failure modes. Use the testing style already used in this project if you can tell.',
  },
  {
    name: 'docs',
    label: 'Docs',
    hint: 'Write doc comments and a usage example',
    needsCode: true,
    prompt:
      'Write clear doc comments for the public API in this code, plus a short usage example.',
  },
  {
    name: 'refactor',
    label: 'Refactor',
    hint: 'Improve structure without changing behavior',
    needsCode: true,
    prompt:
      'Refactor this code for readability and maintainability without changing its behavior. Show the refactored code and briefly explain the key changes.',
  },
  {
    name: 'project',
    label: 'Project',
    hint: 'Explain what this project is and how it is organized',
    prompt:
      'Explain what this project is for, how it is organized, and where a new developer should start reading.',
  },
  {
    name: 'clear',
    label: 'Clear',
    hint: 'Clear this chat',
    action: 'clear',
  },
]

/** The partial command being typed (`/ex` → `ex`), or null when not in command mode. */
export function slashQuery(text: string): string | null {
  const m = /^\/([a-z-]*)$/i.exec(text)
  return m ? m[1].toLowerCase() : null
}

/** Commands whose name starts with the query first, then ones that contain it. */
export function filterSlash(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  const starts = SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  const contains = SLASH_COMMANDS.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.hint.toLowerCase().includes(q)))
  return [...starts, ...contains]
}

export type SlashExpansion =
  | { kind: 'clear' }
  | { kind: 'prompt'; text: string; needsCode: boolean }

/** Expand `/command [extra instructions]` into a prompt, or null if it is not a command. */
export function expandSlash(input: string): SlashExpansion | null {
  const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(input.trim())
  if (!m) return null
  const cmd = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase())
  if (!cmd) return null
  if (cmd.action === 'clear') return { kind: 'clear' }
  const extra = (m[2] || '').trim()
  return {
    kind: 'prompt',
    text: extra ? `${cmd.prompt}\n\nAdditional instructions: ${extra}` : cmd.prompt || '',
    needsCode: Boolean(cmd.needsCode),
  }
}
