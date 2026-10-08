#!/usr/bin/env node
/**
 * Apply the Kineticut AI overlay to the VS Code fork.
 *
 * Prerequisites:
 *   1. Fork https://github.com/microsoft/vscode on GitHub (one click).
 *   2. Clone your fork and check out the branch you want to build.
 *   3. From the kineticut-ai repo root (which contains the `vscode/` submodule):
 *
 *        node fork/apply.mjs [path-to-vscode-fork]
 *
 *      (defaults to `./vscode`)
 *
 * What it does:
 *   - copies `fork/extensions/kineticut-ai` into `<vscode>/extensions/kineticut-ai`
 *   - patches `<vscode>/product.json` branding (nameShort/nameLong/applicationName)
 *   - prints the exact git commands to commit & push to your fork
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const vscodePath = resolve(process.argv[2] || join(repoRoot, 'vscode'))

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(s, d)
    else await fs.copyFile(s, d)
  }
}

async function main() {
  console.log(`Kineticut AI — VS Code fork overlay`)
  console.log(`  vscode checkout: ${vscodePath}`)

  if (!(await pathExists(join(vscodePath, 'product.json')))) {
    console.error(`\n✗ ${vscodePath} does not look like a VS Code checkout (product.json missing).`)
    console.error(`  Clone your fork of microsoft/vscode there, or pass its path: node fork/apply.mjs /path/to/vscode`)
    process.exit(1)
  }

  // 1. Copy the extension.
  const extSrc = join(here, 'extensions', 'kineticut-ai')
  const extDest = join(vscodePath, 'extensions', 'kineticut-ai')
  console.log(`\n→ Copying extension → ${join('extensions', 'kineticut-ai')}`)
  await fs.rm(extDest, { recursive: true, force: true })
  await copyDir(extSrc, extDest)

  // 2. Patch product.json branding.
  const productPath = join(vscodePath, 'product.json')
  const product = JSON.parse(await fs.readFile(productPath, 'utf8'))
  product.nameShort = 'Kineticut AI Code'
  product.nameLong = 'Kineticut AI Code — AI-native editor'
  product.applicationName = 'kineticut-ai-code'
  product.quality = product.quality || 'stable'
  product.dataFolderName = product.dataFolderName || '.kineticut-ai-code'
  product.urlProtocol = product.urlProtocol || 'kineticut-ai-code'
  product.reportIssueUrl =
    product.reportIssueUrl || 'https://github.com/ICBMT/kineticut-ai/issues/new'
  product.extensionsGallery = product.extensionsGallery || {
    serviceUrl: 'https://open-vsx.org/vscode/gallery',
    itemUrl: 'https://open-vsx.org/vscode/item',
    cacheUrl: 'https://vscode.blob.core.windows.net/gallery/index',
  }
  await fs.writeFile(productPath, JSON.stringify(product, null, 2) + '\n')
  console.log(`→ Patched product.json (nameShort: "${product.nameShort}")`)

  // 3. Show git instructions.
  const rel = (p) => p.replace(/\\/g, '/')
  console.log(`
✔ Overlay applied.

Next steps (inside ${rel(vscodePath)}):

  git add extensions/kineticut-ai product.json
  git commit -m "Add Kineticut AI extension + branding"
  git push origin HEAD            # push to YOUR fork

Build the fork (full VS Code workbench — needs ~8GB RAM and a while):

  yarn                # installs dependencies (uses the yarn.lock in the fork)
  yarn watch          # or: npm run compile / gulp watch
  # then launch with the "Run VS Code" debug config (F5), or:
  ./scripts/code.sh   # Linux/macOS dev launch

The Electron app in this repo (npm run dev) is the fast, previewable build of
the same product — the fork is the full VS Code workbench with our extension.
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
