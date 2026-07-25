// Rewrites GitHub-style alert blockquotes into callout <div>s so they render as
// themed panels instead of plain quotes:
//
//   > [!TIP] Prefer field(default_factory=list).
//   > [!WARN]
//   > The trap, spelled out on the next line.
//
// The leading [!TYPE] marker is stripped and the blockquote is retargeted to a
// <div class="callout callout-<type>"> via the mdast→hast hName/hProperties
// escape hatch (respected by react-markdown). No external deps - just a small
// recursive walk over the tree. A blockquote without a marker (e.g. the note's
// leading thesis) is left untouched as a real <blockquote>.

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const MARKER = /^\[!(\w+)\]\s*/
const KNOWN = new Set([
  'note',
  'info',
  'tip',
  'warn',
  'warning',
  'gotcha',
  'key',
  'important',
  'danger',
])

export function remarkCallouts() {
  return (tree: MdNode): void => walk(tree)
}

function walk(node: MdNode): void {
  if (!node.children) return
  for (const child of node.children) {
    if (child.type === 'blockquote') tag(child)
    walk(child)
  }
}

function tag(bq: MdNode): void {
  const para = bq.children?.find((c) => c.type === 'paragraph')
  const first = para?.children?.[0]
  if (!para || !first || first.type !== 'text' || first.value == null) return
  const m = MARKER.exec(first.value)
  if (!m) return
  const type = m[1].toLowerCase()
  if (!KNOWN.has(type)) return

  // Strip the "[!TYPE]" token; drop the text node entirely if nothing remains.
  first.value = first.value.slice(m[0].length)
  if (first.value === '') para.children!.shift()

  bq.data = bq.data ?? {}
  bq.data.hName = 'div'
  bq.data.hProperties = { className: ['callout', `callout-${type}`] }
}
