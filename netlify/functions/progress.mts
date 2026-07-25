// Owner-only store for the "mark as read/done" set, shared across the owner's
// devices. Backed by Netlify Blobs (a built-in key/value store — no external DB).
//
// Every method is gated by a bearer token compared against OWNER_TOKEN, so the
// set is private: visitors never reach it (they keep their own local progress).
// The client lives in src/lib/useProgress.ts.
//
//   GET     → { done: string[] }            read the set
//   POST    { path, value? }  → { done }     toggle one note (value forces state)
//   PUT     { done: string[] } → { done }    replace the whole set (first-sync seed)
//   DELETE  → { done: [] }                   clear everything

import { getStore } from '@netlify/blobs'
import { timingSafeEqual } from 'node:crypto'

const KEY = 'done'

// Constant-time compare so the token can't be recovered by timing the response.
// timingSafeEqual throws on length mismatch, so the length check guards it.
function authorized(req: Request): boolean {
  const expected = process.env.OWNER_TOKEN
  if (!expected) return false
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((x): x is string => typeof x === 'string'))]
}

export default async (req: Request): Promise<Response> => {
  if (!authorized(req)) return new Response('Unauthorized', { status: 401 })

  const store = getStore('progress')
  const load = async (): Promise<string[]> => normalize(await store.get(KEY, { type: 'json' }))

  if (req.method === 'GET') {
    return Response.json({ done: await load() })
  }

  if (req.method === 'DELETE') {
    await store.setJSON(KEY, [])
    return Response.json({ done: [] })
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    if (req.method === 'PUT') {
      const done = normalize((body as { done?: unknown } | null)?.done)
      await store.setJSON(KEY, done)
      return Response.json({ done })
    }

    // POST toggles a single path. `value` true=add / false=remove / omitted=flip.
    const { path, value } = (body ?? {}) as { path?: unknown; value?: unknown }
    if (typeof path !== 'string' || !path) return new Response('Bad Request', { status: 400 })

    const set = new Set(await load())
    if (value === false) set.delete(path)
    else if (value === true) set.add(path)
    else if (!set.delete(path)) set.add(path)

    const done = [...set]
    await store.setJSON(KEY, done)
    return Response.json({ done })
  }

  return new Response('Method Not Allowed', { status: 405 })
}
