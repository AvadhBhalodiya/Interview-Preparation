import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion, useReducedMotion, type Variants } from 'motion/react'
import { LuArrowRight, LuShuffle, LuBookOpen } from 'react-icons/lu'
import { getSections, getAllNotes } from '../lib/content'
import { sectionIcon } from '../lib/sectionIcons'
import { useDoneNotes, useLastVisited } from '../lib/useProgress'
import { Search } from './Search'

export function Home() {
  const sections = getSections()
  const firstPath = sections[0]?.notes[0]?.path ?? '/'
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const done = useDoneNotes()
  const lastPath = useLastVisited()
  // Only offer "Continue" if the stored path still resolves — a note can be
  // renamed or removed between visits.
  const lastNote = lastPath ? getAllNotes().find((n) => n.path === lastPath) : undefined
  const totalDone = getAllNotes().reduce((n, note) => n + (done.has(note.path) ? 1 : 0), 0)

  useEffect(() => {
    document.title = 'Interview Notes'
  }, [])

  const randomTopic = () => {
    const notes = getAllNotes()
    if (notes.length) navigate(notes[Math.floor(Math.random() * notes.length)].path)
  }

  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.04 } },
  }
  const item: Variants = {
    hidden: reduce ? { opacity: 1 } : { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
  }

  return (
    <div className="relative mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
      {/* The local hero glow that used to sit here is gone: it was a
          filter: blur(100px) layer (re-rasterised on every navigation to Home)
          and it stacked full-strength accent on top of the orb field on the one
          route where that field runs at full intensity. OrbField replaces it. */}

      {/* hero — animate-gradient pans the fill; it was defined in index.css but
          never applied, so this heading has been a static gradient until now. */}
      <h1 className="text-4xl font-black leading-[1.08] tracking-tight sm:text-5xl">
        <span className="text-gradient animate-gradient">Interview Notes</span>
      </h1>

      {/* command bar */}
      <div className="mt-6">
        <Search hero />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Once you've read something, resuming beats starting over, so the
            gradient (primary) treatment moves to Continue. */}
        {lastNote ? (
          <Link
            to={lastNote.path}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg brand-gradient px-4 py-2.5 text-[14px] font-semibold text-accent-contrast shadow-sm shadow-[color:var(--glow)] transition hover:opacity-90"
          >
            <LuBookOpen className="h-4 w-4 shrink-0" />
            <span className="truncate">Continue: {lastNote.title}</span>
          </Link>
        ) : (
          <Link
            to={firstPath}
            className="inline-flex items-center gap-1.5 rounded-lg brand-gradient px-4 py-2.5 text-[14px] font-semibold text-accent-contrast shadow-sm shadow-[color:var(--glow)] transition hover:opacity-90"
          >
            Start reading <LuArrowRight className="h-4 w-4" />
          </Link>
        )}
        <button
          type="button"
          onClick={randomTopic}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-4 py-2.5 text-[14px] font-semibold text-fg transition hover:border-accent hover:text-accent"
        >
          <LuShuffle className="h-4 w-4" /> Random topic
        </button>
      </div>

      {/* every section, one compact grid */}
      <motion.div
        // grid-cols-1 is not redundant: without an explicit column the implicit
        // `auto` track sizes to max-content (306px) and overflows its own 272px
        // grid at 320px. Tailwind's grid-cols-* uses minmax(0,1fr), which clamps.
        className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {sections.map((s) => {
          const { Icon, color } = sectionIcon(s.slug)
          // Cards land on the section overview rather than diving straight into
          // note #1 — you get to see what the section covers first.
          const to = `/${s.slug}`
          const read = s.notes.reduce((n, note) => n + (done.has(note.path) ? 1 : 0), 0)
          const pct = s.notes.length ? Math.round((read / s.notes.length) * 100) : 0
          return (
            <motion.div key={s.slug} variants={item} whileHover={reduce ? undefined : { y: -4 }}>
              <Link
                to={to}
                className="group relative flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-surface p-4 transition duration-200 hover:border-accent hover:shadow-lg hover:shadow-[color:var(--glow)]"
              >
                <span className="absolute inset-x-0 top-0 h-0.5 brand-gradient opacity-0 transition group-hover:opacity-100" />
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-tint"
                  style={{ color }}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-bold text-heading">{s.label}</div>
                  <div className="font-mono text-[11px] text-secondary">
                    {read > 0
                      ? `${read}/${s.notes.length} read`
                      : `${s.notes.length} ${s.notes.length === 1 ? 'note' : 'notes'}`}
                  </div>
                </div>
                <LuArrowRight className="ml-auto h-4 w-4 shrink-0 text-muted transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
                {/* Progress rail along the card's bottom edge; absent until you
                    actually start a section, so an untouched grid stays calm. */}
                {read > 0 && (
                  <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-hover">
                    <span
                      className="block h-full rounded-r-full bg-[var(--success)] transition-[width] duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                )}
              </Link>
            </motion.div>
          )
        })}
      </motion.div>

      {/* justify-between rather than ml-auto on the last item: once this row
          wraps, ml-auto strands the progress line right-aligned on its own row
          under left-aligned hints. */}
      <div className="mt-12 flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-border pt-6 font-mono text-[12.5px] text-secondary">
        {/* Hidden on touch: these advertise keyboard interactions a phone user
            cannot perform, and the keycaps are pure noise there. */}
        <div className="hidden flex-wrap items-center gap-x-2 gap-y-2 [@media(pointer:fine)]:flex">
          <span className="inline-flex items-center gap-1.5">
            Press <kbd className="cmd-hint">/</kbd> to search
          </span>
          <span className="text-muted">·</span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="cmd-hint">↑</kbd>
            <kbd className="cmd-hint">↓</kbd> to move
          </span>
          <span className="text-muted">·</span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="cmd-hint">↵</kbd> to open
          </span>
        </div>
        <span className="text-muted">
          {totalDone > 0
            ? `${totalDone} of ${getAllNotes().length} notes read`
            : 'Reviewed against latest versions · updated July 2026'}
        </span>
      </div>
    </div>
  )
}
