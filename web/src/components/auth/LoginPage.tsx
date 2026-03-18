import { useState } from 'react'
import { useAuthStore } from '../../stores/authStore'
import s from './LoginPage.module.css'

export function LoginPage() {
  const { login, error, isLoading } = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password || isLoading) return
    login(username, password)
  }

  return (
    <div className={s.page}>
      <form className={s.card} onSubmit={handleSubmit}>
        <div className={s.logo}>B</div>
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
      </form>
    </div>
  )
}
