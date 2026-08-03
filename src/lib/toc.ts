export interface TocNode {
  text: string // display text, e.g. "3.1 A container has a lifecycle"
  id: string // heading id (matches what the Markdown renderer sets)
  children: TocNode[] // subsections; empty for a leaf
}

// Deterministic slug used BOTH here and by the Markdown heading renderer, so
// TOC links always resolve to the right heading (no dependency on a library's
// internal slugging). Emoji and punctuation are dropped → clean ascii ids.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[*_]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Notes carry their own numbering in the heading TEXT ("# 3. Docker Container",
// "## 3.1 A container has a lifecycle"), but the markdown level that holds a
// main section is not consistent across the library: h1 in most notes, h2 in
// seven, and a handful mix h1 with h3/h4. Keying the tree off the `#` count
// would therefore split the same logical level across depths — so depth comes
// from the number prefix instead, which holds for every note.
const MAIN = /^\d+\.(?:\s|$)/ // "3. Docker Container"
const SUB = /^\d+\.\d+/ // "3.1 …" and "3.1.2 …", both rendered one level in

// Build the "on this page" tree. Headings with no number prefix — the note
// title, and section-local labels like "Example" / "Advantages" / "References"
// — are deliberately left out: they add ~28 rows to a median note without
// telling you where you are in it.
export function extractToc(body: string): TocNode[] {
  const roots: TocNode[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const text = m[1].replace(/`/g, '').replace(/\*\*?/g, '').trim()
    if (SUB.test(text)) {
      const node: TocNode = { text, id: slugify(m[1]), children: [] }
      // Hang the subsection off the most recent main section. One that appears
      // before any main section is promoted rather than silently dropped.
      const parent = roots[roots.length - 1]
      if (parent) parent.children.push(node)
      else roots.push(node)
    } else if (MAIN.test(text)) {
      roots.push({ text, id: slugify(m[1]), children: [] })
    }
  }
  return roots
}

// Depth-first id order — what the scroll observer watches, and what maps an
// active subsection back to the section that owns it.
export function flattenToc(nodes: TocNode[]): TocNode[] {
  return nodes.flatMap((n) => [n, ...n.children])
}
