import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { LuChevronRight } from 'react-icons/lu'
import { flattenToc, type TocNode } from '../lib/toc'

export function TableOfContents({ items }: { items: TocNode[] }) {
  const [active, setActive] = useState('')
  // Only holds sections the reader has explicitly toggled. Everything else
  // follows the scroll position, so the tree stays short without going stale.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const reduce = useReducedMotion()
  const navRef = useRef<HTMLElement>(null)
  const listV: Variants = { hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.03 } } }
  const itemV: Variants = {
    hidden: reduce ? { opacity: 1 } : { opacity: 0, x: 6 },
    show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  }

  const flat = useMemo(() => flattenToc(items), [items])

  // The main section that owns the heading you're reading — it is either the
  // active row itself or the parent of it. Before the observer has reported
  // anything, the first section stands in so the tree isn't fully shut on load.
  const activeMain = useMemo(() => {
    if (!active) return items[0]?.id ?? ''
    const owner = items.find((s) => s.id === active || s.children.some((c) => c.id === active))
    return owner?.id ?? ''
  }, [items, active])

  // Manual toggles are per-note; navigating away resets to auto-expand.
  useEffect(() => setOverrides({}), [items])

  useEffect(() => {
    if (flat.length === 0) return
    const headings = flat
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
  }, [flat])

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

  const isOpen = (id: string) => overrides[id] ?? id === activeMain

  const jump = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActive(id)
    }
  }

  const toggle = (id: string) => setOverrides((o) => ({ ...o, [id]: !isOpen(id) }))

  // Clicking a section header drops any manual override rather than forcing the
  // section open, so it goes back to following the scroll position from there.
  const openSection = (id: string) =>
    setOverrides((o) => {
      if (!(id in o)) return o
      const next = { ...o }
      delete next[id]
      return next
    })

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
        {items.map((s) => {
          const open = isOpen(s.id)
          const hasChildren = s.children.length > 0
          return (
            <motion.li key={s.id} variants={itemV}>
              <div className="relative flex items-start" data-toc-id={s.id}>
                {active === s.id && <ActiveBar reduce={reduce} />}
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggle(s.id)}
                    aria-expanded={open}
                    aria-controls={`toc-sub-${s.id}`}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${s.text}`}
                    className="mt-1 grid h-5 w-4 shrink-0 place-items-center text-secondary transition hover:text-fg"
                  >
                    <LuChevronRight
                      className={`h-3 w-3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
                      aria-hidden
                    />
                  </button>
                ) : (
                  // Keeps childless sections' labels on the same left edge as
                  // the ones that do have a chevron.
                  <span className="h-5 w-4 shrink-0" aria-hidden />
                )}
                <button
                  type="button"
                  onClick={() => {
                    jump(s.id)
                    openSection(s.id)
                  }}
                  className={`block flex-1 py-1 text-left text-[13px] leading-snug transition ${
                    active === s.id
                      ? 'font-semibold text-accent'
                      : 'font-medium text-fg/85 hover:text-fg'
                  }`}
                >
                  {s.text}
                </button>
              </div>
              <AnimatePresence initial={false}>
                {hasChildren && open && (
                  <motion.ul
                    id={`toc-sub-${s.id}`}
                    // The left hairline is the branch line; it lines up under
                    // the chevron that opened it.
                    className="ml-4 space-y-0.5 overflow-hidden border-l border-border pl-3"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
                  >
                    {s.children.map((c) => (
                      <li key={c.id} className="relative" data-toc-id={c.id}>
                        {active === c.id && <ActiveBar reduce={reduce} nested />}
                        <button
                          type="button"
                          onClick={() => jump(c.id)}
                          className={`block w-full py-1 text-left text-[12.5px] leading-snug transition ${
                            active === c.id
                              ? 'font-semibold text-accent'
                              : 'text-secondary hover:text-fg'
                          }`}
                        >
                          {c.text}
                        </button>
                      </li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </motion.li>
          )
        })}
      </motion.ul>
    </nav>
  )
}

// One shared marker slides between rows. On a subsection it sits exactly on the
// branch hairline, so the line itself lights up rather than gaining a second
// stripe next to it. `-left-3` lands on the parent list's padding edge — any
// further left and `overflow-hidden` (needed for the expand animation) clips it.
function ActiveBar({ reduce, nested = false }: { reduce: boolean | null; nested?: boolean }) {
  return (
    <motion.span
      layoutId="toc-active"
      className={`absolute top-1 h-[calc(100%-0.5rem)] w-0.5 rounded bg-accent ${
        nested ? '-left-3' : 'left-0'
      }`}
      // Layout animations ignore initial/exit guards; this needs its own.
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }}
    />
  )
}
