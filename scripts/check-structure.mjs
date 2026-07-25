// Enforces the house note format across src/content.
//
// Every note is byte-consistent by design: the renderer themes headings by their
// exact text, the TOC is built from them, and the search index extracts the `>`
// summary. A note that drifts doesn't error — it just renders slightly wrong and
// nobody notices. This is the check that notices. Run: pnpm check:structure

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = path.join(ROOT, 'src', 'content')

const HEADINGS = [
  '## What it is',
  '## Key points',
  '## Example',
  '## Interview Q&A',
  '## Gotchas',
  '## Revise next',
]

// Emoji + pictographic ranges. The site deliberately uses icon components
// instead, so any emoji in content is a regression.
//
// Deliberately EXCLUDES the arrow blocks (U+2190–21FF, U+2B00–2BFF): the notes
// use "→" 29 times as typography inside comparison tables, and that is not an
// emoji. Flagging it would train you to ignore this check.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

// Fenced code blocks are stripped before structural checks: a Python comment
// like "# CPU-bound work" is not a markdown H1, and a "## " inside a bash
// heredoc is not a section heading.
const stripFences = (s) => s.replace(/^```[\s\S]*?^```/gm, '')

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(f))
    else if (e.name.endsWith('.md') && !e.name.startsWith('_')) out.push(f)
  }
  return out
}

const files = walk(CONTENT)
const problems = []
const add = (f, msg) => problems.push(`${path.relative(ROOT, f)}: ${msg}`)

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')

  // --- frontmatter: exactly title, group, order ---
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!fm) {
    add(file, 'missing frontmatter block')
  } else {
    const keys = fm[1]
      .split('\n')
      .map((l) => l.split(':')[0].trim())
      .filter(Boolean)
    if (keys.join(',') !== 'title,group,order') {
      add(file, `frontmatter keys are [${keys.join(', ')}], expected [title, group, order]`)
    }
    if (!/^title:\s*".*"\s*$/m.test(fm[1])) add(file, 'title must be a quoted string')
    if (!/^group:\s*".*"\s*$/m.test(fm[1])) add(file, 'group must be a quoted string')
    if (!/^order:\s*\d+\s*$/m.test(fm[1])) add(file, 'order must be an unquoted number')
  }

  const body = stripFences(fm ? src.slice(fm[0].length) : src)
  const bodyLines = body.split('\n')

  // --- exactly one H1 ---
  const h1s = bodyLines.filter((l) => /^# /.test(l))
  if (h1s.length !== 1) add(file, `expected exactly 1 H1, found ${h1s.length}`)

  // --- a `>` summary before the first `##` ---
  const firstH2 = bodyLines.findIndex((l) => l.startsWith('## '))
  const head = bodyLines.slice(0, firstH2 === -1 ? bodyLines.length : firstH2)
  if (!head.some((l) => /^>\s+\S/.test(l) && !/^>\s*\[!/.test(l))) {
    add(file, 'missing the leading "> " one-line summary')
  }

  // --- the six headings, verbatim and in order ---
  const found = bodyLines.filter((l) => l.startsWith('## ')).map((l) => l.trim())
  const missing = HEADINGS.filter((h) => !found.includes(h))
  if (missing.length) add(file, `missing heading(s): ${missing.join(', ')}`)
  const ordered = found.filter((h) => HEADINGS.includes(h))
  if (ordered.join('|') !== HEADINGS.filter((h) => found.includes(h)).join('|')) {
    add(file, `house headings out of order: ${ordered.join(' -> ')}`)
  }
  const extra = found.filter((h) => !HEADINGS.includes(h))
  if (extra.length) add(file, `unexpected h2(s): ${extra.join(', ')}`)

  // --- footer ---
  const last = bodyLines.filter((l) => l.trim()).pop() ?? ''
  if (!/^\*Reviewed against .+\.\*$/.test(last.trim())) {
    add(file, `last line is not a *Reviewed against ...* footer (got: ${last.trim().slice(0, 60)})`)
  }

  // --- no emojis ---
  lines.forEach((l, i) => {
    if (EMOJI.test(l)) add(file, `emoji on line ${i + 1}: ${l.trim().slice(0, 60)}`)
  })
}

// --- group names must be registered, and unique per section ---
//
// groupIcon() silently falls back to a generic hash icon for an unregistered
// name, so a typo or a near-duplicate ("Auth & Access" alongside an existing
// "Access & Data Protection") splits a section into an extra group with the
// wrong icon and nothing errors. That is exactly how it slipped through once.
const iconsSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'groupIcons.tsx'), 'utf8')
// Keys are quoted only when they need to be — `OOP: LuBoxes` and
// `'Access & Data Protection': LuLockKeyhole` are both valid, so match both.
const registered = new Set(
  [...iconsSrc.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*Lu/gm)].map((m) => m[1] ?? m[2])
)

const bySection = new Map()
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!fm) continue
  const group = /^group:\s*"(.*)"\s*$/m.exec(fm[1])?.[1]
  const order = Number(/^order:\s*(\d+)\s*$/m.exec(fm[1])?.[1])
  const section = path.relative(CONTENT, file).split(path.sep)[0]
  if (!bySection.has(section)) bySection.set(section, [])
  bySection.get(section).push({ file, group, order })
}

for (const [section, notes] of bySection) {
  for (const g of new Set(notes.map((n) => n.group))) {
    if (g && !registered.has(g)) {
      problems.push(
        `src/content/${section}: group "${g}" has no entry in src/lib/groupIcons.tsx — ` +
          `it will render with the generic fallback icon`
      )
    }
  }
  // Duplicate order within a section makes sidebar ordering depend on a title
  // tiebreak, which silently reshuffles when a note is renamed.
  const seen = new Map()
  for (const n of notes) {
    if (seen.has(n.order)) {
      problems.push(
        `src/content/${section}: order ${n.order} used by both ` +
          `${path.basename(seen.get(n.order))} and ${path.basename(n.file)}`
      )
    }
    seen.set(n.order, n.file)
  }
}

console.log(`Checked ${files.length} notes.`)
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):\n`)
  problems.forEach((p) => console.log('  ' + p))
  process.exit(1)
}
console.log('Every note matches the house format.')
