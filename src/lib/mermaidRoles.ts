// Automatic semantic colouring for the ~712 mermaid diagrams in src/content.
//
// The notes deliberately carry NO styling of their own — a diagram in markdown
// stays plain `flowchart LR / A[Client] --> B[(Postgres)]`, so it reads well as
// source and renders identically anywhere else. Colour is applied here instead,
// by classifying each node and injecting classDef/class lines before mermaid
// parses. Retuning the whole site therefore means editing the --mm-* variables
// in src/styles/index.css, not touching 101 markdown files.
//
// Measured against the real corpus (3,901 node declarations): ~56% of nodes
// match a role and ~44% land on `neutral`. That split is intentional. The
// unmatched ones are process steps ("execute operation", "return stored
// result") and colouring those too would leave nothing standing out — the
// point of the palette is that infrastructure pops against the plain steps.
// Resist widening the keyword lists to shrink the neutral share.

export type Role =
  | 'client'
  | 'edge'
  | 'service'
  | 'store'
  | 'cache'
  | 'queue'
  | 'external'
  | 'decision'
  | 'ok'
  | 'error'
  | 'neutral'

export const ROLES: Role[] = [
  'client',
  'edge',
  'service',
  'store',
  'cache',
  'queue',
  'external',
  'decision',
  'ok',
  'error',
  'neutral',
]

// Keyword tables, ordered — first match wins. The order matters more than the
// individual entries: "Redis Cache" and "Message Broker" are both cylinders, so
// cache/queue have to be consulted before store or all 287 cylinders collapse
// to one green. Every noun carries its plural: `\bworker\b` silently missed
// "Email Workers" / "Payment Workers" and stranded 135 nodes on neutral.
const KEYWORDS: [Role, RegExp][] = [
  [
    'error',
    /\b(errors?|fail(ed|ure|ures|s)?|reject(ed|s)?|invalid|timeouts?|denied|expired|429|5\d\d|dlq|dead[- ]letter|abort(ed)?|rollback|stale|miss(es)?|retr(y|ies)|backoff|breach|attack|leak)\b/,
  ],
  [
    'ok',
    /\b(success(ful)?|succeed(ed|s)?|ok|200|201|204|done|completed?|commit(ted)?|approved|verified|granted|valid|hits?|ack)\b/,
  ],
  ['cache', /\b(caches?|cached|caching|redis|memcached?|cdn|edge cache)\b/],
  [
    'queue',
    /\b(queues?|brokers?|rabbitmq|sqs|sns|kafka|celery|topics?|exchanges?|streams?|pub[- /]?sub|publishers?|subscribers?|outbox|inbox|tasks?|jobs?|workers?|beat|consumers?|producers?|scheduler|dispatch(er)?|backlog)\b/,
  ],
  [
    'store',
    /\b(databases?|db|postgres\w*|mysql|sqlite|tables?|stores?|storage|s3|dynamodb|mongo\w*|elasticsearch|shards?|replicas?|primary|standby|index(es)?|ledger|buckets?|blobs?|warehouse|backend|volumes?|disk|persist\w*)\b/,
  ],
  [
    'external',
    /\b(external|third[- ]party|providers?|vendors?|upstream|partners?|stripe|razorpay|paypal|webhooks?|issuers?|acquirers?|banks?|psp|idp|oauth provider|registry)\b/,
  ],
  [
    'edge',
    /\b(gateways?|balancers?|load balancer|lb|prox(y|ies)|nginx|envoy|haproxy|waf|edge|ingress|routers?|dns|firewall)\b/,
  ],
  // service BEFORE client, deliberately. Labels in these notes name the actor
  // first and the thing second — "User Service", "Web BFF", "Admin Portal" —
  // so checking client first classified every backend-for-frontend and the user
  // service as a client. The head noun is what the node IS; the qualifier only
  // says who it serves. A bare "User" or "Mobile App" still falls through to
  // client below, because it contains no service noun at all.
  [
    'service',
    /\b(services?|api|apis?|bff|servers?|handlers?|views?|controllers?|endpoints?|process(es|ing|or)?|compute|instances?|engines?|orchestrator|django|fastapi|flask|middleware|resolvers?|serializers?|validators?|orm|models?|pools?|lambda|containers?)\b/,
  ],
  [
    'client',
    /\b(clients?|users?|customers?|browsers?|mobile|web|frontend|ui|apps?|applications?|callers?|portals?|admin|requests?|responses?|visitors?|devices?)\b/,
  ],
]

// Only flowchart/graph gets classDef injection. stateDiagram-v2 technically
// accepts classDef too, but its nodes are declared by an entirely different
// grammar that this parser does not read, so it would be a no-op with a risk of
// corrupting the source. Every other type — sequence, ER, class, gantt,
// quadrant, mindmap — either rejects classDef or means something different by
// it, and is left to the themeVariables palette alone.
const FLOWCHART = /^\s*(flowchart|graph)\s/

