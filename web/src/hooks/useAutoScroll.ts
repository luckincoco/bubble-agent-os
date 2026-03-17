import { useEffect, useRef } from 'react'

export function useAutoScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, deps)
  return ref
}
