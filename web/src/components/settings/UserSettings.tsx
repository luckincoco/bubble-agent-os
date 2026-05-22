import { useState, useRef } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { getAllModules } from '../../modules/registry'
import { useModuleStore } from '../../stores/moduleStore'
import { Toggle } from '../common/Toggle'
import s from './UserSettings.module.css'

type Tab = 'profile' | 'modules'

interface Props {
  onClose: () => void
}

export function UserSettings({ onClose }: Props) {
  const user = useAuthStore((st) => st.user)
  const currentSpaceId = useAuthStore((st) => st.currentSpaceId)
  const switchSpace = useAuthStore((st) => st.switchSpace)
  const logout = useAuthStore((st) => st.logout)
  const [tab, setTab] = useState<Tab>('profile')
  const [avatarUrl, setAvatarUrl] = useState(() => localStorage.getItem('bubble_avatar') || '')
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      localStorage.setItem('bubble_avatar', url)
      setAvatarUrl(url)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const enabledIds = useModuleStore((st) => st.enabledModuleIds)
  const toggleModule = useModuleStore((st) => st.toggleModule)
  const optionalModules = getAllModules().filter(m => !m.locked)
  const hasOptionalModules = optionalModules.length > 0

  const spaces = user?.spaces || []
  const currentSpace = spaces.find(sp => sp.id === currentSpaceId)

  const handleLogout = () => {
    logout()
    onClose()
  }

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className={s.header}>
          <span className={s.title}>设置</span>
          <button className={s.closeBtn} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="2" y1="2" x2="12" y2="12" />
              <line x1="12" y1="2" x2="2" y2="12" />
            </svg>
          </button>
        </div>

        {/* Tab Nav */}
        <div className={s.tabs}>
          <button className={`${s.tab} ${tab === 'profile' ? s.tabActive : ''}`} onClick={() => setTab('profile')}>账户</button>
          {hasOptionalModules && (
            <button className={`${s.tab} ${tab === 'modules' ? s.tabActive : ''}`} onClick={() => setTab('modules')}>模块</button>
          )}
        </div>

        {/* Content */}
        <div className={s.body}>

          {/* ── 账户 ── */}
          {tab === 'profile' && (
            <div className={s.section}>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarSelect}
                hidden
              />
              <button
                className={s.avatar}
                onClick={() => avatarInputRef.current?.click()}
                title="更换头像"
              >
                {avatarUrl
                  ? <img src={avatarUrl} alt="" className={s.avatarImg} />
                  : (currentSpace?.name?.[0] || user?.displayName?.[0] || 'U')
                }
              </button>
              <div className={s.userInfo}>
                <span className={s.displayName}>{user?.displayName || '用户'}</span>
                <span className={s.username}>{currentSpace?.name || '个人空间'}</span>
              </div>

              <div className={s.divider} />

              <div className={s.fieldGroup}>
                <div className={s.fieldLabel}>所属空间</div>
                {user?.spaces?.map(sp => {
                  const isActive = sp.id === currentSpaceId
                  return (
                    <button key={sp.id} className={`${s.spaceItem} ${isActive ? s.spaceItemActive : ''}`} onClick={() => switchSpace(sp.id)}>
                      <span className={`${s.spaceDot} ${isActive ? s.spaceDotActive : ''}`} />
                      <span className={s.spaceName}>{sp.name}</span>
                      {sp.description && <span className={s.spaceDesc}>{sp.description}</span>}
                    </button>
                  )
                })}
              </div>

              <div className={s.divider} />

              <button className={s.logoutBtn} onClick={handleLogout}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 2H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" />
                  <polyline points="9 10, 12 7, 9 4" />
                  <line x1="12" y1="7" x2="5" y2="7" />
                </svg>
                退出登录
              </button>
            </div>
          )}

          {tab === 'modules' && (
            <div className={s.section}>
              {optionalModules.map(m => {
                const isEnabled = enabledIds.includes(m.id)
                return (
                  <div key={m.id} className={s.moduleItem}>
                    <div className={s.moduleInfo}>
                      <div>
                        <span className={s.moduleLabel}>{m.onboarding?.title || m.tab.label}</span>
                        {m.onboarding?.description && (
                          <span className={s.moduleDesc}>{m.onboarding.description}</span>
                        )}
                      </div>
                    </div>
                    <Toggle checked={isEnabled} onChange={() => toggleModule(m.id)} />
                  </div>
                )
              })}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