// Statements that declare something other than a node, or that already style
// one. Lines starting with these are skipped so we never class a subgraph
// container or re-class an author's own work.
const SKIP_LINE = /^\s*(subgraph|end\b|classDef|class\s|style\s|linkStyle|click|direction)/

// Hand-authored styling that actually sets a colour, as opposed to geometry.
const AUTHOR_COLOR = /^\s*(classDef|style)\s[^\n]*\b(fill|color|stroke)\s*:\s*[^;\n]/m

// A node label wrapped in quotes may legally contain the bracket characters
// that otherwise terminate it ("Root: 30 | 60"), so quoted forms are matched
// first and separately from bare ones.
const OPEN = String.raw`\[\[|\[\(|\(\(|\{\{|\(\[|\[|\{`
const CLOSE = String.raw`\]\]|\)\]|\)\)|\}\}|\]\)|\]|\}`
const QUOTED = new RegExp(
  String.raw`([A-Za-z_][\w-]*)(${OPEN})\s*"([^"]*)"\s*(${CLOSE})`,
  'g',
)
const BARE = new RegExp(
  String.raw`([A-Za-z_][\w-]*)(${OPEN})([^\[\]{}()"|>]+)(${CLOSE})`,
  'g',
)

function roleFromLabel(label: string): Role | null {
  // <br/> is a line break in 87 labels; without collapsing it "Email<br/>Workers"
  // would not word-match "workers".
  const text = label.replace(/<br\s*\/?>/gi, ' ').toLowerCase()
  for (const [role, re] of KEYWORDS) if (re.test(text)) return role
  return null
}

function roleFromShape(open: string): Role | null {
  if (open === '[[') return 'queue' // SQS, Email Queue, Delivery Event Queue
  if (open === '[(') return 'store'
  if (open === '{') return 'decision'
  return null
}

/** Classify one node. Shape only decides what the label could not. */
function classify(open: string, label: string): Role {
  // `[[...]]` is used exclusively for queues in this corpus and is a stronger
  // signal than any word inside it.
  if (open === '[[') return 'queue'
  // A rhombus is a branch point regardless of the nouns inside it — "Cache
  // hit?" is a decision, not a cache — so shape wins here. Everywhere else the
  // label is the better signal: cylinders hold databases, caches AND brokers.
  if (open === '{' && /\?\s*$/.test(label.trim())) return 'decision'
  return roleFromLabel(label) ?? roleFromShape(open) ?? 'neutral'
}

/**
 * Assign a role to every node declared in a flowchart source.
 * Exported for the palette preview and for tests; `decorate` is the entry point.
 */
export function classifyNodes(source: string): Map<string, Role> {
  const found = new Map<string, Role>()
  const lines = source.split('\n').filter((l) => !SKIP_LINE.test(l))

  for (const re of [QUOTED, BARE]) {
    for (const line of lines) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        const [, id, open, label] = m
        // First declaration wins: an id re-used later on an edge carries no label.
        if (!found.has(id)) found.set(id, classify(open, label))
      }
    }
  }
  return found
}

/** Resolved colours for one theme, keyed by role. See mermaidTheme.ts. */
export type Palette = Record<Role, { fill: string; stroke: string; text: string }>

/**
 * Inject classDef/class lines into a mermaid source.
 * Returns the source unchanged when it is not a flowchart, when the author has
 * already styled it, or when nothing was classified.
 */
export function decorate(source: string, palette: Palette): string {
  if (!FLOWCHART.test(source)) return source
  // Stand aside where the author already chose colours — but only then. A
  // classDef that sets nothing but stroke-width (as one note does, to mark a
  // compliance boundary) is emphasis, not a palette, and should still get role
  // colours underneath it; mermaid composes the two classes.
  if (AUTHOR_COLOR.test(source)) return source

  const roles = classifyNodes(source)
  if (roles.size === 0) return source

  const used = new Set(roles.values())
  const byRole = new Map<Role, string[]>()
  for (const [id, role] of roles) {
    const list = byRole.get(role)
    if (list) list.push(id)
    else byRole.set(role, [id])
  }

  const out: string[] = []
  for (const role of ROLES) {
    if (!used.has(role)) continue
    const c = palette[role]
    out.push(
      `classDef mm-${role} fill:${c.fill},stroke:${c.stroke},color:${c.text},stroke-width:1px,rx:4,ry:4`,
    )
  }
  for (const role of ROLES) {
    const ids = byRole.get(role)
    if (ids?.length) out.push(`class ${ids.join(',')} mm-${role}`)
  }

  // Appended after everything, so a trailing `end` from a subgraph cannot
  // swallow these statements.
  return `${source.replace(/\s+$/, '')}\n${out.join('\n')}\n`
}
