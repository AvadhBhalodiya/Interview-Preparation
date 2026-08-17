import { useEffect, useRef, useState } from 'react'
import {
  LuCheck,
  LuCode,
  LuCopy,
  LuDownload,
  LuImage,
  LuMaximize2,
  LuTriangleAlert,
} from 'react-icons/lu'
import { renderDiagram } from '../lib/mermaidRender'
import { useDocumentTheme } from '../lib/useTheme'
import { downloadPng, downloadSvg } from '../lib/diagramExport'
import { DiagramOverlay } from './DiagramOverlay'

// Renders one ```mermaid fence as a real diagram.
//
// Rendering is deferred until the block is near the viewport. There are 712
// diagrams across the notes and one file alone holds 31 in 3,149 lines; laying
// all of those out on mount visibly locks the page, whereas rendering them as
// they are scrolled toward costs nothing the reader can perceive.
//
// A malformed diagram must never take a note down with it: on a parse error the
// component degrades to the same monospace block the site showed before mermaid
// existed, which is a readable worst case rather than a blank space.

type State =
  | { kind: 'pending' }
  | { kind: 'ok'; svg: string; decorated: string }
  | { kind: 'error'; message: string }

export function MermaidDiagram({ source, title }: { source: string; title: string }) {
  const theme = useDocumentTheme()
  const [state, setState] = useState<State>({ kind: 'pending' })
  const [visible, setVisible] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const host = useRef<HTMLDivElement | null>(null)

  // Start rendering slightly before the diagram is scrolled to, so it is already
  // there by the time it is read.
  useEffect(() => {
    const el = host.current
    if (!el || visible) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let alive = true
    setState({ kind: 'pending' })
    renderDiagram(source, theme).then(
      (r) => alive && setState({ kind: 'ok', ...r }),
      (e: unknown) =>
        alive &&
        setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not render' }),
    )
    // A theme flip or unmount mid-render must not write a stale SVG.
    return () => {
      alive = false
    }
  }, [source, theme, visible])

  const surface = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--mm-surface').trim() || '#ffffff'

  const svgEl = () => host.current?.querySelector('svg') as SVGSVGElement | null

  const copy = () => {
    navigator.clipboard?.writeText(source).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  // The raw fence, shown on the source toggle and whenever mermaid could not
  // parse it. Identical in spirit to CodeBlock's diagram rendering.
  if (state.kind === 'error' || showSource) {
    return (
      <div className="diagram-card not-prose" ref={host}>
        <div className="diagram-head">
          <span className="code-lang">mermaid</span>
          <div className="flex items-center gap-1">
            {state.kind === 'error' ? (
              <span className="diagram-err" title={state.message}>
                <LuTriangleAlert className="h-3.5 w-3.5" /> Could not render
              </span>
            ) : (
              <button type="button" className="copy-btn" onClick={() => setShowSource(false)}>
                <LuCode className="h-3.5 w-3.5" /> Show diagram
              </button>
            )}
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
        </div>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    )
  }

  return (
    <>
      <div className="diagram-card not-prose" ref={host}>
        <div className="diagram-head">
          <span className="code-lang">diagram</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="copy-btn"
              onClick={() => setShowSource(true)}
              aria-label="View mermaid source"
              title="View source"
            >
              <LuCode className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={() => {
                const el = svgEl()
                if (el) downloadSvg(el, title, surface())
              }}
              aria-label="Download as SVG"
              title="Download SVG"
              disabled={state.kind !== 'ok'}
            >
              <LuDownload className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={() => {
                const el = svgEl()
                if (el) void downloadPng(el, title, surface())
              }}
              aria-label="Download as PNG"
              title="Download PNG"
              disabled={state.kind !== 'ok'}
            >
              <LuImage className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={() => setExpanded(true)}
              aria-label="Expand diagram to fullscreen"
              title="Expand"
              disabled={state.kind !== 'ok'}
            >
              <LuMaximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {state.kind === 'ok' ? (
          // A plain div, not a button: with htmlLabels on, mermaid renders node
          // text as <foreignObject><div>, and a div inside a button is invalid
          // content. Clicking the diagram is a convenience only — the Expand
          // control in the header is the keyboard-reachable path.
          <div
            className="diagram-body"
            onClick={() => setExpanded(true)}
            // mermaid sanitizes its own output (securityLevel: 'strict').
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        ) : (
          <div className="diagram-skeleton" aria-hidden />
        )}
      </div>

      {state.kind === 'ok' && (
        <DiagramOverlay
          open={expanded}
          onClose={() => setExpanded(false)}
          svg={state.svg}
          title={title}
          surface={surface()}
        />
      )}
    </>
  )
}
