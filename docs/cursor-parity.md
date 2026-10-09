# Cursor parity plan

Goal: the whole app and its AI workflow work the way Cursor does, and the AI is
connected to the workspace the same way. This file is the checklist. Status is
what the repo does **today**, with the file that does it.

Cursor's server-side pieces (its own embedding model, its vector database, its
Merkle sync service) are not public. Where they are involved, the target is the
same behavior with open parts (Ollama embeddings, local index), not a copy of
their infrastructure.

Last commit before the rewrite: `1811136`. That commit stays in git history as
the fallback.

## Status

| # | Cursor behavior | Status | Where |
| --- | --- | --- | --- |
| 1 | Codebase index: chunks, embeddings, incremental sync | Partial: local, content-hash sync, auto embeddings. Chunks are heuristic, not tree-sitter. | `src/shared/codebaseIndex.mjs` |
| 2 | Ignore files (`.gitignore`, `.cursorignore`) | Done for indexing and search. `.cursorignore` does not block explicit `read_file`. | `src/shared/ignoreRules.mjs` |
| 3 | Agent tools: codebase search, grep, file search, read with line ranges, list dir | Done | `src/renderer/ai/agent.ts` |
| 4 | Agent tools: create, edit, write, run command with approval | Done | `src/renderer/ai/agent.ts` |
| 5 | Agent tools: delete and rename files | Done. Both ask for confirmation, refuse binary files and files with staged review changes, and are undoable from the chat (a rename is a delete plus a create). | `src/renderer/ai/agent.ts` (`delete_file`, `rename_file`, `removable`), `lib/checkpoints.ts` |
| 6 | Agent tools: web search and docs | Done with the user's own search key: `web_search` (Brave Search API, key in Settings → Models & agent) and `fetch_url` (reads a page as text; asks first; http and https only; size and time limits). Without a key, web_search says so. | `src/shared/webFetch.mjs`, `src/main/ipc.ts`, `dev-server/index.mjs`, `src/renderer/ai/agent.ts`, `components/SettingsPanel.tsx` |
| 7 | Modes: Agent, Ask and Manual | Done: Chat (Ask), Agent, and Manual. Manual sends only what the user attaches (mentions, selection) and no retrieval, brief or tools. Switched from the composer footer. | `src/renderer/store/ai.ts`, `lib/cursorContext.ts`, `components/ChatPanel.tsx` |
| 8 | Composer context: @Codebase, @files, @folders, @symbols, shown as removable chips | Done | `src/renderer/lib/mentions*.ts`, `components/ChatPanel.tsx` (`ComposerChips`) |
| 9 | Composer context: @Past chats, @Docs, @Web, @Git | Partial: `@chat:<title>` (past chat transcript) and `@git` (branch, changed files, diffs) done. @Docs and @Web are reachable through the agent's web tools (row 6); no @-mention for a URL yet. | `src/renderer/lib/mentionContext.ts`, `lib/mentions.ts` |
| 10 | Rules: `.cursor/rules/*.mdc` with `alwaysApply`, `globs`, `description` | Done, including manual `@rule:<name>`, which adds the full rule to the request. | `src/renderer/lib/rules.ts`, `lib/mentionContext.ts` |
| 11 | Diff review: per-file and per-hunk accept or reject, apply | Done. The composer shows an "N files changed +a −r" bar with per-file accept and reject, Accept all and Reject all; the full review keeps per-hunk control. | `src/renderer/store/review.ts`, `components/ReviewPanel.tsx` (`ChangesBar`) |
| 12 | Per-turn checkpoints and undo | Done | `src/renderer/lib/checkpoints.ts` |
| 13 | Inline edit (Ctrl+K) with in-place diff | Done | `src/renderer/lib/inlineEdit.ts`, `components/InlineEditWidget.tsx` |
| 14 | Multi-line next-edit (Tab) | Done | `src/renderer/lib/nextEdit.ts` |
| 15 | Shortcuts: Ctrl+L chat, Ctrl+I composer, Ctrl+Shift+L attach selection | Done | `src/renderer/commands.ts` |
| 16 | Chat history, resume, background runs | Done | `src/renderer/store/ai.ts`, `components/HistoryModal.tsx` |
| 17 | Model providers: Ollama, OpenAI-compatible, Anthropic, Gemini | Done | `src/renderer/ai/providers.ts` |
| 18 | Live progress: reading, writing, thinking, tool steps | Done. Each tool call is a timeline row with a readable label, live status, line ranges, result size, and expandable output. | `src/renderer/components/ChatActivity.tsx`, `components/AgentTimeline.tsx`, `lib/agentSteps.ts` |
| 19 | Layout: activity bar, explorer, editor tabs, composer on the right, terminal | Done. Checked in a headless browser: path breadcrumbs above the tabs, status bar with index state, composer on the right. Remaining differences are visual taste. | `src/renderer/components/*` |
| 20 | Visual design and density matching Cursor | Partial: neutral dark base, one radius and elevation scale, a keyboard focus ring, composer card, changes bar, step timeline. Settings and the editor chrome still to match. | `src/renderer/styles.css` |
| 21 | Settings like Cursor: Models, Rules, Indexing, Features pages | Done: six pages (Models & agent, Rules & index, Appearance, Editor, Layout, Shortcuts) with a nav row. | `src/renderer/components/SettingsPanel.tsx` |
| 22 | VS Code workbench (the real Cursor base) | Not started. Submodule is pinned, not checked out. | `vscode/`, `fork/`, `FORK.md` |

## Plan

**Phase 1: Electron app.** Rebuild the renderer to match Cursor's flows. Start
with the composer and review, since they define how the AI feels: composer modes
and context chips, the agent step timeline, the "N files changed" bar with
accept and reject (done), and the visual system. Then the settings pages, then rows 5,
6, 9 and 10 (manual rules).

**Phase 2: verification (done).** `scripts/smoke-browser.mjs` (`npm run smoke:browser`, needs `KC_CHROME`) runs the app in a real headless Chromium: empty launch, changes bar, composer chips, keyboard focus and settings pages. Earlier plan text: run the app in a real headless browser. `@sparticuz/chromium`
(on npm) ships a Chromium binary, and `playwright-core` drives it. Add browser tests
for the composer, the review bar, shortcuts and the empty launch state.

**Phase 3: VS Code fork.** Check out the `vscode/` submodule at its pinned commit,
apply `fork/` with `node fork/apply.mjs`, and bring the extension to the same
behavior as Phase 1 (index, tools, review, composer). A full workbench build needs
several GB of RAM and runs on your machine, not in the sandbox.
