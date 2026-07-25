import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { LuSearch } from 'react-icons/lu'
import { getAllNotes } from '../lib/content'
import type { Note } from '../lib/types'

interface NoteText {
  section: string
  slug: string
  title: string
  text: string
}

interface Snippet {
  before: string
  match: string
  after: string
}

interface Hit {
  note: Note
  /** 0 = title, 1 = summary/group/section, 2 = body only. Lower sorts first. */
  score: number
  snippet: Snippet | null
}

const MAX_RESULTS = 8
const SNIPPET_CHARS = 110

// Cached across mounts (the header and hero boxes are separate components) so
// the index downloads at most once per session.
let searchIndex: NoteText[] | null = null
let indexPromise: Promise<NoteText[]> | null = null

function loadSearchIndex(): Promise<NoteText[]> {
  if (!indexPromise) {
    indexPromise = import('virtual:search-index').then((m) => {
      searchIndex = m.default
      return m.default
    })
  }
  return indexPromise
}

// A window of body text around the match, with the matched run split out so it
// can be emphasised. Ellipses only where text was actually cut.
function buildSnippet(text: string, at: number, len: number): Snippet {
  const start = Math.max(0, at - Math.floor((SNIPPET_CHARS - len) / 2))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + len),
    after: text.slice(at + len, end) + (end < text.length ? '…' : ''),
  }
}

// Shared search box. `hero` renders the larger command-bar variant used on the
// home page (wider, taller, mono placeholder, a "/" keycap) and lets you press
// "/" anywhere to jump to it. The default (top-bar) variant is unchanged.
export function Search({ hero = false }: { hero?: boolean }) {
  const notes = useMemo(() => getAllNotes(), [])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [index, setIndex] = useState<NoteText[] | null>(searchIndex)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const reduce = useReducedMotion()

  // Fetch the body index on the first keystroke, never on mount — a visitor who
  // only browses shouldn't pay for it. Metadata matches render immediately
  // meanwhile, so the box is useful before the index lands.
  useEffect(() => {
    if (!q.trim() || index) return
    let alive = true
    loadSearchIndex().then((idx) => alive && setIndex(idx))
    return () => {
      alive = false
    }
  }, [q, index])

  const results = useMemo<Hit[]>(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    const hits = new Map<string, Hit>()

    // Pass 1 — metadata. Always available, so results appear instantly.
    for (const n of notes) {
      const inTitle = n.title.toLowerCase().includes(term)
      const inMeta = `${n.oneLine} ${n.group} ${n.section}`.toLowerCase().includes(term)
      if (inTitle || inMeta) hits.set(n.path, { note: n, score: inTitle ? 0 : 1, snippet: null })
    }

    // Pass 2 — bodies. Adds notes that mention the term only in their prose, and
    // gives every hit a snippet showing the term in context.
    if (index) {
      for (const entry of index) {
        const at = entry.text.toLowerCase().indexOf(term)
        if (at === -1) continue
        const path = `/${entry.section}/${entry.slug}`
        const snippet = buildSnippet(entry.text, at, term.length)
        const existing = hits.get(path)
        if (existing) {
          existing.snippet = snippet
          continue
        }
        const note = notes.find((n) => n.path === path)
        if (note) hits.set(path, { note, score: 2, snippet })
      }
    }

    return [...hits.values()]
      .sort((a, b) => a.score - b.score || a.note.title.localeCompare(b.note.title))
      .slice(0, MAX_RESULTS)
  }, [q, notes, index])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Hero variant only: press "/" anywhere (unless already typing) to focus.
  useEffect(() => {
    if (!hero) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hero])

  useEffect(() => setActive(0), [q])

  const go = (i: number) => {
    const r = results[i]
    if (!r) return
    navigate(r.note.path)
    setQ('')
    setOpen(false)
  }

  return (
    <div className={`relative ${hero ? 'w-full max-w-xl' : 'w-[min(340px,44vw)]'}`} ref={boxRef}>
      <LuSearch
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-secondary ${
          hero ? 'left-4 h-5 w-5' : 'left-3 h-4 w-4'
        }`}
      />
      <input
        ref={inputRef}
        type="search"
        placeholder={hero ? 'Search topics - try “GIL” or “indexing”' : 'Search notes…'}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            go(active)
          } else if (e.key === 'Escape') {
            setOpen(false)
            inputRef.current?.blur()
          }
        }}
        aria-label="Search notes"
        className={
          hero
            ? 'h-12 w-full rounded-xl border border-border bg-surface-hover pl-12 pr-14 text-base text-fg placeholder:font-mono placeholder:text-[13px] placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30'
            : 'h-9 w-full rounded-lg border border-border bg-surface-hover pl-9 pr-3 text-[14px] text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30'
        }
      />
      {hero && (
        <kbd className="cmd-hint pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">/</kbd>
      )}
      <AnimatePresence>
        {open && q.trim() !== '' && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: reduce ? 0 : 0.15 }}
            className={`absolute left-0 right-0 z-50 max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 [box-shadow:var(--dropdown-shadow)] ${
              hero ? 'top-14' : 'top-11'
            }`}
          >
            {results.length === 0 ? (
              <div className="px-3 py-3 text-[14px] text-secondary">
                {index ? `No matches for “${q}”.` : 'Searching…'}
              </div>
            ) : (
              results.map((r, i) => (
                <button
                  key={r.note.path}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(i)}
                  className={`block w-full rounded-lg px-3 py-2 text-left transition ${
                    i === active ? 'bg-accent-tint' : 'hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[14px] font-semibold text-heading">{r.note.title}</span>
                    <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-muted">
                      {r.note.section}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[12.5px] text-secondary">
                    {r.snippet ? (
                      <>
                        {r.snippet.before}
                        <span className="font-semibold text-accent">{r.snippet.match}</span>
                        {r.snippet.after}
                      </>
                    ) : (
                      r.note.oneLine || r.note.group
                    )}
                  </div>
                </button>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
