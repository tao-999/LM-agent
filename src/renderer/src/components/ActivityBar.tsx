import {
  Files,
  Search,
  Settings
} from 'lucide-react'
import type { AppSection } from '../../../shared/types'
import { useAppStore } from '../store'

const items: Array<{ id: AppSection; label: string; icon: typeof Files }> = [
  { id: 'explorer', label: '项目', icon: Files },
  { id: 'search', label: '搜索', icon: Search }
]

export function ActivityBar(): React.JSX.Element {
  const activeSection = useAppStore((state) => state.activeSection)
  const setSection = useAppStore((state) => state.setSection)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)

  return (
    <aside className="activity-bar">
      <div className="activity-logo" title="星伴 AI">
        <span>SA</span>
      </div>
      <div className="activity-main">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              className={`activity-button ${activeSection === item.id ? 'active' : ''}`}
              onClick={() => setSection(item.id)}
              title={item.label}
            >
              <Icon size={21} strokeWidth={1.8} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </div>
      <button
        className={`activity-button ${settingsOpen ? 'active' : ''}`}
        onClick={() => setSettingsOpen(true)}
        title="设置"
      >
        <Settings size={21} strokeWidth={1.8} />
        <span>设置</span>
      </button>
    </aside>
  )
}
