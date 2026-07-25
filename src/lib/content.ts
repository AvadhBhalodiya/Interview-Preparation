import contentMeta from 'virtual:content-index'
import { sectionMeta } from './sections'
import type { Group, Note, Section } from './types'

// Note metadata is eager (tiny - title/group/order/oneLine only) via the
// `virtual:content-index` module (see vite/md-meta.ts). Full bodies are lazy:
// each is its own chunk fetched on demand from NotePage. Dropping a `.md` file
// anywhere under src/content/<section>/ still makes it appear automatically.
const bodies = import.meta.glob('../content/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

function buildNotes(): Note[] {
  return contentMeta.map((m) => ({
    section: m.section,
    slug: m.slug,
    title: m.title || m.slug,
    group: m.group || 'General',
    order: typeof m.order === 'number' ? m.order : 999,
    oneLine: m.oneLine,
    path: `/${m.section}/${m.slug}`,
  }))
}

const allNotes = buildNotes()

let sectionsCache: Section[] | null = null

export function getSections(): Section[] {
  if (sectionsCache) return sectionsCache
  const bySection = new Map<string, Note[]>()
  for (const n of allNotes) {
    const list = bySection.get(n.section) ?? []
    list.push(n)
    bySection.set(n.section, list)
  }

  const sections: Section[] = []
  for (const [slug, notes] of bySection) {
    notes.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    // Group, preserving order: since notes are pre-sorted, groups appear in
    // the order their first note does.
    const groupMap = new Map<string, Note[]>()
    for (const n of notes) {
      const g = groupMap.get(n.group) ?? []
      g.push(n)
      groupMap.set(n.group, g)
    }
    const groups: Group[] = [...groupMap.entries()].map(([name, ns]) => ({ name, notes: ns }))
    const meta = sectionMeta(slug)
    sections.push({ slug, label: meta.label, icon: meta.icon, order: meta.order, groups, notes })
  }

  sections.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  sectionsCache = sections
  return sections
}

export function getNote(section: string, slug: string): Note | undefined {
  return allNotes.find((n) => n.section === section && n.slug === slug)
}

export function getAllNotes(): Note[] {
  return allNotes
}

// Strip the leading YAML frontmatter block so it isn't rendered as body text
// (same pattern the build-time indexer uses - see vite/md-meta.ts).
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

// Lazily fetch a note's markdown body (its own chunk), with frontmatter stripped.
// Returns undefined if the note doesn't exist.
export function loadNoteBody(section: string, slug: string): Promise<string> | undefined {
  const suffix = `/content/${section}/${slug}.md`
  const key = Object.keys(bodies).find((f) => f.endsWith(suffix))
  return key ? bodies[key]().then((raw) => raw.replace(FRONTMATTER, '')) : undefined
}

/**
 * Resolve a markdown link between notes to a route, or null if it points at a
 * note that doesn't exist.
 *
 * Handles the three shapes that appear in the content:
 *   queryset-orm.md            -> same section as the page doing the linking
 *   databases/indexing.md      -> another section
 *   ../security/jwt.md         -> another section, written relatively
 *
 * Returning null (rather than a guessed route) lets the renderer degrade to
 * plain text instead of shipping a link that dead-ends on the 404 page.
 */
export function resolveNoteHref(href: string, fromSection: string): string | null {
  const parts = href
    .replace(/[?#].*$/, '')
    .replace(/\.md$/i, '')
    .split('/')
    .filter((p) => p && p !== '.')

  const stack: string[] = []
  for (const p of parts) {
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  if (!stack.length) return null

  const slug = stack[stack.length - 1]
  const section = stack.length > 1 ? stack[stack.length - 2] : fromSection
  return getNote(section, slug) ? `/${section}/${slug}` : null
}

export function getPrevNext(section: string, slug: string): { prev?: Note; next?: Note } {
  const sec = getSections().find((s) => s.slug === section)
  if (!sec) return {}
  const i = sec.notes.findIndex((n) => n.slug === slug)
  if (i === -1) return {}
  return { prev: sec.notes[i - 1], next: sec.notes[i + 1] }
}
