import { useEffect } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { useBizStore } from '../../stores/bizStore'
import { Header } from './Header'
import { NavTabs } from './NavTabs'
import { ChatView } from '../chat/ChatView'
import { InputBar } from '../chat/InputBar'
import { MemoryPanel } from '../memory/MemoryPanel'
import { DashboardView } from '../biz/DashboardView'
import { EntryView } from '../biz/EntryView'
import { QueryView } from '../biz/QueryView'
import s from './AppShell.module.css'

export function AppShell() {
  const tab = useUIStore((s) => s.activeTab)
  const connect = useChatStore((s) => s.connect)
  const disconnect = useChatStore((s) => s.disconnect)
  const loadMasterData = useBizStore((s) => s.loadMasterData)

  useEffect(() => {
    connect()
    loadMasterData()
    return () => disconnect()
  }, [connect, disconnect, loadMasterData])

  const renderContent = () => {
    switch (tab) {
      case 'home': return <DashboardView />
      case 'entry': return <EntryView />
      case 'query': return <QueryView />
      case 'chat': return <ChatView />
      case 'memory': return <MemoryPanel />
    }
  }

  return (
    <div className={s.shell}>
      <Header />
      <div className={s.main}>
        {renderContent()}
      </div>
      {tab === 'chat' && <InputBar />}
      <NavTabs />
    </div>
  )
}
