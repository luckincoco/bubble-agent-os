import s from './BubbleBackground.module.css'

export function BubbleBackground() {
  return (
    <div className={s.backdrop}>
      <div className={s.orb} />
      <div className={s.orb} />
      <div className={s.orb} />
      <div className={s.orb} />
      <div className={s.orb} />
      <div className={s.orb} />
    </div>
  )
}
