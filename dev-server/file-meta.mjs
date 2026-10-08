/**
 * JS port of src/shared/fileMeta.ts (the dev server is plain .mjs).
 * Kept in sync — lightweight, dependency-free file understanding.
 */

const EXT_LANG = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.mdx': 'markdown',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.py': 'python', '.rs': 'rust',
  '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.rb': 'ruby', '.php': 'php', '.html': 'html', '.htm': 'html', '.css': 'css',
  '.scss': 'scss', '.less': 'less', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell', '.bat': 'batch', '.sql': 'sql', '.xml': 'xml', '.svg': 'xml',
  '.vue': 'vue', '.svelte': 'svelte', '.prisma': 'prisma', '.graphql': 'graphql',
  '.proto': 'protobuf', '.ini': 'ini', '.txt': 'plaintext', '.log': 'plaintext',
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.class',
  '.jar', '.pyc', '.pyo', '.o', '.a', '.lock',
])

export function languageForPath(path) {
  const base = path.split(/[/\\]/).pop() || ''
  const lower = base.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === '.env' || lower.startsWith('.env.')) return 'dotenv'
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  if (lower === 'cmakelists.txt') return 'cmake'
  if (lower === 'rakefile' || lower === 'gemfile' || lower === 'vagrantfile') return 'ruby'
  const m = /\.[^./\\]+$/.exec(lower)
  return (m && EXT_LANG[m[0]]) || 'plaintext'
}

export function isTextLike(path) {
  const m = /\.[^./\\]+$/.exec(path.toLowerCase())
  if (!m) return true
  return !BINARY_EXT.has(m[0])
}

const IMPORT_RE =
  /(?:from\s*|require\(\s*|import\s*\(\s*|#include\s*[<"]|use\s+|mod\s+|import\s+)(['"]?)([\w./@-]+)\1/g

const SYMBOL_PATTERNS = [
  /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)?/g,
  /def\s+([a-zA-Z_]\w*)\s*\(/g,
  /pub\s+(?:fn|struct|enum|mod|trait|type)\s+([a-zA-Z_]\w*)/g,
  /func\s+(?:\([^)]*\)\s*)?([A-Z]\w*|main)\s*\(/g,
  /^(?:class|struct|interface|trait)\s+([A-Z]\w*)/gm,
  /^#{1,4}\s+(.+)$/gm,
]

export function extractFileMeta(path, content) {
  const language = languageForPath(path)
  const symbols = []
  const imports = []
  if (!content) return { language, symbols, imports }
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(content)) && imports.length < 40) {
    const spec = m[2]
    if (spec && !imports.includes(spec)) imports.push(spec)
  }
  for (const re of SYMBOL_PATTERNS) {
    re.lastIndex = 0
    while ((m = re.exec(content)) && symbols.length < 40) {
      const name = (m[1] || '').trim()
      if (name && !symbols.includes(name)) symbols.push(name)
    }
  }
  return { language, symbols, imports }
}
