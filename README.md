# Kineticut AI

**An AI-native code editor.** Chat with your code, get ghost-text completions as you
type, let an agent read/edit/test your project (with your approval), run a real
integrated terminal, search, and git — all in a fast, polished desktop app. Local
models via **Ollama**, frontier models (Claude, GPT, Gemini, …) via API. Built
**by forking VS Code** (the editor engine and a full fork overlay ship in this repo).

![Kineticut AI](assets/icon.svg)

## Features

- **AI Chat & Agent** — streaming chat with markdown + syntax highlighting; an
  *Agent mode* that reads/searches your workspace, builds features by creating new
  files and making exact-text edits to existing ones (`create_file`, `edit_file`),
  and runs commands (with confirmation). Every write is reviewed in a side-by-side
  diff, where you can adjust the proposal before applying it. Works with Ollama
  locally and OpenAI-compatible / Anthropic / Gemini APIs.
- **Cursor-style workflow.** **Ctrl+K** rewrites the selected code from a short
  instruction and shows the change as an inline diff before anything is applied.
  Every agent turn is a **checkpoint**: the reply lists the files it changed, opens
  them, and **Undo changes** restores them (files you edited since are left alone).
- **Workspace connected to the AI, the way Cursor does it.** The project is indexed in
  the background into syntax-aware chunks (whole functions and classes, carrying their
  names) and kept current by content hash, so a save with no text change costs nothing.
  Search by meaning is **on by default**: the best embedding model Ollama has installed
  (for example `nomic-embed-text`) is used automatically, and Settings offers a one-click
  install when none is. Keyword search always works and needs no AI call. Files matched by
  `.gitignore` or `.cursorignore` are never indexed or searched.
  The **agent finds code with its tools**, as Cursor's agent does: `codebase_search`
  (by meaning and keywords), `grep_search` (exact text), `file_search` (file names),
  and `read_file` with line ranges. Nothing is pasted into an agent prompt that it did
  not ask for. Chat (no tools) gets the matching snippets up front. *Settings → Workspace
  mode → Classic* restores the previous whole-file retrieval.
- **Project rules like Cursor's.** `.cursor/rules/*.mdc` files with `alwaysApply`, `globs`
  and `description` frontmatter: rules that apply to the open file go into every request,
  and description-only rules are listed so the agent can read them when they are relevant.
  Also read: `.kineticut/rules.md`, `AGENTS.md`, `.cursorrules` and
  `.github/copilot-instructions.md`. The command *Create Project Rules File* writes a starter.
- **Chat shortcuts like Cursor's.** **Ctrl+L** focuses the chat, **Ctrl+I** opens the agent
  composer, and **Ctrl+Shift+L** attaches the selected code to the chat. The `@codebase`
  mention searches the whole index.
- **Review every agent change at once.** By default (*Settings → Review agent changes →
  Review at the end*) agent writes are **staged**, not written: later steps in the
  turn build on the staged text, and a banner in the chat opens the review
  (`Ctrl+Alt+R`). Accept or reject each hunk, accept or reject a whole file, then apply.
  Applying re-checks the file on disk, so edits you made meanwhile are never overwritten.
  Choose *Diff for each write* to get a diff per write instead.
- **Several chats at once.** Each chat runs its own agent. Switch chats while one works;
  the history shows a spinner on running chats, and a toast tells you when one finishes.
- **Mention code in the composer.** `@path/to/file.ts` includes a file, `@src/lib/`
  includes a folder's files with their summaries and symbols, and `@symbol:Name`
  includes the code where that symbol is defined.
- **Next-edit suggestions.** Inline suggestions follow what you are typing: they see your
  last edits in the file (so a rename continues below), the signatures of the project
  symbols the file imports, and can span several lines (`Tab` accepts).
- **Starts empty, remembers everything.** Kineticut opens with no folder and no file;
  you choose what to work on. Your projects and chats are kept: **Projects & Chats**
  (`Ctrl+Alt+H`, or the history button in the AI chat header) lists every project you
  opened and every chat you had, grouped by project, so you can resume old work.
- **The AI understands your project, read from the code.** The project index (a
  persistent, incremental, low-resource index in the Electron main process) reads
  languages, frameworks, entry points, a digest of each directory, and what the app is
  for. **Build Project Understanding** then reads the code top-down and writes a
  one-line summary of each file. When you ask a question, the AI is handed the relevant
  files and their summaries; the `recall_file` agent tool returns **any** project file
  from memory at any moment, by path or name.
- **Dual sidebars** — the project sidebar (explorer/search/git/settings) and the
  AI chat sidebar are independent and visible **at the same time**, each on its
  configured side (left/right, swappable in Settings → Layout).
- **Inline completions** — AI ghost text as you type (Tab to accept), powered by the
  model of your choice.
- **Chat ergonomics** — copy, regenerate, edit-and-resend the last prompt, retry on
  error, `/explain` `/tests` `/review` `/fix` `/docs` `/clear` slash commands, and an
  `@file` picker over the project index.
- **AI code actions** — *Explain* (command palette), *Refactor selection*, *Generate tests*,
  and a **✦ Fix with AI** quick-fix on editor warnings/errors. Heavy edits are always
  reviewed in a diff modal first.
- **IDE-grade editing** — Monaco (the VS Code editor engine) with TypeScript
  IntelliSense, dirty tracking, quick open (Ctrl+P), command palette (Ctrl+Shift+P),
  custom dark/light themes, format document (Ctrl+Shift+I), go to line (Ctrl+G),
  format-on-save. **Autosave** (off / after a pause / when the editor loses focus),
  **breadcrumbs** above the editor, and a status bar showing the real language,
  indentation, line endings and encoding.
- **Multitasking** — **split editor groups** (side-by-side or stacked, up to 4),
  drag tabs between groups, double-click a tab to split it, "Open to the Side"
  from the explorer, and sessions (open tabs & layout) restored on restart.
- **Deep customization** — accent color themes (Ocean/Forest/Sunset/Rose/Mono),
  editor font family/size/line height, UI density (comfortable/compact), animations
  toggle, sidebar position (left/right), panel position (bottom/right), split
  direction — all live, all persisted.
- **Explorer / Search / Git** — lazy file tree with create/rename/delete, ripgrep
  workspace search, and a source-control panel (stage, unstage, commit, discard).
  Click any changed file (or use **Git: Show Changes**) to review it against HEAD.
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
| `Ctrl+I` | Agent composer: ask the agent to build or change code across files |
| `Ctrl+Shift+L` | Attach the selected code to the chat |
| `Ctrl+K` | Edit the selection (or line) with AI, reviewed in place (`Ctrl+Enter` accept, `Esc` reject). Overrides Monaco's `Ctrl+K Ctrl+C`-style chords |
| `Ctrl+Shift+A` | Toggle agent mode |
| `Ctrl+Alt+R` | Review staged AI changes (accept or reject per hunk) |
| `Ctrl+Alt+B` | Toggle AI chat sidebar |
| `Ctrl+Shift+I` | Format document |
| `Ctrl+G` | Go to line |
| `Ctrl+,` | Settings |
| `Ctrl+L` / `Ctrl+Alt+L` | Focus the AI chat input |
| `Ctrl+Alt+/` | Keyboard shortcuts reference (searchable) |
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
| `npm run smoke:codebase` | Codebase index test: ignore files, content hashes, chunks, embeddings, restart (no browser) |
| `npm run icon` | Regenerate `assets/icon.png` from `assets/icon.svg` |
| `npm run mock:ollama` | Run only the mock Ollama server (:11434) |

## License

[MIT](LICENSE)
