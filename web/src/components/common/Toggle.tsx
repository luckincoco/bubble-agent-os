import s from './Toggle.module.css'

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function Toggle({ checked, onChange, disabled }: Props) {
  return (
    <button
      className={s.toggle}
      data-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      type="button"
      aria-pressed={checked}
    >
      <span className={s.thumb} />
    </button>
  )
}
