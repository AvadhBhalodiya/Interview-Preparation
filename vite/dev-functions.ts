import type { Plugin } from 'vite'
import { loadEnv } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Serves netlify/functions/* from the Vite dev server itself, so `pnpm dev`
// needs ONE port instead of two.
//
// `netlify dev` is a reverse proxy: it listens on the port you open and forwards
// to Vite on a second port. That second port is the only reason it exists, and
// it also drags in the Netlify CLI, netlify.toml's dev-only passthrough
// redirects, and a linked-site lookup. This plugin removes all of that by
// answering /.netlify/functions/* inside Vite.
//
// The real function file is what runs — it is loaded through Vite's SSR pipeline
// rather than reimplemented, so there is no second copy of the request logic to
// keep in sync. Only its ONE non-portable dependency is swapped: @netlify/blobs
// needs Netlify's runtime to reach the hosted key/value store, so in dev it is
// aliased to ./dev-blobs.ts, which is backed by files under .netlify/dev-blobs/.
//
// Production is untouched: `apply: 'serve'` keeps every hook out of `pnpm build`,
// and a real deploy runs the real function against the real Blobs store.
// `pnpm dev:netlify` still exists for the rare check that wants full parity
// (netlify.toml redirects, real Blobs) and accepts the second port to get it.

const PREFIX = '/.netlify/functions/'
const FN_DIR = 'netlify/functions'
// Netlify resolves a function by basename; the extension is free choice.
const FN_EXTENSIONS = ['.mts', '.ts', '.mjs', '.js']
// Function names come off the URL, so keep them to a flat, boring alphabet —
// no separators, no dots, nothing that could climb out of the functions dir.
const FN_NAME = /^[A-Za-z0-9_-]+$/

// Exact match: a bare string `find` is a prefix test, which would also catch
// any future @netlify/blobs-* package.
const BLOBS_ID = /^@netlify\/blobs$/
const BLOBS_SHIM = fileURLToPath(new URL('./dev-blobs.ts', import.meta.url))

/** Root-relative id of the file backing `name`, or null if there isn't one. */
function resolveFunction(root: string, name: string): string | null {
  if (!FN_NAME.test(name)) return null
  for (const ext of FN_EXTENSIONS) {
    if (fs.existsSync(path.join(root, FN_DIR, name + ext))) return `/${FN_DIR}/${name}${ext}`
  }
  return null
}

// Vite's connect stack hands over an unread stream; nothing upstream parses a
// body for an arbitrary route, so collect it before building the Request.
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

// Node's IncomingMessage -> the web Request a Netlify function is handed.
function toRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    // Repeated headers arrive as an array; append keeps them all.
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one)
  }
  return new Request(url, { method: req.method, headers, body })
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

export function devFunctions(): Plugin {
  return {
    name: 'dev-functions',
    // Dev only. A build must never see the blobs alias or the env loading.
    apply: 'serve',

    config(config, { mode }) {
      const root = config.root ?? process.cwd()

      // The functions read plain process.env (progress.mts wants OWNER_TOKEN),
      // which Vite otherwise leaves alone — it only exposes VITE_-prefixed vars
      // to client code. An empty prefix loads every key, the same set the old
      // `set -a; . ./.env` gave the Netlify CLI. An explicitly exported var
      // still wins, so `OWNER_TOKEN=x pnpm dev` overrides .env.
      for (const [key, value] of Object.entries(loadEnv(mode, root, ''))) {
        if (process.env[key] === undefined) process.env[key] = value
      }
      // Read back by the shim, so the store lands next to the project even if
      // the dev server was started from another directory.
      process.env.DEV_BLOBS_ROOT = path.join(root, '.netlify', 'dev-blobs')

      // An alias rather than a resolveId hook: @netlify/blobs is a real
      // dependency, so for SSR Vite externalizes it and imports node_modules
      // directly, and a resolveId hook is never consulted. An alias is applied
      // earlier, and because it points at a file inside the project the result
      // isn't a candidate for externalizing either.
      return { resolve: { alias: [{ find: BLOBS_ID, replacement: BLOBS_SHIM }] } }
    },

    configureServer(server) {
      // Registered in the hook body rather than a returned callback, so it runs
      // BEFORE Vite's internal middlewares — the SPA fallback would otherwise
      // answer /.netlify/functions/* with index.html and the client would try
      // to JSON.parse a page of HTML.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(PREFIX)) return next()

        const name = url.slice(PREFIX.length).split('?')[0].replace(/\/+$/, '')
        const file = resolveFunction(server.config.root, name)
        // Unknown name: fall through, so it 404s like any other missing path
        // instead of masquerading as a broken function.
        if (!file) return next()

        try {
          const mod = await server.ssrLoadModule(file)
          const handler = mod.default
          if (typeof handler !== 'function') {
            throw new Error(`netlify/functions/${name} has no default export`)
          }
          const request = toRequest(req, await readBody(req))
          // Second arg is Netlify's Context. Nothing here reads it yet; if a
          // function ever does, give it that field rather than the whole object.
          const response = await handler(request, {})
          await send(res, response)
        } catch (err) {
          // Surface it in the terminal — a silent 500 in dev is a long debug.
          const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
          server.config.logger.error(`[dev-functions] ${name} failed\n${detail}`)
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain')
          res.end(detail)
        }
      })
    },
  }
}
