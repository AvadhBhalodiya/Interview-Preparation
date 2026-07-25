// Verifies every note-to-note markdown link resolves to a real note.
//
// The renderer degrades an unresolvable link to plain text rather than shipping
// a dead link (see resolveNoteHref in src/lib/content.ts), which is good for
// readers but means a typo would otherwise fail silently. This is the check that
// makes those visible. Run: pnpm check:links
//
// Mirrors resolveNoteHref's resolution rules deliberately — if you change one,
// change both, or links will pass here and vanish in the UI.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = path.join(ROOT, 'src', 'content')

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (e.name.endsWith('.md') && !e.name.startsWith('_')) out.push(full)
  }
  return out
}

const files = walk(CONTENT)
const notes = new Set(
  files.map((f) => {
    const rel = path.relative(CONTENT, f).split(path.sep)
    return `${rel[0]}/${rel[rel.length - 1].replace(/\.md$/, '')}`
  })
)

// Skip fenced code blocks so a link-looking string in an example isn't checked.
function stripCode(md) {
  return md.replace(/```[\s\S]*?```/g, '')
}

function resolve(href, fromSection) {
  const parts = href
    .replace(/[?#].*$/, '')
    .replace(/\.md$/i, '')
    .split('/')
    .filter((p) => p && p !== '.')
  const stack = []
  for (const p of parts) {
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  if (!stack.length) return null
  const slug = stack[stack.length - 1]
  const section = stack.length > 1 ? stack[stack.length - 2] : fromSection
  return `${section}/${slug}`
}

const LINK = /\[([^\]]*)\]\(([^)\s]+?\.md(?:[?#][^)\s]*)?)\)/gi
let total = 0
const broken = []

for (const file of files) {
  const rel = path.relative(CONTENT, file).split(path.sep)
  const fromSection = rel[0]
  const src = stripCode(fs.readFileSync(file, 'utf8'))
  for (const m of src.matchAll(LINK)) {
    total++
    const target = resolve(m[2], fromSection)
    if (!target || !notes.has(target)) {
      broken.push({
        file: path.relative(ROOT, file),
        href: m[2],
        label: m[1],
        guess: target,
      })
    }
  }
}

console.log(`Checked ${total} note link(s) across ${files.length} notes.`)
if (broken.length) {
  console.log(`\n${broken.length} BROKEN:\n`)
  for (const b of broken) {
    console.log(`  ${b.file}`)
    console.log(`    [${b.label}](${b.href})  ->  ${b.guess ?? '(unparseable)'} does not exist`)
  }
  process.exit(1)
}
console.log('All note links resolve.')
