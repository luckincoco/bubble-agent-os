import { useChatStore } from '../../stores/chatStore'
import s from './Header.module.css'

export function Header() {
  const status = useChatStore((s) => s.status)

  return (
    <header className={s.header}>
      <div className={s.logo}>B</div>
      <span className={s.title}>Bubble Agent</span>
      <div className={s.spacer} />
      <div className={s.dot} data-status={status} title={status} />
    </header>
  )
}
