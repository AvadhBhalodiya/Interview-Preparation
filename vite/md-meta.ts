import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

// Exposes two virtual modules, both scanned from disk at build/dev:
//
//   virtual:content-index — eager, tiny. Every note's metadata
//     (section/slug/title/group/order/oneLine). Home/Sidebar/Search import this
//     instead of the full markdown, so bodies never enter the entry bundle.
//
//   virtual:search-index — lazy, large. The same notes plus each body reduced to
//     plain text, for full-text search. Kept as a SEPARATE module precisely so it
//     stays out of the eager path: Search dynamic-imports it on the first
//     keystroke, so a visitor who never searches never downloads it.
//
// HMR: editing/adding/removing a .md file invalidates both + reloads.

const VIRTUAL_ID = 'virtual:content-index'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const SEARCH_ID = 'virtual:search-index'
const RESOLVED_SEARCH_ID = '\0' + SEARCH_ID

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const ONE_LINE = /^>\s*(?:⚡\s*)?(?:In one line:)?\s*(.+)$/m

// Markdown -> searchable plain text. Code fence *contents* are deliberately
// kept: "select_related" or "prefetch_related" often only appear in examples,
// and those are exactly the terms worth searching for. Only the syntax is
// dropped, so a query never has to match punctuation the reader can't see.
function toPlainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Mermaid is the one fence whose BODY is dropped, unlike the rule below.
    // Diagram source is syntax, not prose: keeping it put ~7,800 lines of
    // `flowchart LR` / `A --> B` into the haystack, so searching "graph" or
    // "end" matched a hundred notes on markup the reader never sees.
    .replace(/```mermaid\b[\s\S]*?```/g, ' ')
    .replace(/```[a-zA-Z0-9+-]*\n?/g, ' ') // fence markers + language label
    .replace(/^>\s*\[![^\]]*\]\s*/gm, ' ') // callout tags: > [!TIP]
    .replace(/^>\s?/gm, ' ') // blockquote markers
    .replace(/^#{1,6}\s+/gm, ' ') // heading hashes
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/^\|[-:\s|]+\|\s*$/gm, ' ') // table separator rows
    .replace(/\|/g, ' ') // remaining table pipes
    .replace(/^\s*[-*+]\s+/gm, ' ') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, ' ') // ordered-list markers
    .replace(/[`*_~]/g, '') // emphasis + inline-code marks
    .replace(/\s+/g, ' ')
    .trim()
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

export function contentIndex(): Plugin {
  let contentDir = ''
  return {
    name: 'content-index',
    configResolved(cfg) {
      contentDir = path.join(cfg.root, 'src', 'content')
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      if (id === SEARCH_ID) return RESOLVED_SEARCH_ID
    },
    load(id) {
      if (id !== RESOLVED_ID && id !== RESOLVED_SEARCH_ID) return null
      const items = walk(contentDir)
        .map((file) => {
          const rel = path.relative(contentDir, file).split(path.sep)
          const section = rel[0]
          const slug = rel[rel.length - 1].replace(/\.md$/, '')
          if (slug.startsWith('_')) return null
          const src = fs.readFileSync(file, 'utf8')
          const fm = FRONTMATTER.exec(src)
          const data = ((fm ? yaml.load(fm[1]) : null) as Record<string, unknown> | null) ?? {}
          const body = fm ? src.slice(fm[0].length) : src
          const m = ONE_LINE.exec(body)
          const oneLine = m ? m[1].replace(/`/g, '').replace(/\*\*?/g, '').trim() : ''
          return {
            section,
            slug,
            title: typeof data.title === 'string' ? data.title : slug,
            group: typeof data.group === 'string' ? data.group : 'General',
            order: typeof data.order === 'number' ? data.order : 999,
            oneLine,
            body,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)

      if (id === RESOLVED_SEARCH_ID) {
        // Only what the matcher needs: identity + haystack.
        const search = items.map((n) => ({
          section: n.section,
          slug: n.slug,
          title: n.title,
          text: toPlainText(n.body),
        }))
        return `export default ${JSON.stringify(search)}`
      }
      // Metadata module: strip the body so it can't leak into the eager bundle.
      const meta = items.map(({ body: _body, ...rest }) => rest)
      return `export default ${JSON.stringify(meta)}`
    },
    configureServer(server) {
      const onChange = (file: string) => {
        if (!file.endsWith('.md') || !file.startsWith(contentDir)) return
        for (const resolved of [RESOLVED_ID, RESOLVED_SEARCH_ID]) {
          const mod = server.moduleGraph.getModuleById(resolved)
          if (mod) server.moduleGraph.invalidateModule(mod)
        }
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', onChange)
      server.watcher.on('unlink', onChange)
      server.watcher.on('change', onChange)
    },
  }
}
