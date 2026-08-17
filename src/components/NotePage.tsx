import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { LuCheck, LuCircle } from 'react-icons/lu'
import { getNote, getPrevNext, loadNoteBody } from '../lib/content'
import { markVisited, toggleDone, useDoneNotes } from '../lib/useProgress'
import { extractToc } from '../lib/toc'
import { sectionMeta } from '../lib/sections'
import { sectionIcon } from '../lib/sectionIcons'
import { Markdown } from './Markdown'
import { TableOfContents } from './TableOfContents'
import { Breadcrumbs } from './Breadcrumbs'
import { PrevNext } from './PrevNext'
import { NotFound } from './NotFound'

export default function NotePage() {
  const { section = '', slug = '' } = useParams()
  const note = getNote(section, slug)
  const { prev, next } = getPrevNext(section, slug)
  const reduce = useReducedMotion()
  const [body, setBody] = useState<string | null>(null)

  // Metadata (breadcrumbs/title) shows instantly; the markdown body is its own
  // lazy chunk fetched here.
  useEffect(() => {
    setBody(null)
    let alive = true
    const p = loadNoteBody(section, slug)
    if (p) p.then((b) => alive && setBody(b))
    else setBody('')
    return () => {
      alive = false
    }
  }, [section, slug])

  const toc = useMemo(() => (body ? extractToc(body) : []), [body])

  useEffect(() => {
    if (note) {
      document.title = `${note.title} · ${sectionMeta(note.section).label} · Interview Notes`
      window.scrollTo(0, 0)
      // Powers "Continue reading" on the home page.
      markVisited(note.path)
    }
  }, [note])

  if (!note) return <NotFound />

  return (
    // The table of contents only appears at xl, so below that the container
    // narrows by exactly the space the TOC would have taken. Sized so the 68ch
    // prose cap stays the binding constraint at both breakpoints — narrower and
    // the container clips the measure instead (max-w-3xl gave ~51 characters).
    <div className="mx-auto flex max-w-4xl items-start gap-8 px-4 py-8 sm:px-6 lg:py-10 xl:max-w-6xl">
      <article className="min-w-0 flex-1">
        {/* The bottom margin lives on the ROW, not on Breadcrumbs: the button is
            the taller child, so a margin on the shorter one left the button's
            border flush against the card below it. items-center puts the button
            label on the breadcrumb baseline instead of ~7px under it. */}
        <div className="mb-3 flex items-center gap-3">
          <Breadcrumbs note={note} />
          <DoneToggle path={note.path} />
        </div>
        <motion.div
          // Full-bleed on phones: the container padding plus the card's own
          // padding and side borders cost 64px of a 375px screen, which held the
          // measure to ~31 characters. Breaking out horizontally (keeping the
          // container padding for the breadcrumb row above) buys back ~5
          // characters per line. Card treatment returns from sm up.
          className="note-card -mx-4 rounded-none border-x-0 border-y border-border bg-surface p-4 sm:mx-0 sm:rounded-2xl sm:border sm:p-6 md:p-8"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut', delay: 0.03 }}
        >
          <div
            // prose-lg is a flat 18px at every width, which on a phone left a
            // ~26-31 character measure. Stepping up only from sm keeps the
            // desktop reading experience identical.
            className="prose sm:prose-lg"
            style={{ '--bold-color': sectionIcon(note.section).color } as CSSProperties}
          >
            {body === null ? (
              <BodySkeleton />
            ) : (
              <Markdown body={body} section={note.section} title={note.slug} />
            )}
          </div>
          <PrevNext prev={prev} next={next} />
        </motion.div>
      </article>
      <TableOfContents items={toc} />
    </div>
  )
}

function DoneToggle({ path }: { path: string }) {
  const done = useDoneNotes().has(path)
  return (
    <button
      type="button"
      onClick={() => toggleDone(path)}
      aria-pressed={done}
      title={done ? 'Marked as done - click to undo' : 'Mark this note as done'}
      // bg-surface so it reads as a button rather than a hollow outline floating
      // on the canvas, matching every other secondary button in the app. Both
      // states get a hover: the done state previously had none at all, which
      // made a control whose tooltip says "click to undo" feel inert.
      className={`tap-target-inline ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-semibold transition duration-200 active:scale-[0.97] ${
        done
          ? 'border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,var(--surface))] text-[var(--success)] hover:bg-[color-mix(in_srgb,var(--success)_18%,var(--surface))]'
          : 'border-border bg-surface text-secondary hover:border-accent hover:text-accent'
      }`}
    >
      <span className="relative grid h-3.5 w-3.5 place-items-center">
        {/* Both icons stay mounted and cross-fade, so the label never shifts
            horizontally as the glyph swaps. */}
        <LuCircle
          className={`absolute h-3.5 w-3.5 transition-opacity duration-200 ${done ? 'opacity-0' : 'opacity-100'}`}
        />
        <LuCheck
          className={`absolute h-3.5 w-3.5 transition-opacity duration-200 ${done ? 'opacity-100' : 'opacity-0'}`}
        />
      </span>
      {done ? 'Done' : 'Mark done'}
    </button>
  )
}

function BodySkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden>
      <div className="h-8 w-2/3 rounded bg-surface-hover" />
      <div className="mt-6 h-4 w-full rounded bg-surface-hover" />
      <div className="h-4 w-11/12 rounded bg-surface-hover" />
      <div className="h-4 w-4/5 rounded bg-surface-hover" />
    </div>
  )
}
