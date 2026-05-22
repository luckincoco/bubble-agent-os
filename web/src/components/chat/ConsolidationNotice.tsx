import s from './ConsolidationNotice.module.css'

export function ConsolidationNotice({ text }: { text: string }) {
  return (
    <div className={s.notice}>
      <span className={s.line} />
      <span className={s.text}>记忆已更新：{text}</span>
      <span className={s.line} />
    </div>
  )
}
