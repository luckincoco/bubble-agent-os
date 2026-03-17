import { useEffect } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { Header } from './Header'
import { NavTabs } from './NavTabs'
import { ChatView } from '../chat/ChatView'
import { InputBar } from '../chat/InputBar'
import { MemoryPanel } from '../memory/MemoryPanel'
import s from './AppShell.module.css'

export function AppShell() {
  const tab = useUIStore((s) => s.activeTab)
  const connect = useChatStore((s) => s.connect)
  const disconnect = useChatStore((s) => s.disconnect)

  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  return (
    <div className={s.shell}>
      <Header />
      <div className={s.main}>
        {tab === 'chat' ? <ChatView /> : <MemoryPanel />}
      </div>
      {tab === 'chat' && <InputBar />}
      <NavTabs />
    </div>
  )
}
