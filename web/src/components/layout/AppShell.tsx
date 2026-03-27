import { useEffect, useState, useCallback } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { useChatStore } from '../../stores/chatStore'
import { useBizStore } from '../../stores/bizStore'
import { useModuleStore, useVisibleModules } from '../../stores/moduleStore'
import { getModuleById } from '../../modules/registry'
import { fetchMemories } from '../../services/api'
import { Header } from './Header'
import { NavTabs } from './NavTabs'
import { InputBar } from '../chat/InputBar'
import { OnboardingFlow } from '../onboarding/OnboardingFlow'
import s from './AppShell.module.css'

type OnboardingState = 'checking' | 'needed' | 'done'

export function AppShell() {
  const tab = useUIStore((s) => s.activeTab)
  const setTab = useUIStore((s) => s.setTab)
  const currentSpaceId = useAuthStore((s) => s.currentSpaceId)
  const connect = useChatStore((s) => s.connect)
  const disconnect = useChatStore((s) => s.disconnect)
  const loadMasterData = useBizStore((s) => s.loadMasterData)
  const enabledModuleIds = useModuleStore((s) => s.enabledModuleIds)
  const visibleModules = useVisibleModules()
  const [onboarding, setOnboarding] = useState<OnboardingState>('checking')

  // Connect WebSocket
  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  // Load biz master data when biz module is enabled
  useEffect(() => {
    if (enabledModuleIds.includes('biz')) {
      loadMasterData()
    }
  }, [enabledModuleIds, loadMasterData])

  // Check if onboarding is needed
  useEffect(() => {
    if (localStorage.getItem('bubble_onboarding_done') === 'true') {
      setOnboarding('done')
      return
    }
    // Fetch memories to check if user is new
    fetchMemories(currentSpaceId || undefined)
      .then((data) => {
        setOnboarding(data.memories?.length > 0 ? 'done' : 'needed')
      })
      .catch(() => {
        // On error, skip onboarding to avoid blocking
        setOnboarding('done')
      })
  }, [currentSpaceId])

  const handleOnboardingDone = useCallback(() => {
    setOnboarding('done')
  }, [])

  // If active tab is not in visible modules, redirect to first available
  useEffect(() => {
    const isVisible = visibleModules.some(m => m.tab.key === tab)
    if (!isVisible && visibleModules.length > 0) {
      setTab(visibleModules[0].tab.key)
    }
  }, [tab, visibleModules, setTab])

  if (onboarding === 'checking') {
    return (
      <div className={s.shell} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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

  // Find the active module's component
  const activeModule = visibleModules.find(m => m.tab.key === tab)
  const ActiveComponent = activeModule?.component

  return (
    <div className={s.shell}>
      <Header />
      <div className={s.main}>
        {ActiveComponent ? <ActiveComponent /> : null}
      </div>
      {tab === 'chat' && <InputBar />}
      <NavTabs />
    </div>
  )
}
