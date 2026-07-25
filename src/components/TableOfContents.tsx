import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion, type Variants } from 'motion/react'
import type { TocItem } from '../lib/toc'

export function TableOfContents({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState('')
  const reduce = useReducedMotion()
  const navRef = useRef<HTMLElement>(null)
  const listV: Variants = { hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.03 } } }
  const itemV: Variants = {
    hidden: reduce ? { opacity: 1 } : { opacity: 0, x: 6 },
    show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  }

  useEffect(() => {
    if (items.length === 0) return
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null)

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-76px 0px -70% 0px', threshold: [0, 1] }
    )
    headings.forEach((h) => observer.observe(h))
    return () => observer.disconnect()
  }, [items])

  // Keep the highlighted item visible inside the TOC as you read a long note.
  // Scrolls ONLY the nav (never the page): nudges just enough when the active
  // row has drifted past either edge, so it doesn't re-center on every change.
  useEffect(() => {
    const nav = navRef.current
    if (!nav || !active) return
    const el = nav.querySelector<HTMLElement>(`[data-toc-id="${active}"]`)
    if (!el) return
    const n = nav.getBoundingClientRect()
    const e = el.getBoundingClientRect()
    let delta = 0
    if (e.top < n.top) delta = e.top - n.top - 8
    else if (e.bottom > n.bottom) delta = e.bottom - n.bottom + 8
    if (delta) nav.scrollTo({ top: nav.scrollTop + delta, behavior: reduce ? 'auto' : 'smooth' })
  }, [active, reduce])

  if (items.length === 0) return null

  const jump = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActive(id)
    }
  }

  return (
    <nav
      ref={navRef}
      className="sticky top-20 hidden max-h-[calc(100vh-6rem)] w-56 shrink-0 overflow-y-auto py-1 xl:block"
      aria-label="On this page"
    >
      <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-secondary">
        On this page
      </div>
      <motion.ul className="space-y-0.5" variants={listV} initial="hidden" animate="show">
        {items.map((i) => (
          <motion.li key={i.id} variants={itemV} className="relative" data-toc-id={i.id}>
            {active === i.id && (
              <motion.span
                layoutId="toc-active"
                className="absolute left-0 top-1 h-[calc(100%-0.5rem)] w-0.5 rounded bg-accent"
                // Layout animations ignore initial/exit guards; this needs its own.
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
            <button
              type="button"
              onClick={() => jump(i.id)}
              className={`block w-full py-1 pl-3 text-left text-[13px] leading-snug transition ${
                active === i.id ? 'font-semibold text-accent' : 'text-secondary hover:text-fg'
              }`}
            >
              {i.text}
            </button>
          </motion.li>
        ))}
      </motion.ul>
    </nav>
  )
}
