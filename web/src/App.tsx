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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--text-dim)' }}>
          Loading...
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
