import { useEffect, useMemo, useState } from 'react'
import { FileCode, Search, SearchX } from 'lucide-react'
import { api } from '../api'
import type { SearchResult } from '../../shared/types'
import { relativePath, sleep } from '../lib/utils'
import { useAppStore } from '../store/app'
import { useEditorStore } from '../store/editor'
import { EmptyState } from './ui'

export function SearchPanel() {
  const folder = useAppStore((s) => s.folder)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    if (!folder) return
    const q = query.trim()
    if (!q) {
      setResults([])
      setSearched(false)
      return
    }
    setSearching(true)
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.search.query(folder, q, 500)
          setResults(res)
        } catch {
          setResults([])
        } finally {
          setSearching(false)
          setSearched(true)
        }
      })()
    }, 350)
    return () => clearTimeout(handle)
  }, [query, folder])

  const totalHits = useMemo(() => results.reduce((n, r) => n + r.hits.length, 0), [results])

  const openHit = (file: string, line: number, column: number) => {
    useEditorStore.getState().openTab(file)
    useEditorStore.getState().setPendingReveal({ path: file, line, column })
  }

  if (!folder) {
    return (
      <div className="sidebar-inner">
        <div className="panel-header">
          <span>Search</span>
        </div>
        <EmptyState icon={Search} title="No folder opened" text="Open a workspace to search across files." />
      </div>
    )
  }

  return (
    <div className="sidebar-inner">
      <div className="panel-header">
        <span>Search</span>
        {searched && (
          <span className="normal-case tracking-normal font-normal">
            {searching ? 'searching…' : `${totalHits} results`}
          </span>
        )}
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <input
            className="field-input !pl-8 !py-1.5 !text-xs"
            placeholder="Search in files…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="sidebar-scroll">
        {!query.trim() ? (
          <div className="px-3 py-2 text-xs text-[var(--text-faint)]">
            Type to search across all files in the workspace.
          </div>
        ) : searching && results.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--text-faint)]">Searching…</div>
        ) : results.length === 0 && searched ? (
          <EmptyState icon={SearchX} title="No results" text={`Nothing found for “${query.trim()}”.`} />
        ) : (
          results.map((r) => (
            <div key={r.file} className="mb-1">
              <div
                className="tree-row"
                style={{ paddingLeft: 8 }}
                title={r.file}
                onClick={() => openHit(r.file, r.hits[0].line, r.hits[0].column)}
              >
                <FileCode size={13} className="shrink-0 text-[var(--text-faint)]" />
                <span className="fname text-[var(--text-dim)]">
                  {relativePath(folder, r.file)}
                </span>
                <span className="ml-auto text-[10px] text-[var(--text-faint)] pr-1">
                  {r.hits.length}
                </span>
              </div>
              {r.hits.slice(0, 12).map((h, i) => (
                <div
                  key={i}
                  className="tree-row cursor-pointer"
                  style={{ paddingLeft: 30 }}
                  onClick={() => openHit(h.path, h.line, h.column)}
                >
                  <span className="text-[10px] text-[var(--text-faint)] w-8 shrink-0 text-right pr-2">
                    {h.line}
                  </span>
                  <span className="fname text-xs">{h.text.trim().slice(0, 110)}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
