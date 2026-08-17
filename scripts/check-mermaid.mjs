// Parses every ```mermaid fence in src/content through mermaid itself, both as
// written and as the renderer will actually feed it (i.e. after the classifier
// has injected classDef/class lines).
//
// Worth running even though nothing here changes at build time: the 712 blocks
// in the notes went years without ever being parsed — they rendered as plain
// text — so "it was already in the file" is no evidence that it is valid. This
// is also the guard for converting ASCII diagrams into mermaid, where a stray
// bracket in a label is the easiest mistake to make.
//
// Needs a DOM: mermaid.parse() reaches for document and DOMPurify. jsdom is a
// devDependency for exactly this.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { transformWithEsbuild } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Optional path argument scopes the check to one section, so parallel workers
// can validate their own slice instead of each re-parsing the whole tree:
//   node scripts/check-mermaid.mjs src/content/python
const CONTENT = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : path.join(ROOT, 'src', 'content')

// --- DOM shims, installed before mermaid is imported -------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.navigator = dom.window.navigator
globalThis.Element = dom.window.Element
globalThis.SVGElement = dom.window.SVGElement
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.DOMParser = dom.window.DOMParser
globalThis.Node = dom.window.Node
globalThis.getComputedStyle = dom.window.getComputedStyle
if (!dom.window.SVGElement.prototype.getBBox) {
  dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 40 })
}

// The classifier is TypeScript; transpile it in memory rather than duplicating
// its logic here, so this checks the code that actually ships. A plain
// transform is enough because mermaidRoles.ts has no runtime imports — keep it
// that way, or this needs a real bundle step.
const rolesPath = path.join(ROOT, 'src', 'lib', 'mermaidRoles.ts')
const { code } = await transformWithEsbuild(fs.readFileSync(rolesPath, 'utf8'), rolesPath, {
  loader: 'ts',
  format: 'esm',
})
const { decorate } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)

const mermaid = (await import('mermaid')).default
mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict' })

// A stand-in palette: the check is about syntax, not colour, but decorate()
// needs concrete values to write into the classDef lines.
const ROLE_NAMES = [
  'client', 'edge', 'service', 'store', 'cache',
  'queue', 'external', 'decision', 'ok', 'error', 'neutral',
]
const palette = Object.fromEntries(
  ROLE_NAMES.map((r) => [r, { fill: '#475569', stroke: '#1e293b', text: '#ffffff' }]),
)

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : full.endsWith('.md') ? [full] : []
  })

const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)^```/gm

let blocks = 0
let decorated = 0
const failures = []

for (const file of walk(CONTENT)) {
  const src = fs.readFileSync(file, 'utf8')
  // Line number of each fence, for an actionable failure message.
  const lines = src.split('\n')
  let m
  FENCE.lastIndex = 0
  while ((m = FENCE.exec(src))) {
    blocks++
    const line = src.slice(0, m.index).split('\n').length
    const raw = m[1]
    const where = `${path.relative(ROOT, file)}:${line}`

    for (const [label, text] of [
      ['as written', raw],
      ['after classifier', decorate(raw, palette)],
    ]) {
      if (label === 'after classifier' && text !== raw) decorated++
      try {
        await mermaid.parse(text)
      } catch (err) {
        failures.push(`${where} (${label}): ${String(err?.message ?? err).split('\n')[0]}`)
        break // one report per block is enough
      }
    }
  }
  void lines
}

console.log(
  `mermaid: ${blocks} blocks checked, ${decorated} received injected styling, ${failures.length} failed`,
)
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
