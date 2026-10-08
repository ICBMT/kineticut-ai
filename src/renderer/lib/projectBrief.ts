/**
 * Project understanding: gather workspace context and produce an AI brief
 * about what the project is, what it does, and how to work with it.
 * The brief is shown in the chat panel and injected into the agent/chat
 * system prompts so the AI always knows the open project.
 */
import { api } from '../api'
import { streamChat } from '../ai/providers'
import type { ProviderConfig } from '../ai/types'
import { useAppStore } from '../store/app'
import { resolveChatModel, useSettingsStore } from '../store/settings'

export interface ProjectContext {
  folder: string
  name: string
  packageJson?: any
  readme?: string
  topLevel: string[]
  treePaths: string[]
  keyFiles: Record<string, string>
  gitBranch?: string | null
  fileCount: number
}

/** Collect a bounded snapshot of the workspace for the AI to reason about. */
export async function gatherProjectContext(folder: string): Promise<ProjectContext> {
  const top = await api.fs.list(folder).catch(() => [])
  const topLevel = top.map((e) => e.name)

  let packageJson: any = undefined
  try {
    const pj = top.find((e) => e.name === 'package.json' && e.type === 'file')
    if (pj) {
      const res = await api.fs.read(pj.path)
      if (!res.binary) packageJson = JSON.parse(res.content)
    }
  } catch {
    /* ignore */
  }

  let readme: string | undefined
  const readmeEntry = top.find((e) => /^readme/i.test(e.name) && e.type === 'file')
  if (readmeEntry) {
    try {
      const res = await api.fs.read(readmeEntry.path)
      if (!res.binary) readme = res.content.slice(0, 3000)
    } catch {
      /* ignore */
    }
  }

  let treePaths: string[] = []
  let fileCount = 0
  try {
    const tree = await api.fs.tree(folder, 4)
    const walk = (node: any, depth: number) => {
      if (depth > 3) return
      for (const child of node.children || []) {
        fileCount++
        if (child.type === 'file') {
          treePaths.push(child.path.slice(folder.length).replace(/^[/\\]+/, ''))
        } else {
          walk(child, depth + 1)
        }
      }
    }
    walk(tree, 0)
  } catch {
    /* ignore */
  }
  treePaths = treePaths.slice(0, 400)

  const keyFiles: Record<string, string> = {}
  for (const name of [
    'package.json',
    'tsconfig.json',
    'Dockerfile',
    'docker-compose.yml',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'Makefile',
  ]) {
    const entry = top.find((e) => e.name === name && e.type === 'file')
    if (!entry) continue
    try {
      const res = await api.fs.read(entry.path)
      if (!res.binary && res.content.length < 20000) {
        keyFiles[name] = res.content.slice(0, 4000)
      }
    } catch {
      /* ignore */
    }
  }

  let gitBranch: string | null = null
  try {
    gitBranch = (await api.git.status(folder)).branch
  } catch {
    /* ignore */
  }

  return {
    folder,
    name: packageJson?.name || folder.split(/[/\\]/).pop() || folder,
    packageJson,
    readme,
    topLevel,
    treePaths,
    keyFiles,
    gitBranch,
    fileCount,
  }
}

/** Heuristic brief used when no AI model is available. */
export function buildStaticBrief(ctx: ProjectContext): string {
  const lines: string[] = [`**${ctx.name}**`]
  if (ctx.packageJson) {
    lines.push(`- 📦 Node project: \`${ctx.packageJson.name}\` ${ctx.packageJson.version || ''}`)
    if (ctx.packageJson.description) lines.push(`- ${ctx.packageJson.description}`)
    const scripts = Object.keys(ctx.packageJson.scripts || {})
    if (scripts.length) lines.push(`- Scripts: ${scripts.map((s) => `\`${s}\``).join(', ')}`)
    const deps = Object.keys(ctx.packageJson.dependencies || {}).length
    const devDeps = Object.keys(ctx.packageJson.devDependencies || {}).length
    lines.push(`- Dependencies: ${deps} + ${devDeps} dev`)
  } else if (ctx.keyFiles['pyproject.toml']) {
    lines.push('- 🐍 Python project (pyproject.toml)')
  } else if (ctx.keyFiles['Cargo.toml']) {
    lines.push('- 🦀 Rust project (Cargo.toml)')
  } else if (ctx.keyFiles['go.mod']) {
    lines.push('- 🐹 Go project (go.mod)')
  }
  if (ctx.gitBranch) lines.push(`- 🌿 git branch: \`${ctx.gitBranch}\``)
  lines.push(`- 📁 ${ctx.fileCount} files; top level: ${ctx.topLevel.slice(0, 24).join(', ')}`)
  if (ctx.readme) lines.push('', ctx.readme.slice(0, 600))
  return lines.join('\n')
}

function briefPrompt(ctx: ProjectContext): string {
  return `You are analyzing a project workspace to brief a developer who just opened it in their AI-native editor.

Produce a concise project briefing (5-10 bullet points, markdown):
- What the project is and what it does (infer from the manifest, README and structure)
- Tech stack and key dependencies
- Project structure highlights (important directories and files)
- Entry points / how to run, build and test (from scripts and manifests)
- Notable conventions or things a developer should know first

Do NOT invent facts that are not supported by the context. Be concrete and brief.

<context>
Project folder: ${ctx.folder}
Name: ${ctx.name}
${ctx.packageJson ? `package.json:\n${JSON.stringify(ctx.packageJson, null, 2).slice(0, 4000)}` : ''}
${ctx.readme ? `README (excerpt):\n${ctx.readme}` : ''}
${
  Object.keys(ctx.keyFiles).length
    ? `Key files:\n${Object.entries(ctx.keyFiles)
        .map(([k, v]) => `--- ${k} ---\n${k === 'package.json' ? v.slice(0, 2000) : v}`)
        .join('\n')}`
    : ''
}
Top-level entries: ${ctx.topLevel.join(', ')}
File tree (${ctx.treePaths.length} files, excerpt):
${ctx.treePaths.slice(0, 250).join('\n')}
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
        {
          role: 'system',
          content: 'You are a precise technical analyst. Answer with concise markdown only.',
        },
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

/** Background refresh of the brief for the currently open folder. */
export async function refreshProjectBrief(): Promise<void> {
  const app = useAppStore.getState()
  const folder = app.folder
  if (!folder || app.briefLoading) return
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

export type { ProviderConfig }
