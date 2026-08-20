# Interview Notes

A fast, **frontend-only** static site for reading backend interview-prep notes. Content is plain
Markdown organised into sections; the site renders it with a sidebar, full-text search, light/dark
themes, progress tracking, code highlighting, and an "on this page" outline. No backend — the build
output is static files you can host anywhere.

See [INTERVIEW_GUIDE.md](INTERVIEW_GUIDE.md) for what to study and what interviewers ask.

## Run locally

```bash
pnpm install
pnpm dev          # dev server with hot reload → http://localhost:5178
```

## Build & preview the production bundle

```bash
pnpm build        # type-checks, then outputs the static site to dist/
pnpm preview      # serve dist/ locally to sanity-check the build
```

## Check the content

```bash
pnpm check        # runs both checks below
pnpm check:structure   # every note matches the house format (headings, frontmatter, footer, no emoji)
pnpm check:links       # every note-to-note markdown link resolves to a real note
```

Worth knowing: the renderer degrades an unresolvable `.md` link to plain text rather than shipping a
link that dead-ends on the 404 page. That is good for readers but means a typo fails silently —
`check:links` is what surfaces it.

## Deploy (host the `dist/` folder anywhere)

`pnpm build` produces a self-contained `dist/`. Because asset URLs are relative (`base: './'`) and
routing uses the URL hash, it works from any location with **zero server config**:

- **GitHub Pages / Netlify / Vercel / Cloudflare Pages / S3** — publish `dist/`.
- Or just serve it with any static server (e.g. `python3 -m http.server -d dist 8080`).

## Add content (this is the whole point — it scales by dropping files)

**Add a note:** create `src/content/<section>/<slug>.md`:

```markdown
---
title: "Query Optimisation"     # sidebar label + browser tab title
group: "ORM"                    # clusters notes within a section
order: 3                        # sort order within the section
---

# Query Optimisation

> One sentence stating the note's thesis.

## What it is
## Key points
## Example
## Interview Q&A
## Gotchas
## Revise next

*Reviewed against <thing> <version>, <Month Year>.*
```

It appears in the menu automatically — no code changes. Files starting with `_` are ignored (drafts).

Those six `##` headings are **required and order-sensitive**: the renderer themes each one with its
own icon and accent colour by matching the exact text, and `pnpm check:structure` enforces it.

**Link between notes** with relative markdown links — same section `[Label](slug.md)`, other section
`[Label](../section/slug.md)`. These become client-side route links.

**Add a section:** create a new folder under `src/content/`. Optionally add one line to
`src/lib/sections.ts` for a nicer label/icon/order, and one to `src/lib/sectionIcons.tsx` for the
icon component:

```ts
django: { label: 'Django', icon: '🎸', order: 2 },
```

Without those lines the folder still works (prettified name + default folder icon).

## How it's built

- **React 18 + Vite 6 + TypeScript**, output is a static SPA. **Tailwind v4** for styling.
- **react-markdown** + **remark-gfm** for rendering; **highlight.js** for code (python, bash, sql,
  http, json, yaml, dockerfile), with `text` fenced blocks rendered as plain monospace so ASCII
  diagrams stay aligned.
- **HashRouter** so deep links work on any static host.
- **Two themes**, light by default, dark preserved, toggled from the header and persisted in
  `localStorage`. An inline script in `index.html` applies the stored theme *before first paint*, so
  reloading in dark mode never flashes white. Every colour in the app resolves through CSS variables
  defined once in `src/styles/index.css` — `:root` is light, `html[data-theme='dark']` is dark — so
  adding a colour means adding it to both blocks, not touching components.
- **Full-text search** over note bodies with highlighted match snippets. The body index is a separate
  virtual module (`virtual:search-index`) loaded on the first keystroke, so browsing never downloads
  it; note metadata (`virtual:content-index`) stays eager and tiny.
- **Progress tracking** — mark notes done, per-section counts, and "continue where you left off",
  all in `localStorage` via a `useSyncExternalStore` module so every view stays in sync.

## Performance notes

Note bodies are **lazy**: each is its own chunk fetched on demand, so the entry bundle carries only
metadata. `NotePage` (which pulls in the markdown renderer and highlighter) is `lazy()`-loaded and
prefetched on idle. Keep it that way — importing a note body or the search index eagerly would undo it.

## Project layout

```
index.html                        # entry shell + pre-paint theme script
scripts/                          # check-structure.mjs, check-links.mjs
vite/md-meta.ts                   # build-time indexer -> virtual:content-index + virtual:search-index
src/
  content/<section>/<slug>.md     # the notes (Markdown + frontmatter)
  lib/        content.ts sections.ts sectionIcons.tsx groupIcons.tsx
              useTheme.ts useProgress.ts toc.ts types.ts remarkCallouts.ts
  components/ Layout Sidebar Search Markdown NotePage SectionOverview
              TableOfContents Breadcrumbs PrevNext Home NotFound
  styles/     index.css           # the entire palette + all component styling
```
