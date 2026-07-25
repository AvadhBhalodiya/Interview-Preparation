import { useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import {
  LuCopy,
  LuCheck,
  LuInfo,
  LuLightbulb,
  LuTriangleAlert,
  LuKeyRound,
  LuShieldAlert,
  LuListChecks,
  LuMessageCircleQuestion,
  LuRefreshCw,
  LuBraces,
} from 'react-icons/lu'
import type { IconType } from 'react-icons'
import hljs from 'highlight.js/lib/core'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import http from 'highlight.js/lib/languages/http'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import { slugify } from '../lib/toc'
import { resolveNoteHref } from '../lib/content'
import { remarkCallouts } from '../lib/remarkCallouts'

// Only the languages we actually use - keeps the bundle small.
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('http', http)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('dockerfile', dockerfile)

// Callout kinds emitted by remarkCallouts (> [!TYPE]) → icon + shown label.
const CALLOUT: Record<string, { label: string; Icon: IconType }> = {
  note: { label: 'Note', Icon: LuInfo },
  info: { label: 'Note', Icon: LuInfo },
  tip: { label: 'Tip', Icon: LuLightbulb },
  warn: { label: 'Watch out', Icon: LuTriangleAlert },
  warning: { label: 'Watch out', Icon: LuTriangleAlert },
  gotcha: { label: 'Gotcha', Icon: LuTriangleAlert },
  key: { label: 'Key insight', Icon: LuKeyRound },
  important: { label: 'Important', Icon: LuKeyRound },
  danger: { label: 'Danger', Icon: LuShieldAlert },
}

// The house 6-section headings get an icon + themed banner. Keyed on the
// lower-cased heading text; unknown headings fall back to a plain h2.
const SECTION_THEME: Record<string, { cls: string; Icon: IconType }> = {
  'what it is': { cls: 'sec sec-info', Icon: LuInfo },
  'key points': { cls: 'sec sec-key', Icon: LuListChecks },
  example: { cls: 'sec sec-info', Icon: LuBraces },
  'interview q&a': { cls: 'sec sec-qa', Icon: LuMessageCircleQuestion },
  gotchas: { cls: 'sec sec-warn', Icon: LuTriangleAlert },
  'revise next': { cls: 'sec sec-next', Icon: LuRefreshCw },
}

// Recursively flatten a React node tree to its plain text (for heading ids).
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  const el = node as { props?: { children?: ReactNode } }
  if (el.props?.children != null) return nodeText(el.props.children)
  return ''
}

function CodeBlock({ lang, value }: { lang: string; value: string }) {
  const [copied, setCopied] = useState(false)
  // ```text``` (and unlabeled) blocks are our ASCII diagrams → render plain.
  const isDiagram = lang === 'text' || lang === 'txt' || lang === 'plaintext' || lang === ''
  const highlighted =
    !isDiagram && hljs.getLanguage(lang) ? hljs.highlight(value, { language: lang }).value : null

  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className={`code-card not-prose${isDiagram ? ' is-diagram' : ''}`}>
      {!isDiagram && (
        <div className="code-head">
          <span className="code-lang">{lang}</span>
          <button type="button" className="copy-btn" onClick={copy}>
            {copied ? (
              <>
                <LuCheck className="h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <LuCopy className="h-3.5 w-3.5" /> Copy
              </>
            )}
          </button>
        </div>
      )}
      <pre>
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{value}</code>
        )}
      </pre>
    </div>
  )
}

export function Markdown({ body, section }: { body: string; section: string }) {
  const components: Components = {
    h2: ({ children }) => {
      const text = nodeText(children)
      const theme = SECTION_THEME[text.trim().toLowerCase()]
      const Icon = theme?.Icon
      return (
        <h2 id={slugify(text)} className={theme?.cls}>
          {Icon && <Icon className="sec-icon" aria-hidden />}
          <span>{children}</span>
        </h2>
      )
    },
    h3: ({ children }) => <h3 id={slugify(nodeText(children))}>{children}</h3>,
    // Strip react-markdown's default <pre> so CodeBlock can supply its own.
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const match = /language-(\w+)/.exec(className || '')
      const text = String(children ?? '').replace(/\n$/, '')
      const isBlock = Boolean(className?.startsWith('language-')) || text.includes('\n')
      if (!isBlock) return <code className="inline-code">{children}</code>
      return <CodeBlock lang={match?.[1] ?? 'text'} value={text} />
    },
    // Callout panels emitted by remarkCallouts (> [!TYPE]); any other div passes through.
    div: ({ className, children }) => {
      const cls = String(className ?? '')
      const m = /\bcallout-(\w+)\b/.exec(cls)
      if (!m) return <div className={className}>{children}</div>
      const meta = CALLOUT[m[1]] ?? CALLOUT.note
      const Icon = meta.Icon
      return (
        <div className={cls}>
          <p className="callout-title">
            <Icon aria-hidden /> {meta.label}
          </p>
          <div className="callout-body">{children}</div>
        </div>
      )
    },
    a: ({ href, children }) => {
      if (!href) return <>{children}</>
      if (/^https?:\/\//.test(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      }
      // Note-to-note links: "dataclass-abc.md" (same section) or
      // "databases/indexing.md" / "../security/jwt.md" (cross-section).
      if (/\.md($|[?#])/i.test(href)) {
        const to = resolveNoteHref(href, section)
        // Unresolvable target: show the text, but don't offer a link that would
        // land on the 404 page. `pnpm check:links` reports these.
        return to ? <Link to={to}>{children}</Link> : <>{children}</>
      }
      return <a href={href}>{children}</a>
    },
    table: ({ children }) => (
      <div className="table-wrap not-prose">
        <table>{children}</table>
      </div>
    ),
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCallouts]} components={components}>
      {body}
    </ReactMarkdown>
  )
}
