import { useState, useEffect } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { fetchHealth } from '../../services/api'
import s from './LoginPage.module.css'

export function LoginPage() {
  const { login, error, isLoading } = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [version, setVersion] = useState('')

  useEffect(() => {
    fetchHealth().then((d) => setVersion(d.version)).catch(() => {})
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password || isLoading) return
    login(username, password)
  }

  return (
    <div className={s.page}>
      <form className={s.card} onSubmit={handleSubmit}>
        <div className={s.logo}>
          <svg viewBox="0 0 64 64" width="64" height="64">
            <defs>
              <radialGradient id="logoGrad" cx="40%" cy="35%" r="50%">
                <stop offset="0%" stop-color="#a78bfa" />
                <stop offset="50%" stop-color="#7C3AED" />
                <stop offset="100%" stop-color="#2563EB" />
              </radialGradient>
            </defs>
            <circle cx="32" cy="32" r="28" fill="url(#logoGrad)" opacity="0.9" />
            <circle cx="24" cy="22" r="6" fill="white" opacity="0.25" />
          </svg>
        </div>
        <h1 className={s.title}>Bubble Agent</h1>
        <input
          className={s.input}
          type="text"
          placeholder="用户名"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          className={s.input}
          type="password"
          placeholder="密码"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className={s.error}>{error}</div>}
        <button className={s.btn} type="submit" disabled={isLoading || !username || !password}>
          {isLoading ? '登录中...' : '登录'}
        </button>
        <div className={s.registerHint}>
          没有账号？<a href="mailto:admin@bubble.ai">联系管理员</a>
        </div>
      </form>
      {version && <span className={s.version}>v{version}</span>}
    </div>
  )
}
