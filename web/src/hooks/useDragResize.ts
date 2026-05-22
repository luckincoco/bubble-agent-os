import { useState, useRef, useCallback, useEffect } from 'react'

interface UseDragResizeOptions {
  /** Ref to the draggable element (for transition management) */
  ref: React.RefObject<HTMLElement | null>
  /** Initial width in px */
  initialWidth: number
  /** Minimum width in px */
  minWidth: number
  /** Maximum width in px */
  maxWidth: number
  /** Snap points (e.g. [160, 240, 320]) */
  snapPoints: number[]
  /** Called on every pixel change during drag */
  onWidthChange: (w: number) => void
  /** Called when drag ends with the final snapped width */
  onDragEnd: (w: number) => void
  /** True if dragging from the RIGHT edge (delta positive = wider).
   *  True for sidebar (drag handle is on right edge).
   *  False for drawer (drag handle is on left edge, delta inverted). */
  rightSide?: boolean
}

export function useDragResize({
  ref,
  initialWidth,
  minWidth,
  maxWidth,
  snapPoints,
  onWidthChange,
  onDragEnd,
  rightSide = true,
}: UseDragResizeOptions) {
  const [isDragging, setIsDragging] = useState(false)
  const dragState = useRef<{ startX: number; startWidth: number }>({ startX: 0, startWidth: 0 })
  const currentWidth = useRef(initialWidth)

  const snap = useCallback((w: number) => {
    return snapPoints.reduce((prev, curr) =>
      Math.abs(curr - w) < Math.abs(prev - w) ? curr : prev
    )
  }, [snapPoints])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const delta = e.clientX - dragState.current.startX
    const raw = rightSide
      ? dragState.current.startWidth + delta
      : dragState.current.startWidth - delta
    const clamped = Math.max(minWidth, Math.min(maxWidth, raw))
    currentWidth.current = clamped
    onWidthChange(clamped)
  }, [minWidth, maxWidth, onWidthChange, rightSide])

  const handleMouseUp = useCallback(() => {
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
    document.body.style.userSelect = ''
    setIsDragging(false)

    const final = snap(currentWidth.current)
    onWidthChange(final)
    onDragEnd(final)
  }, [handleMouseMove, snap, onWidthChange, onDragEnd])

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { startX: e.clientX, startWidth: currentWidth.current }
    setIsDragging(true)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.userSelect = 'none'
  }, [handleMouseMove, handleMouseUp])

  return {
    isDragging,
    handleMouseDown,
  }
}
