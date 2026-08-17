// Bridges the app's CSS custom properties into a mermaid config.
//
// The palette lives in src/styles/index.css as --mm-* variables, defined once
// per theme, for the same reason the section brand colours do (see
// sectionIcons.tsx): a single hex cannot serve both canvases — the saturated
// fills that read well on white drop below AA on the dark surface, and the
// pastels that work on dark are invisible on white. Reading them back at render
// time keeps one source of truth and means the diagrams retune with the rest of
// the design system rather than beside it.

import { ROLES, type Palette, type Role } from './mermaidRoles'

export type Theme = 'light' | 'dark'

// Used when a variable is missing — during tests, or if someone renames a token
// without updating this file. Values match the light theme block in index.css.
const FALLBACK: Record<Role, string> = {
  client: '#1d4ed8',
  edge: '#4f46e5',
  service: '#7c3aed',
  store: '#0f7a4d',
  cache: '#b45309',
  queue: '#a16207',
  external: '#0e7490',
  decision: '#9333ea',
  ok: '#15803d',
  error: '#b91c1c',
  neutral: '#475569',
}

function read(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = styles.getPropertyValue(name).trim()
  return v || fallback
}

/** Mix a hex colour toward black. Used to derive a node's border from its fill. */
function darken(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const f = 1 - amount
  const r = Math.round(((n >> 16) & 255) * f)
  const g = Math.round(((n >> 8) & 255) * f)
  const b = Math.round((n & 255) * f)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

export interface DiagramTheme {
  palette: Palette
  /** Passed to mermaid.initialize as themeVariables. Carries the diagram types
   *  that classDef cannot reach — sequence, ER, class, state, gantt, mindmap. */
  themeVariables: Record<string, string>
}

/**
 * Resolve the active theme's diagram palette from the document.
 * Must run in the browser; call it after the stylesheet has applied.
 */
export function readDiagramTheme(theme: Theme): DiagramTheme {
  const styles = getComputedStyle(document.documentElement)

  const label = read(styles, '--mm-label', theme === 'dark' ? '#12131a' : '#ffffff')
  const surface = read(styles, '--mm-surface', theme === 'dark' ? '#1c1d24' : '#ffffff')
  const line = read(styles, '--mm-line', theme === 'dark' ? '#8b8d99' : '#565a66')
  const text = read(styles, '--mm-text', theme === 'dark' ? '#d6d7de' : '#2b2d33')
  const clusterBg = read(styles, '--mm-cluster-bg', theme === 'dark' ? '#22242c' : '#f4f6f9')
  const clusterBorder = read(styles, '--mm-cluster-border', theme === 'dark' ? '#2e3039' : '#d2d7e0')
  const font = read(styles, '--font-sans', 'Inter Variable, ui-sans-serif, system-ui, sans-serif')

  const palette = {} as Palette
  for (const role of ROLES) {
    const fill = read(styles, `--mm-${role}`, FALLBACK[role])
    palette[role] = { fill, stroke: darken(fill, theme === 'dark' ? 0.3 : 0.25), text: label }
  }

  // Mermaid's 'base' theme is the only one whose variables are fully
  // overridable; the named themes hardcode past most of these.
  const themeVariables: Record<string, string> = {
    darkMode: String(theme === 'dark'),
    background: surface,
    fontFamily: font,
    fontSize: '15px',

    // Generic node/box colours — what sequence, state, class and ER diagrams use.
    primaryColor: palette.service.fill,
    primaryTextColor: label,
    primaryBorderColor: palette.service.stroke,
    secondaryColor: palette.client.fill,
    secondaryTextColor: label,
    secondaryBorderColor: palette.client.stroke,
    tertiaryColor: clusterBg,
    tertiaryTextColor: text,
    tertiaryBorderColor: clusterBorder,

    lineColor: line,
    textColor: text,
    mainBkg: palette.neutral.fill,
    nodeBorder: palette.neutral.stroke,
    nodeTextColor: label,
    titleColor: text,
    edgeLabelBackground: surface,

    clusterBkg: clusterBg,
    clusterBorder: clusterBorder,

    // sequenceDiagram — 127 blocks, the second most common type.
    actorBkg: palette.client.fill,
    actorBorder: palette.client.stroke,
    actorTextColor: label,
    actorLineColor: line,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: palette.service.fill,
    labelBoxBorderColor: palette.service.stroke,
    labelTextColor: label,
    loopTextColor: text,
    noteBkgColor: palette.cache.fill,
    noteTextColor: label,
    noteBorderColor: palette.cache.stroke,
    activationBkgColor: palette.service.fill,
    activationBorderColor: palette.service.stroke,
    sequenceNumberColor: label,

    // stateDiagram-v2 — 21 blocks.
    labelColor: label,
    transitionColor: line,
    transitionLabelColor: text,
    stateLabelColor: text,
    stateBkg: palette.service.fill,
    altBackground: clusterBg,
    compositeBackground: clusterBg,
    compositeTitleBackground: clusterBg,
    compositeBorder: clusterBorder,
    innerEndBackground: palette.neutral.fill,
    specialStateColor: text,

    // erDiagram — 13 blocks.
    attributeBackgroundColorOdd: surface,
    attributeBackgroundColorEven: clusterBg,

    // classDiagram — 8 blocks.
    classText: label,

    // gantt / quadrantChart — one block each, but they render blank without these.
    sectionBkgColor: clusterBg,
    sectionBkgColor2: surface,
    altSectionBkgColor: surface,
    taskBkgColor: palette.service.fill,
    taskTextColor: label,
    taskTextLightColor: label,
    taskTextOutsideColor: text,
    taskBorderColor: palette.service.stroke,
    activeTaskBkgColor: palette.ok.fill,
    activeTaskBorderColor: palette.ok.stroke,
    doneTaskBkgColor: palette.neutral.fill,
    doneTaskBorderColor: palette.neutral.stroke,
    critBkgColor: palette.error.fill,
    critBorderColor: palette.error.stroke,
    gridColor: clusterBorder,
    todayLineColor: palette.error.fill,
  }

  return { palette, themeVariables }
}
