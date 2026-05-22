import { useEffect, useState, useCallback } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useChatStore } from '../../stores/chatStore'
import { useBizStore } from '../../stores/bizStore'
import { useMemoryStore } from '../../stores/memoryStore'
import { useModuleStore } from '../../stores/moduleStore'
import { fetchMemories } from '../../services/api'
import { CognitiveSidebar } from '../sidebar/CognitiveSidebar'
import { RightDrawer } from '../sidebar/RightDrawer'
import { ChatView } from '../chat/ChatView'
import { InputBar } from '../chat/InputBar'
import { OnboardingFlow } from '../onboarding/OnboardingFlow'
import { BusinessFlow } from '../biz/BusinessFlow'
import { KnowledgeBrowser } from '../knowledge/KnowledgeBrowser'
import { ForgeManager } from '../forge/ForgeManager'
import { UserSettings } from '../settings/UserSettings'
import s from './AppShell.module.css'

type OnboardingState = 'checking' | 'needed' | 'done'

const MODULE_TITLES: Record<string, string> = {
  biz: '业务管理',
  'biz-purchase': '采购管理',
  'biz-sale': '销售管理',
  'biz-logistics': '物流管理',
  'biz-finance': '收付款管理',
  memory: '知识浏览',
  forge: '自编码',
  settings: '设置',
}

export function AppShell() {
  const currentSpaceId = useAuthStore((s) => s.currentSpaceId)
  const token = useAuthStore((s) => s.token)
  const connect = useChatStore((s) => s.connect)
  const disconnect = useChatStore((s) => s.disconnect)
  const loadMasterData = useBizStore((s) => s.loadMasterData)
  const enabledModuleIds = useModuleStore((s) => s.enabledModuleIds)
  const loadMemories = useMemoryStore((s) => s.load)
  const [onboarding, setOnboarding] = useState<OnboardingState>('checking')
  const [activeDrawer, setActiveDrawer] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  // Connect WebSocket — reconnect when user (token) changes
  useEffect(() => {
    if (!token) return
    connect()
    return () => disconnect()
  }, [token, connect, disconnect])

  // Load biz master data when any biz module is enabled or space changes
  useEffect(() => {
    const hasBiz = enabledModuleIds.some(id => id === 'biz' || id.startsWith('biz-'))
    if (hasBiz && currentSpaceId) {
      loadMasterData()
    }
  }, [enabledModuleIds, loadMasterData, currentSpaceId])

  // Load memories on space change
  useEffect(() => {
    if (currentSpaceId) {
      loadMemories()
    }
  }, [currentSpaceId, loadMemories])

  // Check if onboarding is needed
  useEffect(() => {
    if (localStorage.getItem('bubble_onboarding_done') === 'true') {
      setOnboarding('done')
      return
    }
    fetchMemories(currentSpaceId || undefined)
      .then((data) => {
        setOnboarding(data.memories?.length > 0 ? 'done' : 'needed')
      })
      .catch(() => {
        setOnboarding('done')
      })
  }, [currentSpaceId])

  const handleOnboardingDone = useCallback(() => {
    setOnboarding('done')
  }, [])

  const handleOpenModule = useCallback((moduleId: string) => {
    if (moduleId === 'settings') {
      setShowSettings(true)
      return
    }
    // Toggle drawer: open if closed or different module, close if same
    setActiveDrawer((prev) => prev === moduleId ? null : moduleId)
  }, [])

  const handleCloseDrawer = useCallback(() => {
    setActiveDrawer(null)
  }, [])

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false)
  }, [])

  if (onboarding === 'checking') {
    return (
      <div className={s.loading}>
        <div style={{
          width: '40px', height: '40px', borderRadius: '50%',
          border: '3px solid rgba(255,255,255,0.08)',
          borderTopColor: '#7C3AED',
          animation: 'spinGlow 0.8s linear infinite',
        }} />
      </div>
    )
  }

  if (onboarding === 'needed') {
    return <OnboardingFlow onComplete={handleOnboardingDone} />
  }

  const renderDrawerContent = () => {
    switch (activeDrawer) {
      case 'biz': return <BusinessFlow />
      case 'biz-purchase': return <BusinessFlow initialTab="purchase" />
      case 'biz-sale': return <BusinessFlow initialTab="sale" />
      case 'biz-logistics': return <BusinessFlow initialTab="logistics" />
      case 'biz-finance': return <BusinessFlow initialTab="payment" />
      case 'memory': return <KnowledgeBrowser />
      case 'forge': return <ForgeManager />
      default: return null
    }
  }

  return (
    <div className={s.shell}>
      <CognitiveSidebar
        onOpenModule={handleOpenModule}
        activeOverlay={activeDrawer}
      />
      <div className={s.mainArea}>
        <ChatView />
        <InputBar />
      </div>
      <RightDrawer
        title={activeDrawer ? (MODULE_TITLES[activeDrawer] || activeDrawer) : ''}
        onClose={handleCloseDrawer}
        open={activeDrawer !== null}
      >
        {renderDrawerContent()}
      </RightDrawer>
      {showSettings && <UserSettings onClose={handleCloseSettings} />}
    </div>
  )
}
