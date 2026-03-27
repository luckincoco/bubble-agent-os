import { useUIStore } from '../../stores/uiStore'
import { useVisibleModules } from '../../stores/moduleStore'
import s from './NavTabs.module.css'

function Icon({ d }: { d: string }) {
  return (
    <svg className={s.svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export function NavTabs() {
  const { activeTab, setTab } = useUIStore()
  const modules = useVisibleModules()

  return (
    <nav className={s.tabs}>
      {modules.map(m => (
        <button key={m.id} className={s.tab} data-active={activeTab === m.tab.key} onClick={() => setTab(m.tab.key)}>
          <Icon d={m.tab.icon} />
          <span className={s.label}>{m.tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
