# Kineticut AI for VS Code

The Kineticut AI assistant, packaged as a native VS Code extension:

- **Chat participant** (`@kineticut` in the Chat view) with slash commands:
  `/explain`, `/refactor`, `/tests`, `/fix`
- **Agent-style tools**: read files, search the workspace, propose edits
  (shown as a reviewable diff), and run terminal commands with confirmation
- **Inline completions**: ghost-text suggestions from your local or frontier model
- **AI code actions**: "Fix with AI" on warnings/errors, plus editor context-menu
  actions (Explain / Refactor / Generate Tests)
- **Providers**: Ollama (local, default `http://127.0.0.1:11434`),
  OpenAI-compatible endpoints (OpenRouter, vLLM, LM Studio…), Anthropic, Gemini

## Configure

Open VS Code Settings and search for **Kineticut**:

| Setting | Default | Description |
| --- | --- | --- |
| `kineticut.provider.type` | `ollama` | `ollama`, `openai`, `anthropic` or `gemini` |
| `kineticut.provider.baseUrl` | `http://127.0.0.1:11434` | Provider base URL |
| `kineticut.provider.apiKey` | _(empty)_ | API key for frontier providers |
| `kineticut.chat.model` | _(empty)_ | Chat model (empty = first available) |
| `kineticut.inline.model` | _(empty)_ | Inline completion model |
| `kineticut.inline.enabled` | `true` | Toggle ghost-text completions |
| `kineticut.agent.autoApprove` | `false` | Skip edit/command confirmations |

## Develop

```bash
cd extensions/kineticut-ai
npm install
npm run watch     # then press F5 in VS Code to debug the extension host
```

The extension has **zero runtime dependencies** — all provider calls use the
built-in `fetch`.
