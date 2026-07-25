declare module 'virtual:content-index' {
  interface NoteMeta {
    section: string
    slug: string
    title: string
    group: string
    order: number
    oneLine: string
  }
  const items: NoteMeta[]
  export default items
}

declare module 'virtual:search-index' {
  interface NoteText {
    section: string
    slug: string
    title: string
    /** The note body reduced to plain text (markdown syntax stripped). */
    text: string
  }
  const items: NoteText[]
  export default items
}
