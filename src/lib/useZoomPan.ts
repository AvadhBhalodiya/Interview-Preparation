import { useCallback, useEffect, useRef, useState } from 'react'

// Pan/zoom for the fullscreen diagram viewer. Hand-rolled rather than pulling in
// svg-pan-zoom or panzoom: the whole behaviour is ~80 lines and the repo has
// kept its dependency list deliberately short.
//
// The one rule that matters in a reading app: a bare wheel must never be
// swallowed. Readers scroll past diagrams constantly, and a container that
// zooms on plain wheel traps the page. Zoom is therefore ctrl/⌘+wheel (which is
// also what the browser's own pinch gesture sends on a trackpad), and dragging
// is what pans.

const MIN = 0.25
const MAX = 8
const STEP = 1.15

export interface Transform {
  scale: number
  x: number
  y: number
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }

export function useZoomPan(enabled = true) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [t, setT] = useState<Transform>(IDENTITY)
  const [dragging, setDragging] = useState(false)

  // Live pointer bookkeeping, kept in refs so a move never re-renders on its own.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; scale: number } | null>(null)

  const reset = useCallback(() => setT(IDENTITY), [])

  const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s))

  /** Zoom about a fixed point so the content under the cursor stays put. */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setT((prev) => {
      const scale = clamp(prev.scale * factor)
      const k = scale / prev.scale
      return { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k }
    })
  }, [])

  const zoomIn = useCallback(() => setT((p) => ({ ...p, scale: clamp(p.scale * STEP) })), [])
  const zoomOut = useCallback(() => setT((p) => ({ ...p, scale: clamp(p.scale / STEP) })), [])

  // Wheel has to be a non-passive native listener: React's onWheel is registered
  // passively, so preventDefault() there is ignored and the browser page-zooms
  // on top of us.
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return // let the page scroll
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(Math.pow(0.999, e.deltaY), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [enabled, zoomAt])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.current.size === 1) setDragging(true)
    },
    [enabled],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      const pts = pointers.current
      const prev = pts.get(e.pointerId)
      if (!prev) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pts.size === 2) {
        // Pinch: drive scale off the distance between the two contacts.
        const [a, b] = [...pts.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (!pinch.current) pinch.current = { dist, scale: t.scale }
        else {
          const next = clamp(pinch.current.scale * (dist / pinch.current.dist))
          setT((p) => ({ ...p, scale: next }))
        }
        return
      }
      setT((p) => ({ ...p, x: p.x + (e.clientX - prev.x), y: p.y + (e.clientY - prev.y) }))
    },
    [enabled, t.scale],
  )

  const endPointer = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) setDragging(false)
  }, [])

  return {
    ref,
    transform: t,
    dragging,
    reset,
    zoomIn,
    zoomOut,
    /** Spread onto the pan surface. */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onPointerLeave: endPointer,
    },
  }
}
