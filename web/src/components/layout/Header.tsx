import { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useAuthStore } from '../../stores/authStore'
import { changePassword } from '../../services/api'
import s from './Header.module.css'

export function Header() {
  const status = useChatStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const currentSpaceId = useAuthStore((s) => s.currentSpaceId)
  const switchSpace = useAuthStore((s) => s.switchSpace)
  const logout = useAuthStore((s) => s.logout)

  const [showPwd, setShowPwd] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [pwdMsg, setPwdMsg] = useState('')
  const [pwdLoading, setPwdLoading] = useState(false)

  const spaces = user?.spaces || []
  const currentSpace = spaces.find(s => s.id === currentSpaceId)

  const handleChangePwd = async () => {
    if (!oldPwd || !newPwd) { setPwdMsg('请填写完整'); return }
    if (newPwd.length < 6) { setPwdMsg('新密码至少6位'); return }
    setPwdLoading(true)
    setPwdMsg('')
    try {
      await changePassword(oldPwd, newPwd)
      setPwdMsg('修改成功')
      setOldPwd('')
      setNewPwd('')
      setTimeout(() => setShowPwd(false), 1200)
    } catch (err) {
      setPwdMsg(err instanceof Error ? err.message : '修改失败')
    } finally {
      setPwdLoading(false)
    }
  }

  return (
    <header className={s.header}>
      <div className={s.logo}>B</div>
      <span className={s.title}>Bubble Agent</span>
      <div className={s.spacer} />
      {spaces.length > 1 && (
        <select
          className={s.spaceSelect}
          value={currentSpaceId || ''}
          onChange={(e) => switchSpace(e.target.value)}
        >
          {spaces.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.name}</option>
          ))}
        </select>
      )}
      {spaces.length === 1 && currentSpace && (
        <span className={s.spaceName}>{currentSpace.name}</span>
      )}
      <div className={s.dot} data-status={status} title={status} />
      {user && (
        <div className={s.userMenu}>
          <button className={s.userBtn} onClick={() => setShowPwd(!showPwd)}>
            {user.displayName}
          </button>
          {showPwd && (
            <div className={s.pwdPanel}>
              <input
                className={s.pwdInput}
                type="password"
                placeholder="旧密码"
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
              />
              <input
                className={s.pwdInput}
                type="password"
                placeholder="新密码 (至少6位)"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
              />
              <div className={s.pwdActions}>
                <button className={s.pwdBtn} onClick={handleChangePwd} disabled={pwdLoading}>
                  {pwdLoading ? '...' : '确认修改'}
                </button>
                <button className={s.logoutLink} onClick={logout}>退出登录</button>
              </div>
              {pwdMsg && <div className={s.pwdMsg}>{pwdMsg}</div>}
            </div>
          )}
        </div>
      )}
    </header>
  )
}
