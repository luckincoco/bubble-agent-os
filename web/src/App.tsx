import { useEffect } from 'react'
import { useAuthStore } from './stores/authStore'
import { BubbleBackground } from './components/background/BubbleBackground'
import { AppShell } from './components/layout/AppShell'
import { LoginPage } from './components/auth/LoginPage'

export function App() {
  const { user, isLoading, init } = useAuthStore()

  useEffect(() => { init() }, [init])

  if (isLoading) {
    return (
      <>
        <BubbleBackground />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100dvh', gap: '16px' }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '50%',
            border: '3px solid rgba(255,255,255,0.08)',
            borderTopColor: '#7C3AED',
            animation: 'spinGlow 0.8s linear infinite',
          }} />
          <span style={{ color: 'var(--text-dim)', fontSize: '13px', letterSpacing: '0.5px' }}>Bubble Agent</span>
        </div>
      </>
    )
  }

  if (!user) {
    return (
      <>
        <BubbleBackground />
        <LoginPage />
      </>
    )
  }

  return (
    <>
      <BubbleBackground />
      <AppShell />
    </>
  )
}
