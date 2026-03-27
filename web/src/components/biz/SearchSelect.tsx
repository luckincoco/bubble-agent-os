import { useState, useRef, useEffect, useCallback } from 'react'
import s from './SearchSelect.module.css'

interface Option {
  id: string
  label: string
}

interface Props {
  label: string
  value: string
  onChange: (id: string) => void
  options: Option[]
  placeholder?: string
}

export function SearchSelect({ label, value, onChange, options, placeholder }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.id === value)

  const filtered = query
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  const handleSelect = useCallback((id: string) => {
    onChange(id)
    setQuery('')
    setOpen(false)
  }, [onChange])

  const handleClear = useCallback(() => {
    onChange('')
    setQuery('')
    setOpen(false)
  }, [onChange])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className={s.field}>
      <label className={s.label}>{label}</label>
      <div className={s.wrapper} ref={ref}>
        <input
          ref={inputRef}
          className={s.input}
          value={open ? query : (selected?.label ?? '')}
          placeholder={placeholder || '搜索...'}
          onFocus={() => { setOpen(true); setQuery('') }}
          onChange={e => setQuery(e.target.value)}
          autoComplete="off"
        />
        {value && (
          <button className={s.clear} onClick={handleClear} type="button" aria-label="清除">&times;</button>
        )}
        {open && (
          <div className={s.dropdown}>
            {filtered.length === 0 ? (
              <div className={s.empty}>无匹配项</div>
            ) : (
              filtered.slice(0, 30).map(o => (
                <div
                  key={o.id}
                  className={s.option}
                  data-selected={o.id === value}
                  onClick={() => handleSelect(o.id)}
                >
                  {o.label}
                </div>
              ))
            )}
            {filtered.length > 30 && (
              <div className={s.more}>还有 {filtered.length - 30} 项，请输入更多关键字...</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
