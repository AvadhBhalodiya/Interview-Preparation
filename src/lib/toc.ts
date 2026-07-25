export interface TocItem {
  text: string // display text (keeps the emoji marker)
  id: string // heading id (matches what the Markdown renderer sets)
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

// Build the "on this page" list from the `##` section headers.
export function extractToc(body: string): TocItem[] {
  const items: TocItem[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      const text = m[1].replace(/`/g, '').replace(/\*\*?/g, '').trim()
      items.push({ text, id: slugify(m[1]) })
    }
  }
  return items
}
