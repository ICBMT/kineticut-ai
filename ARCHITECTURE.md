# Architecture

Kineticut AI is a desktop **Electron** app whose UI is a **React** app built on
**Monaco** (the editor engine that powers VS Code) and **xterm.js**, with a custom
AI-native layer on top. The same renderer also runs in a browser as a live preview.

## The one-API, two-transports design

The entire backend surface is a single typed interface, `KineticAPI`
(`src/shared/types.ts`):

```
system  — info, openFolder, exec, openExternal
fs      — list, tree, read, write, mkdir, remove, rename, stat, watch
search  — ripgrep-powered workspace search
git     — status, stage, unstage, discard, commit, init
terminal— create (pty), write, resize, kill, onData, onExit
net     — fetch, fetchStream (streaming)
settings— get / set (persisted server-side)
win     — minimize, maximize, close, editRole, …
```

It is implemented **twice**:

| Transport | Used by | Implementation |
| --- | --- | --- |
| **Electron IPC** | Desktop app | `src/main/ipc.ts` (handlers) + `src/preload/index.ts` (`contextBridge` → `window.kinetic`) |
| **HTTP + WebSocket + SSE** | Browser preview | `dev-server/index.mjs` on `:4890`; Vite proxies `/api/*` to it |

The renderer picks a transport at startup (`src/renderer/api/index.ts`):

```ts
export const bridge = window.kinetic ?? null          // Electron
export const api = bridge ?? createHttpApi()           // browser preview
```

Every component talks only to `api`, so the desktop app and the web preview are the
*same product* — the preview is how this repo is demoed and smoke-tested without a
display.

## Renderer layers

```
src/renderer/
├── api/         transport selection + HTTP/WS client
├── ai/          provider adapters (ollama | openai | anthropic | gemini), agent loop
├── lib/         monaco setup (themes, workers, inline completions, code actions),
│                aiFetch (CORS-free streaming), fuzzy, markdown, aiActions
├── store/       zustand stores: app, settings, editor, ai, terminal
├── commands.ts  command registry + global keybindings
└── components/  TitleBar, ActivityBar, SideBar (Explorer/Search/Git/Chat/Settings),
                 EditorArea, TerminalPanel, StatusBar, CommandPalette, QuickOpen,
                 Toasts, DiffModal/ConfirmModal/PromptModal, ui primitives
```

### AI layer (`src/renderer/ai/`)

- `providers.ts` normalizes four backends into one streaming interface
  (`streamChat` → `{text | tool_call | error | done}` events):
  - **Ollama** — local, via its OpenAI-compatible `/v1/chat/completions`
  - **OpenAI-compatible** — OpenAI, OpenRouter, vLLM, LM Studio…
  - **Anthropic** — `/v1/messages` (streaming tool use included)
  - **Gemini** — `streamGenerate?alt=sse`
  - Model discovery (`/api/tags`, `/v1/models`, …) and Ollama `pull` with progress.
- `agent.ts` is the **tool-use loop**: `list_dir`, `read_file`, `search_code`,
  `write_file` (shown in a diff modal for approval), `run_command` (confirmation),
  `open_file`. Bounded steps, abortable, tool results fed back to the model.
- `lib/aiFetch.ts` routes provider HTTP: through the main process in Electron
  (no CORS, can reach localhost), directly from the browser for external APIs,
  and through the dev-server proxy for localhost targets in the preview.

### Editing (`lib/monaco.ts`)

- Monaco ESM with web workers (editor/json/css/html/ts).
- Custom `kinetic-dark` / `kinetic-light` themes matching the UI palette.
- One Monaco model per open file (path-keyed), disk snapshots for dirty tracking,
  external-change sync via `fs.watch`.
- **Inline completions provider**: debounced (350 ms), prefix/suffix context,
  code-only system prompt, 1.5 k-char cap.
- **"✦ Fix with AI" code action** on warnings/errors → AI rewrite → diff modal.

### Terminal

`node-pty` (N-API prebuilds) when available → `script(1)` pty wrapper → plain
pipes. In this sandbox node headers are unreachable, so the fallback layers are
exercised; on a normal machine `npm install` builds node-pty automatically
(it's an `optionalDependency`, so install never breaks).

## Main process (`src/main/`)

- Frameless `BrowserWindow` (custom title bar with menus + window controls),
  single-instance lock, native menu on macOS, dev/prod URL loading.
- `ipc.ts` implements every `KineticAPI` handler: fs (with chokidar watchers and
  200 ms event batching), ripgrep search with a pure-JS fallback, simple-git,
  node-pty terminals with stdout→renderer events, streaming `net.fetch` (chunked
  over IPC), settings persisted to `userData`.

## Dev server (`dev-server/`)

- `index.mjs` — `node:http` + `ws` server mirroring `KineticAPI` over
  `/api/*` (SSE for `fs.watch` and `net/stream`, WebSocket for terminals).
  Settings persist to `~/.kineticut-dev-settings.json`; workspace root defaults to
  the repo (override with `KINETICUT_ROOT`).
- `mock-ollama.mjs` — a mock Ollama (`/api/tags`, `/v1/chat/completions` SSE,
  `/api/pull` NDJSON progress) with a small rule-based "model" so streaming,
  markdown, tool calls and inline completions are all exercisable offline.

## The VS Code fork

`vscode/` is a git submodule of upstream `microsoft/vscode`. The fork delta lives
in `fork/`:

- `fork/extensions/kineticut-ai/` — a real VS Code extension (zero runtime deps):
  `@kineticut` chat participant with agent tools, inline completions, "Fix with AI"
  code actions, context-menu commands, `kineticut.*` settings, status bar.
- `fork/apply.mjs` — copies the extension into `vscode/extensions/`, patches
  `product.json` branding, prints the commit/push instructions.

Fork `microsoft/vscode` on GitHub, point the submodule at your fork, run
`node fork/apply.mjs`, commit, push. See `fork/README.md`.

## Data & persistence

- Desktop: settings in `userData/kineticut-settings.json`; chat sessions and layout
  in `localStorage` (zustand `persist`).
- Preview: settings in `~/.kineticut-dev-settings.json`; sessions in `localStorage`.
- API keys live only in the local settings store.
