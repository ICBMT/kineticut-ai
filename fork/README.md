# The VS Code Fork

Kineticut AI is built **by forking VS Code** — the repo contains the upstream
[`microsoft/vscode`](https://github.com/microsoft/vscode) checkout as a
[git submodule](./vscode) (`vscode/`), and this directory holds our fork delta:

```
fork/
├── apply.mjs                     # copies the overlay into vscode/ + patches product.json
├── README.md                     # this file
└── extensions/
    └── kineticut-ai/             # the Kineticut AI VS Code extension
        ├── package.json          # manifest: chat participant, commands, settings, menus
        ├── tsconfig.json
        ├── README.md
        └── src/
            ├── extension.ts      # chat participant + agent + inline completions + code actions
            ├── providers.ts      # Ollama / OpenAI-compatible / Anthropic / Gemini adapters
            └── config.ts         # kineticut.* settings access
```

## How to create the fork and apply the overlay

> The sandbox that produced this repo cannot create GitHub forks (scoped token),
> so the fork is created by you with one click — the delta ships here.

1. **Fork on GitHub**: open https://github.com/microsoft/vscode and click **Fork**
   (creates `github.com/<you>/vscode`).
2. **Clone your fork** and point the submodule at it:

   ```bash
   git clone https://github.com/<you>/vscode.git vscode
   cd vscode && git checkout <branch-you-want-to-build>
   ```

   (or, if you already have this repo with the upstream submodule:
   `cd vscode && git remote set-url origin https://github.com/<you>/vscode.git`)
3. **Apply the overlay** from this repo:

   ```bash
   node fork/apply.mjs            # defaults to ./vscode
   ```

   This copies `fork/extensions/kineticut-ai` → `vscode/extensions/kineticut-ai`
   and patches `vscode/product.json` branding:
   `nameShort: "Kineticut AI Code"`, `applicationName: "kineticut-ai-code"`, etc.
4. **Commit and push to your fork**:

   ```bash
   cd vscode
   git add extensions/kineticut-ai product.json
   git commit -m "Add Kineticut AI extension + branding"
   git push origin HEAD
   ```

## What the extension adds to VS Code

- **Chat participant `@kineticut`** in the Chat view with `/explain`, `/refactor`,
  `/tests`, `/fix` slash commands. Action-y prompts run an **agent loop** with tools
  (`read_file`, `list_dir`, `search_code`, `write_file` as reviewable edits,
  `run_command` with confirmation).
- **AI inline completions** (ghost text) from the configured model.
- **"✦ Fix with AI"** quick-fix code action on warnings/errors.
- **Editor context menu** actions: Explain / Refactor / Generate Tests.
- **Settings** under `kineticut.*`: provider type/base URL/API key, chat model,
  inline model, inline toggle, agent auto-approve.
- **Providers**: Ollama (local, default), OpenAI-compatible (OpenRouter, vLLM,
  LM Studio…), Anthropic, Gemini. Zero runtime dependencies (built-in `fetch`).
- **Status bar** shows the active model.

## Building the fork (full VS Code workbench)

A full workbench build is heavy (≈8 GB RAM, 10–30 min) but standard:

```bash
cd vscode
yarn                # install dependencies
yarn watch          # dev build with watch
# press F5 (Run Extension Development Host) — or:
./scripts/code.sh   # Linux/macOS dev launch
# production build:
yarn gulp           # or: npm run compile
```

The companion **Electron app** in this repo (`npm run dev`, `npm run dist`) is a
lighter-weight build of the same product surface (Monaco + custom UI) that runs
anywhere and previews in a browser via `npm run dev:web`.

## Testing the extension without a full workbench build

```bash
cd vscode/extensions/kineticut-ai
npm install
npm run compile
# then open vscode/ in VS Code and press F5, or run the Extension Development Host
```
