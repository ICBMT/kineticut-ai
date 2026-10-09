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
| 5 | Agent tools: delete and rename files | Missing | — |
| 6 | Agent tools: web search and docs | Missing | — |
| 7 | Modes: Agent and Ask | Done as Agent and Chat, switched from the composer footer. Manual mode missing. | `src/renderer/store/ai.ts`, `components/ChatPanel.tsx` |
| 8 | Composer context: @Codebase, @files, @folders, @symbols, shown as removable chips | Done | `src/renderer/lib/mentions*.ts`, `components/ChatPanel.tsx` (`ComposerChips`) |
| 9 | Composer context: @Past chats, @Docs, @Web, @Git | Missing | — |
| 10 | Rules: `.cursor/rules/*.mdc` with `alwaysApply`, `globs`, `description` | Done. Manual `@rule` invocation missing. | `src/renderer/lib/rules.ts` |
| 11 | Diff review: per-file and per-hunk accept or reject, apply | Done. The composer shows an "N files changed +a −r" bar with per-file accept and reject, Accept all and Reject all; the full review keeps per-hunk control. | `src/renderer/store/review.ts`, `components/ReviewPanel.tsx` (`ChangesBar`) |
| 12 | Per-turn checkpoints and undo | Done | `src/renderer/lib/checkpoints.ts` |
| 13 | Inline edit (Ctrl+K) with in-place diff | Done | `src/renderer/lib/inlineEdit.ts`, `components/InlineEditWidget.tsx` |
| 14 | Multi-line next-edit (Tab) | Done | `src/renderer/lib/nextEdit.ts` |
| 15 | Shortcuts: Ctrl+L chat, Ctrl+I composer, Ctrl+Shift+L attach selection | Done | `src/renderer/commands.ts` |
| 16 | Chat history, resume, background runs | Done | `src/renderer/store/ai.ts`, `components/HistoryModal.tsx` |
| 17 | Model providers: Ollama, OpenAI-compatible, Anthropic, Gemini | Done | `src/renderer/ai/providers.ts` |
| 18 | Live progress: reading, writing, thinking, tool steps | Done. Each tool call is a timeline row with a readable label, live status, line ranges, result size, and expandable output. | `src/renderer/components/ChatActivity.tsx`, `components/AgentTimeline.tsx`, `lib/agentSteps.ts` |
| 19 | Layout: activity bar, explorer, editor tabs, composer on the right, terminal | Done, but the look is not Cursor's. | `src/renderer/components/*` |
| 20 | Visual design and density matching Cursor | Partial: composer is a bordered card, changes bar is Cursor-style. Rest of the app still to match. | `src/renderer/styles.css` |
| 21 | Settings like Cursor: Models, Rules, Indexing, Features pages | Partial: one long settings panel | `src/renderer/components/SettingsPanel.tsx` |
| 22 | VS Code workbench (the real Cursor base) | Not started. Submodule is pinned, not checked out. | `vscode/`, `fork/`, `FORK.md` |

## Plan

**Phase 1: Electron app.** Rebuild the renderer to match Cursor's flows. Start
with the composer and review, since they define how the AI feels: composer modes
and context chips, the agent step timeline, the "N files changed" bar with
accept and reject (done), and the visual system. Then the settings pages, then rows 5,
6, 9 and 10 (manual rules).

**Phase 2: verification.** Run the app in a real headless browser. `@sparticuz/chromium`
(on npm) ships a Chromium binary, and `playwright-core` drives it. Add browser tests
for the composer, the review bar, shortcuts and the empty launch state.

**Phase 3: VS Code fork.** Check out the `vscode/` submodule at its pinned commit,
apply `fork/` with `node fork/apply.mjs`, and bring the extension to the same
behavior as Phase 1 (index, tools, review, composer). A full workbench build needs
several GB of RAM and runs on your machine, not in the sandbox.
