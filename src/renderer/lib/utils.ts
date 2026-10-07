import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… (truncated, ${text.length - max} more characters)`
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function dirname(path: string): string {
  const parts = path.split(/[/\\]/)
  parts.pop()
  return parts.join('/') || '/'
}

export function extOf(path: string): string {
  const match = /\.[^./\\]+$/.exec(path)
  return match ? match[0].toLowerCase() : ''
}

export function joinPath(base: string, rel: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rel)) return rel
  return `${base.replace(/[/\\]+$/, '')}/${rel.replace(/^[/\\]+/, '')}`
}

export function relativePath(root: string, path: string): string {
  if (path.startsWith(root)) {
    const rel = path.slice(root.length).replace(/^[/\\]+/, '')
    return rel || path
  }
  return path
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

let idCounter = 0
export function uniqueId(prefix = 'id'): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}
