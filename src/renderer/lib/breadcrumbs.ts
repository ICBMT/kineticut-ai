/** Path segments shown above the editor: relative to the workspace when possible. */
export interface Crumb {
  label: string
  /** Absolute path of this crumb (folder or file). */
  path: string
  isFile: boolean
}

export function breadcrumbs(path: string, folder: string | null): Crumb[] {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const full = norm(path)
  const root = folder ? norm(folder).replace(/\/+$/, '') : ''
  const rel = root && full.startsWith(root + '/') ? full.slice(root.length + 1) : full.replace(/^\/+/, '')
  const parts = rel.split('/').filter(Boolean)
  const crumbs: Crumb[] = []
  let acc = root && full.startsWith(root + '/') ? root : ''
  parts.forEach((label, i) => {
    acc = acc ? `${acc}/${label}` : `/${label}`
    crumbs.push({ label, path: acc, isFile: i === parts.length - 1 })
  })
  return crumbs
}
