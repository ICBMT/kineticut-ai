import { useAppStore } from '../store/app'
import { ChatPanel } from './ChatPanel'
import { Explorer } from './Explorer'
import { GitPanel } from './GitPanel'
import { SearchPanel } from './SearchPanel'
import { SettingsPanel } from './SettingsPanel'

export function SideBar() {
  const view = useAppStore((s) => s.sidebarView)
  const width = useAppStore((s) => s.sidebarWidth)

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) =>
      useAppStore.getState().setSidebarWidth(startW + (ev.clientX - startX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-inner">
        {view === 'explorer' && <Explorer />}
        {view === 'search' && <SearchPanel />}
        {view === 'git' && <GitPanel />}
        {view === 'chat' && <ChatPanel />}
        {view === 'settings' && <SettingsPanel />}
      </div>
      <div className="sidebar-resizer" onMouseDown={startDrag} title="Drag to resize" />
    </div>
  )
}
