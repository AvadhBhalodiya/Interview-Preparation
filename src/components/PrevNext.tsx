import { Link } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { LuArrowLeft, LuArrowRight } from 'react-icons/lu'
import type { Note } from '../lib/types'

export function PrevNext({ prev, next }: { prev?: Note; next?: Note }) {
  const reduce = useReducedMotion()
  // Matches the card lift used on Home and the section overviews.
  const lift = reduce ? undefined : { y: -2 }
  if (!prev && !next) return null
  return (
    <nav
      className="mt-12 grid gap-4 border-t border-border pt-6 sm:grid-cols-2"
      aria-label="Previous and next note"
    >
      {prev ? (
        <motion.div whileHover={lift}>
          <Link
            to={prev.path}
            className="flex flex-col rounded-xl border border-border p-4 transition duration-200 hover:border-accent hover:bg-accent-tint"
          >
            <span className="flex items-center gap-1 text-[12.5px] text-secondary">
              <LuArrowLeft className="h-3.5 w-3.5" /> Previous
            </span>
            <span className="mt-1 font-semibold text-heading">{prev.title}</span>
          </Link>
        </motion.div>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next ? (
        <motion.div whileHover={lift}>
          <Link
            to={next.path}
            className="flex flex-col items-end rounded-xl border border-border p-4 text-right transition hover:border-accent hover:bg-accent-tint"
          >
            <span className="flex items-center gap-1 text-[12.5px] text-secondary">
              Next <LuArrowRight className="h-3.5 w-3.5" />
            </span>
            <span className="mt-1 font-semibold text-heading">{next.title}</span>
          </Link>
        </motion.div>
      ) : (
        <span className="hidden sm:block" />
      )}
    </nav>
  )
}
