export interface Note {
  section: string // folder slug, e.g. "python"
  slug: string // file slug, e.g. "args-kwargs"
  title: string // frontmatter title (sidebar label + tab title)
  group: string // frontmatter group (clusters notes inside a section)
  order: number // frontmatter order (sort within the section)
  oneLine: string // extracted from the leading one-sentence summary callout
  path: string // route path, e.g. "/python/args-kwargs"
}

export interface Group {
  name: string
  notes: Note[]
}

export interface Section {
  slug: string
  label: string
  icon: string
  order: number
  groups: Group[]
  notes: Note[] // flat + ordered (used for prev/next and search)
}
