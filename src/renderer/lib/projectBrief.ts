/**
 * Project brief: an AI briefing about what the project is and how its code is
 * organized, written from project memory (the directory map, code profile,
 * entry points and file summaries) — not from package scripts.
 *
 * Scanning is ON DEMAND only (button / command) — nothing runs automatically
 * when a folder opens.
 */
import { api } from '../api'
import { streamChat } from '../ai/providers'
import type { ProjectIndexSnapshot } from '../../shared/types'
import { useAppStore } from '../store/app'
import { resolveChatModel, useSettingsStore } from '../store/settings'
import { codeProfileLine, dirLine } from './projectKnowledge'

export interface ProjectContext {
  folder: string
  name: string
  /** One-line "what is this app for" (from the project memory). */
  purpose?: string
  readme?: string
  topLevel: string[]
  treePaths: string[]
  /** Directory digests for the top levels of the tree. */
  dirs: string[]
  /** Languages, frameworks and entry points, derived from the code. */
  profile: string
  /** The most informative file summaries (shallow first). */
  summaries: string[]
  gitBranch?: string | null
  fileCount: number
}

/** Collect the briefing context from project memory. */
export async function gatherProjectContext(folder: string): Promise<ProjectContext> {
  const snap: ProjectIndexSnapshot = await api.projectIndex.get(folder)
  const summaries = (snap.entries || [])
    .filter((e) => e.summary)
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
    .slice(0, 40)
    .map((e) => `${e.rel}: ${e.summary}`)
  return {
    folder: snap.folder,
    name: snap.name,
    purpose: snap.purpose,
    readme: snap.readme,
    topLevel: snap.topLevel,
    treePaths: snap.treePaths,
    dirs: (snap.dirs || []).filter((d) => d.depth <= 2).slice(0, 30).map(dirLine),
    profile: codeProfileLine(snap),
    summaries,
    gitBranch: snap.gitBranch,
    fileCount: snap.fileCount,
  }
}

/** Heuristic brief used when no AI model is available. */
export function buildStaticBrief(ctx: ProjectContext): string {
  const lines: string[] = [`**${ctx.name}**`]
  if (ctx.purpose) lines.push(`- 🎯 Purpose: ${ctx.purpose}`)
  if (ctx.profile) lines.push(`- 🧩 ${ctx.profile}`)
  if (ctx.gitBranch) lines.push(`- 🌿 git branch: \`${ctx.gitBranch}\``)
  lines.push(`- 📁 ${ctx.fileCount} files; top level: ${ctx.topLevel.slice(0, 24).join(', ')}`)
  if (ctx.dirs.length) lines.push('', 'Directories:', ...ctx.dirs.slice(0, 12))
  if (ctx.readme) lines.push('', ctx.readme.slice(0, 600))
  return lines.join('\n')
}

function briefPrompt(ctx: ProjectContext): string {
  return `You are analyzing a project to brief a developer who just opened it in their AI-native editor.
Work only from the context below, which was read from the project's code.

Produce a concise project briefing (5-10 bullet points, markdown):
- What the project is and what it is for
- Languages, frameworks and the main building blocks, from the code profile
- How the code is organized: the important directories and what each one contains
- Entry points and the main flow through the code (from the entry points and file summaries)
- Notable conventions a developer should know first

Do NOT invent facts that are not supported by the context. Be concrete and brief.

<context>
Project folder: ${ctx.folder}
Name: ${ctx.name}
${ctx.purpose ? `Purpose: ${ctx.purpose}` : ''}
${ctx.profile ? `Code profile: ${ctx.profile}` : ''}
${ctx.readme ? `README (excerpt):\n${ctx.readme.slice(0, 1500)}` : ''}
Directory map:
${ctx.dirs.join('\n') || '(none)'}
File summaries (shallow first):
${ctx.summaries.join('\n') || '(not understood yet — the file tree below is all there is)'}
Top-level entries: ${ctx.topLevel.join(', ')}
File tree (${ctx.treePaths.length} files, shallowest first):
${ctx.treePaths.slice(0, 120).join('\n')}
git branch: ${ctx.gitBranch || 'unknown'}
</context>`
}

/** Generate the brief with the configured model (falls back to the static brief). */
export async function generateProjectBrief(ctx: ProjectContext): Promise<string> {
  const settings = useSettingsStore.getState()
  const { provider, model } = resolveChatModel(settings)
  if (!provider || !model) return buildStaticBrief(ctx)
  let out = ''
  try {
    for await (const evt of streamChat({
      provider,
      model,
      messages: [
        { role: 'system', content: 'You are a precise technical analyst. Answer with concise markdown only.' },
        { role: 'user', content: briefPrompt(ctx) },
      ],
    })) {
      if (evt.type === 'text') out += evt.text
      else if (evt.type === 'error') throw new Error(evt.error)
    }
  } catch {
    return buildStaticBrief(ctx)
  }
  return out.trim() || buildStaticBrief(ctx)
}

/** On-demand refresh of the brief for the currently open folder. */
export async function refreshProjectBrief(): Promise<void> {
  const app = useAppStore.getState()
  const folder = app.folder
  if (!folder) {
    app.toast({ kind: 'info', title: 'Open a folder first', message: 'The AI briefs on the project you have open.', duration: 2500 })
    return
  }
  if (app.briefLoading) return
  useAppStore.getState().setBriefLoading(true)
  try {
    const ctx = await gatherProjectContext(folder)
    const text = await generateProjectBrief(ctx)
    useAppStore.getState().setProjectBrief({ text, at: Date.now(), folder })
  } catch {
    /* keep any previous brief */
  } finally {
    useAppStore.getState().setBriefLoading(false)
  }
}

/** The brief text to inject into AI prompts, if it matches the open folder. */
export function currentBriefText(): string | null {
  const app = useAppStore.getState()
  const brief = app.projectBrief
  if (!brief || !app.folder || brief.folder !== app.folder) return null
  return brief.text
}
