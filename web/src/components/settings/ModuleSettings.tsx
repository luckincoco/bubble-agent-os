import { getAllModules } from '../../modules/registry'
import { useModuleStore } from '../../stores/moduleStore'
import { Toggle } from '../common/Toggle'
import s from './ModuleSettings.module.css'

interface Props {
  onClose: () => void
}

export function ModuleSettings({ onClose }: Props) {
  const enabledIds = useModuleStore((st) => st.enabledModuleIds)
  const toggleModule = useModuleStore((st) => st.toggleModule)
  const modules = getAllModules()

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <h3 className={s.title}>功能模块</h3>
          <button className={s.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <div className={s.list}>
          {modules.map(m => {
            const isEnabled = enabledIds.includes(m.id)
            return (
              <div key={m.id} className={s.item}>
                <div className={s.info}>
                  {m.onboarding?.emoji && <span className={s.emoji}>{m.onboarding.emoji}</span>}
                  <div>
                    <span className={s.label}>{m.onboarding?.title || m.tab.label}</span>
                    {m.onboarding?.description && (
                      <span className={s.desc}>{m.onboarding.description}</span>
                    )}
                    {m.locked && <span className={s.locked}>核心功能</span>}
                  </div>
                </div>
                <Toggle
                  checked={isEnabled}
                  disabled={m.locked}
                  onChange={() => toggleModule(m.id)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
