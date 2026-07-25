import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { LuChevronDown, LuCheck, LuLayoutList } from 'react-icons/lu'
import { groupIcon } from '../lib/groupIcons'
import { sectionIcon } from '../lib/sectionIcons'
import { getSections } from '../lib/content'
import { useDoneNotes } from '../lib/useProgress'
import type { Section } from '../lib/types'

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const sections = getSections()
  // Single-open accordion driven by the active route: on Home nothing is open;
  // navigating into a section (e.g. clicking a Home card) opens only that one.
  const activeSlug = useLocation().pathname.split('/').filter(Boolean)[0] || null
  const [openSlug, setOpenSlug] = useState<string | null>(activeSlug)
  useEffect(() => {
    setOpenSlug(activeSlug)
  }, [activeSlug])

  return (
    <nav aria-label="Sections" className="flex flex-col gap-3">
      {sections.map((s) => (
        <SectionNav
          key={s.slug}
          section={s}
          open={openSlug === s.slug}
          onToggle={() => setOpenSlug((cur) => (cur === s.slug ? null : s.slug))}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  )
}

function SectionNav({
  section,
  open,
  onToggle,
  onNavigate,
}: {
  section: Section
  open: boolean
  onToggle: () => void
  onNavigate: () => void
}) {
  const reduce = useReducedMotion()
  const { Icon: SecIcon, color: secColor } = sectionIcon(section.slug)
  const done = useDoneNotes()
  const doneCount = section.notes.reduce((n, note) => n + (done.has(note.path) ? 1 : 0), 0)
  const allDone = doneCount === section.notes.length && section.notes.length > 0
  let idx = 0

  return (
    <div>
      {/* Level 1: section */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="tap-target flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[16px] font-bold text-heading transition hover:bg-surface-hover"
      >
        <SecIcon aria-hidden className="h-[18px] w-[18px] shrink-0" style={{ color: secColor }} />
        <span className="min-w-0 leading-snug">{section.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Reads "3/17" once you've started, plain "17" before that, so the
              badge doesn't nag about sections you haven't touched yet. */}
          <span
            className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
              allDone
                ? 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success)]'
                : 'bg-surface-hover text-secondary'
            }`}
          >
            {doneCount > 0 ? `${doneCount}/${section.notes.length}` : section.notes.length}
          </span>
          <LuChevronDown
            className={`h-4 w-4 text-secondary transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
          />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="overflow-hidden"
          >
        <div className="mt-1">
          {/* The section button itself stays the accordion toggle, so the route
              to the overview needs its own affordance. */}
          <NavLink
            to={`/${section.slug}`}
            end
            onClick={onNavigate}
            className={({ isActive }) =>
              `tap-target mt-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-semibold transition ${
                isActive ? 'bg-accent-tint text-accent' : 'text-secondary hover:text-accent'
              }`
            }
          >
            <LuLayoutList className="h-3.5 w-3.5 shrink-0" />
            Section overview
          </NavLink>

          {section.groups.map((g) => {
            const Icon = groupIcon(g.name)
            return (
              <div key={g.name} className="mt-6 first:mt-3">
                {/* Level 2: group / sub-section */}
                <div className="mb-2 flex items-center gap-2 px-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-secondary">
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{g.name}</span>
                </div>

                {/* Level 3: topics, nested under a guide rail */}
                <div className="ml-[15px] flex flex-col border-l border-border pl-2">
                  {g.notes.map((n) => {
                    const delay = reduce ? 0 : Math.min(idx++ * 0.012, 0.25)
                    return (
                      <motion.div
                        key={n.slug}
                        initial={reduce ? false : { opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay, duration: 0.2, ease: 'easeOut' }}
                      >
                        <NavLink to={n.path} onClick={onNavigate} className="block">
                          {({ isActive }) => (
                            <span
                              className={`tap-target group relative my-[1px] block rounded-md px-2.5 py-1.5 text-[13.5px] transition ${
                                isActive ? '' : 'hover:bg-surface-hover'
                              }`}
                            >
                              {isActive && (
                                <motion.span
                                  layoutId="sidebar-active"
                                  className="absolute inset-0 rounded-md bg-accent-tint"
                                  // A layout animation runs regardless of the
                                  // initial/exit guards, so it needs its own.
                                  transition={
                                    reduce
                                      ? { duration: 0 }
                                      : { type: 'spring', stiffness: 600, damping: 42 }
                                  }
                                />
                              )}
                              <span
                                className={`relative z-10 flex items-center gap-1.5 ${
                                  isActive
                                    ? 'font-medium text-accent'
                                    : 'text-secondary group-hover:text-fg'
                                }`}
                              >
                                <span className="min-w-0 flex-1">{n.title}</span>
                                {done.has(n.path) && (
                                  <LuCheck
                                    aria-label="Done"
                                    className="h-3.5 w-3.5 shrink-0 text-[var(--success)]"
                                  />
                                )}
                              </span>
                            </span>
                          )}
                        </NavLink>
                      </motion.div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
