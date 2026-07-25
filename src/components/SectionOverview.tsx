import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { motion, useReducedMotion, type Variants } from 'motion/react'
import { LuArrowRight, LuCheck } from 'react-icons/lu'
import { getSections } from '../lib/content'
import { sectionIcon } from '../lib/sectionIcons'
import { groupIcon } from '../lib/groupIcons'
import { useDoneNotes } from '../lib/useProgress'
import { NotFound } from './NotFound'

// The landing page for a section: every note, grouped, each with its one-line
// summary and done state. Previously a Home card dropped you straight into
// note #1 with no way to see what a section actually covered.
export function SectionOverview() {
  const { section = '' } = useParams()
  const meta = getSections().find((s) => s.slug === section)
  const done = useDoneNotes()
  const reduce = useReducedMotion()

  useEffect(() => {
    if (meta) document.title = `${meta.label} · Interview Notes`
  }, [meta])

  if (!meta) return <NotFound />

  const { Icon, color } = sectionIcon(meta.slug)
  const read = meta.notes.reduce((n, note) => n + (done.has(note.path) ? 1 : 0), 0)
  const pct = meta.notes.length ? Math.round((read / meta.notes.length) * 100) : 0

  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.03 } },
  }
  const item: Variants = {
    hidden: reduce ? { opacity: 1 } : { opacity: 0, y: 8 },
    show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex items-center gap-3">
        <span
          className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-tint"
          style={{ color }}
        >
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h1 className="text-3xl font-black tracking-tight text-heading">{meta.label}</h1>
          <p className="mt-0.5 font-mono text-[12px] text-secondary">
            {meta.notes.length} {meta.notes.length === 1 ? 'note' : 'notes'}
            {read > 0 && ` · ${read} read (${pct}%)`}
          </p>
        </div>
      </div>

      {read > 0 && (
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-surface-hover">
          <div
            className="h-full rounded-full bg-[var(--success)] transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <motion.div className="mt-8 space-y-8" variants={container} initial="hidden" animate="show">
        {meta.groups.map((g) => {
          const GroupIcon = groupIcon(g.name)
          return (
            <div key={g.name}>
              <div className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-secondary">
                <GroupIcon className="h-3.5 w-3.5 shrink-0" />
                <span>{g.name}</span>
              </div>
              <div className="grid grid-cols-1 gap-2.5">
                {g.notes.map((n) => {
                  const isDone = done.has(n.path)
                  // Same lift + gradient hairline as the Home cards: these are
                  // visually the same component and were reading as two
                  // different ones on hover.
                  return (
                    <motion.div key={n.slug} variants={item} whileHover={reduce ? undefined : { y: -3 }}>
                      <Link
                        to={n.path}
                        className="group relative flex items-start gap-3 overflow-hidden rounded-xl border border-border bg-surface p-4 transition duration-200 hover:border-accent hover:shadow-lg hover:shadow-[color:var(--glow)]"
                      >
                        <span
                          aria-hidden
                          className="absolute inset-x-0 top-0 h-0.5 brand-gradient opacity-0 transition duration-200 group-hover:opacity-100"
                        />
                        <span
                          aria-hidden
                          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition ${
                            isDone
                              ? 'border-[var(--success)] bg-[var(--success)] text-white'
                              : 'border-border text-transparent'
                          }`}
                        >
                          <LuCheck className="h-3 w-3" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-bold text-heading">{n.title}</span>
                          {n.oneLine && (
                            <span className="mt-0.5 block text-[13.5px] leading-relaxed text-secondary">
                              {n.oneLine}
                            </span>
                          )}
                        </span>
                        <LuArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
                      </Link>
                    </motion.div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </motion.div>
    </div>
  )
}
