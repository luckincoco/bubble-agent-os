import { useUIStore } from '../../stores/uiStore'
import s from './NavTabs.module.css'

export function NavTabs() {
  const { activeTab, setTab } = useUIStore()

  return (
    <nav className={s.tabs}>
      <button className={s.tab} data-active={activeTab === 'chat'} onClick={() => setTab('chat')}>
        <span className={s.icon}>&#x1F4AC;</span>
        <span>Chat</span>
      </button>
      <button className={s.tab} data-active={activeTab === 'memory'} onClick={() => setTab('memory')}>
        <span className={s.icon}>&#x1F9E0;</span>
        <span>Memory</span>
      </button>
    </nav>
  )
}
