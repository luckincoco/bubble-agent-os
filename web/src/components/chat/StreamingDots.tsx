import s from './StreamingDots.module.css'

export function StreamingDots() {
  return (
    <div className={s.dots}>
      <div className={s.dot} />
      <div className={s.dot} />
      <div className={s.dot} />
    </div>
  )
}
