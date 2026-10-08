import { useSettingsStore } from '../store/settings'
import { useAppStore } from '../store/app'
import { ChatPanel } from './ChatPanel'
import { Explorer } from './Explorer'
import { GitPanel } from './GitPanel'
import { SearchPanel } from './SearchPanel'
import { SettingsPanel } from './SettingsPanel'

/**
 * One sidebar slot (left or right). The project sidebar (explorer / search /
 * git / settings) and the AI chat sidebar are independent: both can be visible
 * at the same time, each on its configured side. If both are configured for
 * the same side, the chat moves to the opposite side so both stay visible.
 */
export function SideBar({ slot }: { slot: 'left' | 'right' }) {
  const projectSide = useSettingsStore((s) => s.sidebarPosition)
  const chatPosition = useSettingsStore((s) => s.chatPosition)
  const sidebarVisible = useAppStore((s) => s.sidebarVisible)
  const chatVisible = useAppStore((s) => s.chatVisible)
  const view = useAppStore((s) => s.sidebarView)
  const projectWidth = useAppStore((s) => s.sidebarWidth)
  const chatWidth = useAppStore((s) => s.chatWidth)

  const chatSide =
    projectSide === chatPosition
      ? chatPosition === 'left'
        ? 'right'
        : 'left'
      : chatPosition

  const isProject = slot === projectSide && sidebarVisible
  const isChat = slot === chatSide && chatVisible
  if (!isProject && !isChat) return null

  const width = isChat ? chatWidth : projectWidth

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      if (isChat) {
        useAppStore.getState().setChatWidth(startW - (slot === 'right' ? -delta : delta))
      } else {
        useAppStore.getState().setSidebarWidth(startW + (slot === 'right' ? -delta : delta))
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="sidebar" data-slot={slot} style={{ width }}>
      <div className="sidebar-inner">
        {isChat ? (
          <ChatPanel />
        ) : view === 'explorer' ? (
          <Explorer />
        ) : view === 'search' ? (
          <SearchPanel />
        ) : view === 'git' ? (
          <GitPanel />
        ) : (
          <SettingsPanel />
        )}
      </div>
      <div className="sidebar-resizer" onMouseDown={startDrag} title="Drag to resize" />
    </div>
  )
}
