# Kineticut AI

**An AI-native code editor.** Chat with your code, get ghost-text completions as you
type, let an agent read/edit/test your project (with your approval), run a real
integrated terminal, search, and git — all in a fast, polished desktop app. Local
models via **Ollama**, frontier models (Claude, GPT, Gemini, …) via API. Built
**by forking VS Code** (the editor engine and a full fork overlay ship in this repo).

![Kineticut AI](assets/icon.svg)

## Features

- **AI Chat & Agent** — streaming chat with markdown + syntax highlighting; an
  *Agent mode* that reads/searches your workspace, proposes file edits (reviewed in
  a side-by-side diff), and runs commands (with confirmation). Works with Ollama
  locally and OpenAI-compatible / Anthropic / Gemini APIs.
- **The AI knows your project** — on folder open, Kineticut AI automatically
  analyzes the workspace (manifest, README, structure, key files) and writes a
  **project brief**; the brief is injected into every chat and agent prompt.
- **Inline completions** — AI ghost text as you type (Tab to accept), powered by the
  model of your choice.
- **AI code actions** — *Explain* (Ctrl+I), *Refactor selection*, *Generate tests*,
  and a **✦ Fix with AI** quick-fix on editor warnings/errors. Heavy edits are always
  reviewed in a diff modal first.
- **IDE-grade editing** — Monaco (the VS Code editor engine) with TypeScript
  IntelliSense, dirty tracking, quick open (Ctrl+P), command palette (Ctrl+Shift+P),
  custom dark/light themes, format document (Ctrl+Shift+I), go to line (Ctrl+G),
  format-on-save.
- **Multitasking** — **split editor groups** (side-by-side or stacked, up to 4),
  drag tabs between groups, double-click a tab to split it, "Open to the Side"
  from the explorer, and sessions (open tabs & layout) restored on restart.
- **Deep customization** — accent color themes (Ocean/Forest/Sunset/Rose/Mono),
  editor font family/size/line height, UI density (comfortable/compact), animations
  toggle, sidebar position (left/right), panel position (bottom/right), split
  direction — all live, all persisted.
- **Explorer / Search / Git** — lazy file tree with create/rename/delete, ripgrep
  workspace search, and a source-control panel (stage, unstage, commit, discard).
- **Integrated terminal** — real PTY (node-pty, with automatic fallbacks), multiple
  tabs, resizable panel (Ctrl+`), dockable bottom or right.
- **Works for any project** — open any folder; language support comes from Monaco's
  full language pack.
- **The VS Code fork** — `vscode/` is a submodule of `microsoft/vscode`; `fork/`
  contains our extension + branding overlay (`node fork/apply.mjs` after forking).

## Quick start

```bash
npm install

# Desktop app (Electron)
npm run dev          # dev mode with hot reload
npm run dist         # build installers (macOS dmg/zip, Windows nsis/zip, Linux AppImage/deb)

# Browser preview (no Electron needed)
npm run dev:web      # Vite dev server + API server + mock Ollama, on :5173
```

Then open the workspace folder, go to **Settings → Providers** (or the chat view),
pick a model, and start chatting. With no configuration, the web preview talks to a
built-in **mock Ollama** so the whole AI pipeline works out of the box.

### Using real models

- **Ollama (local, free)**: install [Ollama](https://ollama.com), `ollama pull qwen2.5-coder:7b`,
  then select it in the model picker (default provider is `http://127.0.0.1:11434`).
- **Frontier APIs**: Settings → Providers → *Add provider* → Anthropic / OpenAI-compatible /
  Gemini, paste an API key, *Fetch models*, pick one in the chat header.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+P` | Quick open file |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save all |
| `Ctrl+`` ` | Toggle terminal panel |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+I` | Explain code with AI |
| `Ctrl+Shift+A` | Toggle agent mode |
| `Ctrl+Shift+I` | Format document |
| `Ctrl+G` | Go to line |
| `Ctrl+,` | Settings |
| `Tab` | Accept inline completion |

## Project layout

```
├── src/
│   ├── main/            # Electron main process (window, IPC handlers)
│   ├── preload/         # contextBridge → window.kinetic
│   ├── renderer/        # React UI (Monaco, xterm, chat, explorer, git, search…)
│   ├── shared/          # KineticAPI types shared by main/preload/renderer
│   └── …
├── dev-server/          # HTTP/WS API server (powers the browser preview)
│   └── mock-ollama.mjs  # mock Ollama for demos/tests
├── fork/                # VS Code fork overlay (extension + apply script)
├── vscode/              # git submodule → microsoft/vscode
├── assets/              # icon + branding
└── scripts/             # icon generation, utilities
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and
[FORK.md](FORK.md) (or `fork/README.md`) for the VS Code fork workflow.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Electron dev mode |
| `npm run dev:web` | Browser preview (Vite + API server + mock Ollama) |
| `npm run build` | Build the Electron app (out/) |
| `npm run build:web` | Build the static web preview (dist-web/) |
| `npm run preview:web` | Serve the built web preview |
| `npm run dist` | Package installers with electron-builder |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | Headless render + regression test (needs `dev:web` running) |
| `npm run icon` | Regenerate `assets/icon.png` from `assets/icon.svg` |
| `npm run mock:ollama` | Run only the mock Ollama server (:11434) |

## License

[MIT](LICENSE)
