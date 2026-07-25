import { Link } from 'react-router-dom'
import { LuChevronRight } from 'react-icons/lu'
import { sectionMeta } from '../lib/sections'
import { sectionIcon } from '../lib/sectionIcons'
import type { Note } from '../lib/types'

export function Breadcrumbs({ note }: { note: Note }) {
  const meta = sectionMeta(note.section)
  const { Icon: SecIcon, color: secColor } = sectionIcon(note.section)
  // Deliberately no bottom margin: the row that composes this with the
  // done-toggle owns that spacing, because the button is the taller child.
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-secondary">
      <Link to="/" className="transition hover:text-accent">
        Home
      </Link>
      <LuChevronRight className="h-3.5 w-3.5 opacity-60" />
      <Link
        to={`/${note.section}`}
        className="inline-flex items-center gap-1.5 transition hover:text-accent"
      >
        <SecIcon className="h-3.5 w-3.5" style={{ color: secColor }} /> {meta.label}
      </Link>
      <LuChevronRight className="h-3.5 w-3.5 opacity-60" />
      <span className="text-fg/80">{note.group}</span>
    </div>
  )
}
