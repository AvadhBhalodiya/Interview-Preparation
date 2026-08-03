import fs from 'node:fs'
import path from 'node:path'

// Dev-only stand-in for @netlify/blobs, aliased into place by vite/dev-functions.ts.
//
// The real package talks to Netlify's hosted key/value store and throws
// MissingBlobsEnvironmentError without a siteID/token, which is why running a
// function outside `netlify dev` normally fails. This covers the slice of the
// API the functions in netlify/functions/ use, backed by plain files.
//
// One file per key under .netlify/dev-blobs/<store>/<key>, holding exactly what
// was written — so dev state is inspectable with `cat` and resettable with `rm`.
// (.netlify is already gitignored, so none of it can be committed.)

type StoreName = string | { name: string }

interface GetOptions {
  type?: 'json' | 'text' | 'arrayBuffer' | 'blob' | 'stream'
}

export interface DevStore {
  get(key: string, opts?: GetOptions): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  setJSON(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

// Set by the plugin from Vite's resolved root. The cwd fallback keeps this
// module usable on its own, e.g. from a one-off script.
function root(): string {
  return process.env.DEV_BLOBS_ROOT ?? path.join(process.cwd(), '.netlify', 'dev-blobs')
}

// Keys are free-form strings upstream and land here as filenames, so encode
// them — otherwise a key containing a slash would silently write elsewhere.
function file(store: string, key: string): string {
  return path.join(root(), store, encodeURIComponent(key))
}

function write(store: string, key: string, contents: string): void {
  const target = file(store, key)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

export function getStore(name: StoreName): DevStore {
  const store = typeof name === 'string' ? name : name.name
  return {
    async get(key, opts) {
      let raw: string
      try {
        raw = fs.readFileSync(file(store, key), 'utf8')
      } catch {
        // Missing key -> null, matching real Blobs. progress.mts depends on
        // this: its normalize(null) is what yields an empty done-set on a
        // fresh store rather than a crash.
        return null
      }
      return opts?.type === 'json' ? JSON.parse(raw) : raw
    },
    async set(key, value) {
      write(store, key, String(value))
    },
    async setJSON(key, value) {
      write(store, key, JSON.stringify(value, null, 2))
    },
    async delete(key) {
      try {
        fs.unlinkSync(file(store, key))
      } catch {
        // Already gone; deleting a missing key is a no-op upstream too.
      }
    },
  }
}
