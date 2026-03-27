import { useUIStore } from '../../stores/uiStore'
import type { Tab } from '../../stores/uiStore'
import s from './NavTabs.module.css'

function Icon({ d }: { d: string }) {
  return (
    <svg className={s.svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

const tabs: Array<{ key: Tab; path: string; label: string }> = [
  { key: 'home',   path: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', label: '首页' },
  { key: 'entry',  path: 'M12 5v14M5 12h14', label: '录入' },
  { key: 'query',  path: 'M3 3v18h18M7 16l4-8 4 4 5-9', label: '查询' },
  { key: 'chat',   path: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z', label: 'AI' },
  { key: 'memory', path: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 8a4 4 0 100 8 4 4 0 000-8z', label: '记忆' },
]

export function NavTabs() {
  const { activeTab, setTab } = useUIStore()

  return (
    <nav className={s.tabs}>
      {tabs.map(t => (
        <button key={t.key} className={s.tab} data-active={activeTab === t.key} onClick={() => setTab(t.key)}>
          <Icon d={t.path} />
          <span className={s.label}>{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
