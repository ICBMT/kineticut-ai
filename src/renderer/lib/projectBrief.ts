/**
 * Project understanding: gather workspace context and produce an AI brief
 * about what the project is, what it does, and how to work with it.
 *
 * Scanning is ON DEMAND only (button / command) — nothing runs automatically
 * when a folder opens. Context comes from the main-process project index
 * (persistent, incremental, disk-cached), so scanning is fast and light.
 */
import { api } from '../api'
import { streamChat } from '../ai/providers'
import { useAppStore } from '../store/app'
import { resolveChatModel, useSettingsStore } from '../store/settings'
import { derivePurpose } from '../../shared/purpose'

export interface ProjectContext {
  folder: string
  name: string
  /** One-line "what is this app for" (from the optimized project index). */
  purpose?: string
  packageJson?: any
  readme?: string
  topLevel: string[]
  treePaths: string[]
  keyFiles: Record<string, string>
  gitBranch?: string | null
  fileCount: number
}

/** Collect workspace context — fast path via the project index. */
export async function gatherProjectContext(folder: string): Promise<ProjectContext> {
  try {
    const snap = await api.projectIndex.get(folder)
    return {
      folder: snap.folder,
      name: snap.name,
      purpose: snap.purpose,
      packageJson: snap.packageJson,
      readme: snap.readme,
      topLevel: snap.topLevel,
      treePaths: snap.treePaths,
      keyFiles: snap.keyFiles,
      gitBranch: snap.gitBranch,
      fileCount: snap.fileCount,
    }
  } catch {
    return gatherProjectContextFromFs(folder)
  }
}

/** Fallback: gather straight from the fs API (parallel reads, small caps). */
async function gatherProjectContextFromFs(folder: string): Promise<ProjectContext> {
  const top = await api.fs.list(folder).catch(() => [])
  const topLevel = top.map((e) => e.name)

  const keyNames = [
    'package.json',
    'tsconfig.json',
    'Dockerfile',
    'docker-compose.yml',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'Makefile',
  ]
  const keyEntries = top.filter(
    (e) => e.type === 'file' && (keyNames.includes(e.name) || /^readme/i.test(e.name)),
  )
  const excerpts = await Promise.all(
    keyEntries.map(async (e) => {
      try {
        const res = await api.fs.read(e.path)
        if (!res.binary && res.content.length < 20000) {
          return [e.name, res.content.slice(0, 4000)] as const
        }
      } catch {
        /* ignore */
      }
      return null
    }),
  )
  const keyFiles: Record<string, string> = {}
  for (const item of excerpts) if (item) keyFiles[item[0]] = item[1]

  let packageJson: any
  if (keyFiles['package.json']) {
    try {
      packageJson = JSON.parse(keyFiles['package.json'])
    } catch {
      /* ignore */
    }
  }
  const readmeName = Object.keys(keyFiles).find((k) => /^readme/i.test(k))

  let treePaths: string[] = []
  let fileCount = 0
  try {
    const tree = await api.fs.tree(folder, 3)
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
  treePaths = treePaths.slice(0, 150)

  let gitBranch: string | null = null
  try {
    gitBranch = (await api.git.status(folder)).branch
  } catch {
    /* ignore */
  }

  return {
    folder,
    name: packageJson?.name || folder.split(/[/\\]/).pop() || folder,
    purpose: derivePurpose(packageJson, readmeName ? keyFiles[readmeName] : undefined),
    packageJson,
    readme: readmeName ? keyFiles[readmeName]?.slice(0, 2000) : undefined,
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
  if (ctx.purpose) lines.push(`- 🎯 Purpose: ${ctx.purpose}`)
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
${ctx.purpose ? `Purpose (from package.json/README): ${ctx.purpose}` : ''}
${ctx.packageJson ? `package.json:\n${JSON.stringify(ctx.packageJson, null, 2).slice(0, 3000)}` : ''}
${ctx.readme ? `README (excerpt):\n${ctx.readme.slice(0, 1500)}` : ''}
${
  Object.keys(ctx.keyFiles).length
    ? `Key files:\n${Object.entries(ctx.keyFiles)
        .map(([k, v]) => `--- ${k} ---\n${k === 'package.json' ? v.slice(0, 1500) : v}`)
        .join('\n')}`
    : ''
}
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

/** On-demand refresh of the brief for the currently open folder. */
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
