import { useEffect, useCallback, useState, useRef } from 'react'
import s from './RightDrawer.module.css'

const SNAP_POINTS_DRAWER = [240, 360, 480]
const DRAWER_MIN = 240
const DRAWER_MAX = 480
const MAIN_MIN = 400

interface Props {
  title: string
  onClose: () => void
  children: React.ReactNode
  open: boolean
}

export function RightDrawer({ title, onClose, children, open }: Props) {
  const [drawerWidth, setDrawerWidth] = useState(() => {
    try {
      return parseInt(localStorage.getItem('bubble.drawer.width') || '360', 10)
    } catch {
      return 360
    }
  })
  const [isDragging, setIsDragging] = useState(false)
  const dragState = useRef<{ startX: number; startWidth: number }>({ startX: 0, startWidth: 0 })
  const currentWidth = useRef(drawerWidth)

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, handleKeyDown])

  const snap = useCallback((w: number) => {
    return SNAP_POINTS_DRAWER.reduce((prev, curr) =>
      Math.abs(curr - w) < Math.abs(prev - w) ? curr : prev
    )
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const delta = e.clientX - dragState.current.startX
    // Read sidebar width from DOM
    const sidebarEl = document.querySelector('[data-sidebar]')
    const sidebarWidth = sidebarEl?.getBoundingClientRect().width ?? 240
    const viewportWidth = window.innerWidth
    // Drawer on right: dragging left (negative delta) = wider drawer
    // Ensure main area stays >= MAIN_MIN
    const effectiveMax = Math.min(
      DRAWER_MAX,
      viewportWidth - sidebarWidth - MAIN_MIN
    )
    const newWidth = Math.max(DRAWER_MIN, Math.min(effectiveMax, dragState.current.startWidth - delta))
    currentWidth.current = newWidth
    setDrawerWidth(newWidth)
  }, [])

  const handleMouseUp = useCallback(() => {
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
    document.body.style.userSelect = ''
    setIsDragging(false)

    const snapped = snap(currentWidth.current)
    setDrawerWidth(snapped)
    localStorage.setItem('bubble.drawer.width', String(snapped))
  }, [handleMouseMove, snap])

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { startX: e.clientX, startWidth: drawerWidth }
    setIsDragging(true)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.userSelect = 'none'
  }

  return (
    <aside
      className={s.drawer}
      style={{
        width: open ? `${drawerWidth}px` : '0',
      } as React.CSSProperties}
    >
      {open && (
        <div
          className={`${s.resizeHandle} ${isDragging ? s.resizeHandleActive : ''}`}
          onMouseDown={handleMouseDown}
        />
      )}
      <div className={s.header}>
        <span className={s.title}>{title}</span>
        <button className={s.closeBtn} onClick={onClose} title="关闭">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>
      </div>
      <div className={s.body}>
        {children}
      </div>
    </aside>
  )
}
