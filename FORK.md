# Forking VS Code for Kineticut AI

Kineticut AI is built **by forking VS Code**. This repository contains:

- **`vscode/`** — a git submodule pinned to upstream
  [`microsoft/vscode`](https://github.com/microsoft/vscode) (the full VS Code
  workbench source, referenced as a gitlink — not vendored, so the repo stays small).
- **`fork/`** — our fork delta:
  - `fork/extensions/kineticut-ai/` — the **Kineticut AI VS Code extension**
    (zero runtime dependencies): `@kineticut` chat participant with an agent tool
    loop, AI inline completions, "✦ Fix with AI" code actions, context-menu
    commands, `kineticut.*` settings, status-bar model indicator.
  - `fork/apply.mjs` — applies the overlay to a VS Code checkout.
  - `fork/README.md` — full documentation.

## Create your fork (one click) and apply

```bash
# 1. Fork https://github.com/microsoft/vscode on GitHub (creates <you>/vscode)

# 2. Point this repo's submodule at YOUR fork
cd vscode
git remote set-url origin https://github.com/<you>/vscode.git
# (or clone your fork fresh into vscode/)

# 3. Apply the Kineticut AI overlay (from this repo's root)
cd ..
node fork/apply.mjs
#   → copies fork/extensions/kineticut-ai → vscode/extensions/kineticut-ai
#   → patches vscode/product.json branding:
#       nameShort "Kineticut AI Code", applicationName "kineticut-ai-code", …

# 4. Commit & push to your fork
cd vscode
git add extensions/kineticut-ai product.json
git commit -m "Add Kineticut AI extension + branding"
git push origin HEAD
```

## Build the fork (full VS Code workbench)

```bash
cd vscode
yarn                # install dependencies (heavy: ~8 GB RAM recommended)
yarn watch          # dev build — then press F5 to launch the Extension Development Host
# or production compile:
yarn gulp
```

A full workbench build is a **stretch goal** of this project. The primary,
fast-moving build is the **Electron app** in this repo (`npm run dev`,
`npm run dist`, browser preview via `npm run dev:web`), which delivers the same
product surface — Monaco editor, AI chat/agent, inline completions, terminal,
explorer, git — without a multi-GB VS Code workbench compile.

See [`fork/README.md`](fork/README.md) for extension details and configuration.
