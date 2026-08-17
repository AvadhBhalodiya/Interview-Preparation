import { forwardRef, useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { LuX, LuZoomIn, LuZoomOut, LuRotateCcw, LuDownload, LuImage } from 'react-icons/lu'
import { useZoomPan } from '../lib/useZoomPan'
import { downloadPng, downloadSvg } from '../lib/diagramExport'

// Fullscreen diagram viewer. 334 of the 538 flowcharts in the notes are
// `flowchart LR` — the widest kind — and the reading column is capped at 68ch,
// so the large ones are cramped inline by design. This is where they get read.
//
// Follows the drawer in Layout.tsx for the overlay mechanics (AnimatePresence,
// body scroll lock restored on cleanup, Escape to close) so the app has one
// idiom rather than two. Sits above the sticky header (z-30), the drawer scrim
// (z-40) and the drawer/search (z-50).

export function DiagramOverlay({
  open,
  onClose,
  svg,
  title,
  surface,
}: {
  open: boolean
  onClose: () => void
  svg: string
  title: string
  surface: string
}) {
  const reduce = useReducedMotion()
  const panel = useRef<HTMLDivElement | null>(null)
  const closeBtn = useRef<HTMLButtonElement | null>(null)
  const { ref, transform, dragging, reset, zoomIn, zoomOut, handlers } = useZoomPan(open)

  // Lock the page behind the overlay and wire Escape — same shape as
  // Layout.tsx:42-52, including restoring the caller's own overflow value.
  useEffect(() => {
    if (!open) return
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      // Minimal focus trap: the overlay is modal, so Tab must not walk into the
      // note behind it.
      const items = panel.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  // Every open starts from a known position rather than wherever the last one
  // was left, and focus moves into the dialog for keyboard users.
  useEffect(() => {
    if (!open) return
    reset()
    closeBtn.current?.focus()
  }, [open, reset])

  const svgEl = () => ref.current?.querySelector('svg') as SVGSVGElement | null
  const onSvg = () => {
    const el = svgEl()
    if (el) downloadSvg(el, title, surface)
  }
  const onPng = () => {
    const el = svgEl()
    if (el) void downloadPng(el, title, surface)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex flex-col bg-black/70 backdrop-blur-sm"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={`${title} — expanded diagram`}
            className="relative z-[70] flex h-full flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
              <span className="truncate text-sm font-medium text-heading">{title}</span>
              <div className="flex shrink-0 items-center gap-1">
                <OverlayBtn onClick={zoomOut} label="Zoom out">
                  <LuZoomOut />
                </OverlayBtn>
                <span className="w-12 text-center font-mono text-xs text-secondary" aria-live="polite">
                  {Math.round(transform.scale * 100)}%
                </span>
                <OverlayBtn onClick={zoomIn} label="Zoom in">
                  <LuZoomIn />
                </OverlayBtn>
                <OverlayBtn onClick={reset} label="Reset view">
                  <LuRotateCcw />
                </OverlayBtn>
                <OverlayBtn onClick={onSvg} label="Download SVG">
                  <LuDownload />
                </OverlayBtn>
                <OverlayBtn onClick={onPng} label="Download PNG">
                  <LuImage />
                </OverlayBtn>
                <OverlayBtn onClick={onClose} label="Close" ref={closeBtn}>
                  <LuX />
                </OverlayBtn>
              </div>
            </div>

            <div
              ref={ref}
              className="diagram-stage flex-1 overflow-hidden"
              style={{ background: surface, cursor: dragging ? 'grabbing' : 'grab' }}
              {...handlers}
            >
              <div
                className="h-full w-full origin-top-left"
                style={{
                  transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                }}
                // Already sanitized by mermaid (securityLevel: 'strict').
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>

            <p className="border-t border-border bg-surface px-3 py-1.5 text-center text-xs text-muted">
              Drag to pan · ⌘/Ctrl + scroll to zoom · Esc to close
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const OverlayBtn = forwardRef<
  HTMLButtonElement,
  { onClick: () => void; label: string; children: ReactNode }
>(function OverlayBtn({ onClick, label, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="diagram-btn"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
})
