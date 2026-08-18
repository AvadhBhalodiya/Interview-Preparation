// Enforces the house note format across src/content.
//
// Every note is byte-consistent by design: the renderer themes headings by their
// exact text, the TOC is built from them, and the search index extracts the `>`
// summary. A note that drifts doesn't error — it just renders slightly wrong and
// nobody notices. This is the check that notices. Run: pnpm check:structure
//
// HISTORY: this script used to demand six fixed headings (## What it is, ## Key
// points, …). The corpus never adopted that format — 0 of 113 notes matched, 107
// had none of the six — so the check failed on every note from the first commit
// and was permanently red, which made it useless as a signal. It now enforces
// the format the notes ACTUALLY use, measured across all 113:
//
//   title H1 first          113/113
//   "> " summary            113/113
//   numbered sections       111/113  (104 at "# N.", 7 at "## N.")
//   References section      108/113  (the 5 without are all behavioral/,
//                                     which has no official docs to cite)
//
// Section heading LEVEL is deliberately not enforced. extractToc in
// src/lib/toc.ts derives depth from the number prefix, not from markdown depth
// ("depth comes from the number prefix instead, which holds for every note"), so
// "# 3." and "## 3." are equivalent to every consumer. Forcing one would be
// churn with no reader-visible effect.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = path.join(ROOT, 'src', 'content')

const REQUIRED_FM = ['title', 'group', 'order']
// Optional keys the cleanup moves out of the body blockquote, where the same
// metadata was written 113 times in 10 competing shapes.
const OPTIONAL_FM = ['category', 'level', 'updated']

// Behavioral topics cite no official documentation, so a References section is
// not expected there.
const NO_REFS_EXPECTED = new Set(['behavioral'])

// Emoji + pictographic ranges. The site deliberately uses icon components
// instead, so any emoji in content is a regression.
//
// Deliberately EXCLUDES two things that are typography, not emoji:
//   - the arrow blocks (U+2190–21FF, U+2B00–2BFF): "→" is used in comparison
//     tables and inside diagrams.
//   - the check/cross dingbats U+2713–U+2718 ("✓ ✔ ✗ ✘"): these render as plain
//     text glyphs and are used as yes/no columns inside ```text diagrams, where
//     no icon component is available. Their emoji counterparts "✅" (U+2705) and
//     "❌" (U+274C) are NOT exempt — those are true emoji and are caught.
// Flagging typography would train you to ignore this check.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{2712}\u{2719}-\u{27BF}\u{FE0F}]/u

// Fenced code blocks are stripped before structural checks: a Python comment
// like "# CPU-bound work" is not a markdown H1, and a "## " inside a bash
// heredoc is not a section heading.
const stripFences = (s) => s.replace(/^```[\s\S]*?^```/gm, '')

// A top-level section, at either heading level: "# 3. Docker Container".
const SECTION = /^#{1,2}\s+(\d+)\.(?:\s|$)/
// Any numbered heading, used for the TOC-collision check. Mirrors MAIN in
// src/lib/toc.ts.
const TOC_MAIN = /^\d+\.(?:\s|$)/

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
  const section = path.relative(CONTENT, file).split(path.sep)[0]

  // --- frontmatter ---
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!fm) {
    add(file, 'missing frontmatter block')
  } else {
    const keys = fm[1]
      .split('\n')
      .map((l) => l.split(':')[0].trim())
      .filter(Boolean)
    for (const k of REQUIRED_FM) {
      if (!keys.includes(k)) add(file, `frontmatter is missing "${k}"`)
    }
    const unknown = keys.filter((k) => !REQUIRED_FM.includes(k) && !OPTIONAL_FM.includes(k))
    if (unknown.length) {
      add(file, `unknown frontmatter key(s): ${unknown.join(', ')}`)
    }
    if (!/^title:\s*".*"\s*$/m.test(fm[1])) add(file, 'title must be a quoted string')
    if (!/^group:\s*".*"\s*$/m.test(fm[1])) add(file, 'group must be a quoted string')
    if (!/^order:\s*\d+\s*$/m.test(fm[1])) add(file, 'order must be an unquoted number')
  }

  const body = stripFences(fm ? src.slice(fm[0].length) : src)
  const bodyLines = body.split('\n')
  const headings = bodyLines.filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim())

  // --- the first heading is the note title, not a section ---
  const first = headings[0] ?? ''
  if (!/^#\s/.test(first) || SECTION.test(first)) {
    add(file, `first heading should be the note title "# Title", got: ${first.slice(0, 50) || '(none)'}`)
  }

  // --- a "> " summary before the first section ---
  const firstSection = bodyLines.findIndex((l) => SECTION.test(l))
  const head = bodyLines.slice(0, firstSection === -1 ? bodyLines.length : firstSection)
  if (!head.some((l) => /^>\s+\S/.test(l) && !/^>\s*\[!/.test(l))) {
    add(file, 'missing the leading "> " one-line summary')
  }

  // --- numbered sections ---
  const sections = headings.filter((h) => SECTION.test(h))
  if (sections.length < 3) {
    add(file, `expected at least 3 numbered sections, found ${sections.length}`)
  }

  // --- a References section (not expected for behavioral) ---
  if (!NO_REFS_EXPECTED.has(section) && !headings.some((h) => /referen/i.test(h))) {
    add(file, 'missing a References section')
  }

  // --- no emojis ---
  lines.forEach((l, i) => {
    if (EMOJI.test(l)) add(file, `emoji on line ${i + 1}: ${l.trim().slice(0, 60)}`)
  })

  // --- the two-tier "## In short" core ---
  //
  // Every note opens with a ~90-second distillation: key points, one diagram,
  // an interview answer and the classic gotcha. It is the revision path — the
  // numbered sections below it are the reference. A note without one is not
  // usable the night before an interview, which is what these notes are for.
  if (!headings.some((h) => /^##\s+In short\s*$/i.test(h))) {
    add(file, 'missing the "## In short" core')
  }

  // --- duplicate section numbers collide in the TOC ---
  //
  // extractToc keys on the number prefix, so a numbered walkthrough that
  // restarts at "1." inside a late section produces a second "1." root and the
  // sidebar shows two of everything. Use unnumbered headings for list-style
  // steps; extractToc deliberately leaves those out.
  const numbered = new Map()
  for (const h of headings) {
    const text = h.replace(/^#{1,6}\s+/, '').replace(/[`*]/g, '').trim()
    if (!TOC_MAIN.test(text)) continue
    const n = text.split('.')[0]
    numbered.set(n, (numbered.get(n) ?? 0) + 1)
  }
  const dupes = [...numbered.entries()].filter(([, c]) => c > 1)
  if (dupes.length) {
    add(file, `duplicate TOC section numbers: ${dupes.map(([n, c]) => `${n}. x${c}`).join(', ')}`)
  }
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
console.log('\nEvery note matches the house format.')
