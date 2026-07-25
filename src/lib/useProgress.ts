import { useSyncExternalStore } from 'react'

// Study state: which notes you've marked done, and where you were last reading.
//
// The done-set is read by the sidebar, the home cards and the note page at once,
// so it's a module-level store rather than component state: useSyncExternalStore
// keeps every consumer in step without a provider or prop drilling.
//
// Persistence has two modes:
//   - Visitor (default): localStorage only — private to this browser, as before.
//   - Owner (unlocked with a token): the done-set is mirrored to a Netlify
//     function (see netlify/functions/progress.mts) so it syncs across the
//     owner's own devices. localStorage still backs it as an instant-paint cache.
// "Last visited" ("Continue reading") is always local — it's personal per device.

const DONE_KEY = 'notes:done'
const LAST_KEY = 'notes:last'
const OWNER_KEY = 'notes:owner-token'
const API = '/.netlify/functions/progress'

export type SyncStatus = 'idle' | 'saving' | 'error'

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const val = raw ? JSON.parse(raw) : []
    return Array.isArray(val) ? val.filter((x): x is string => typeof x === 'string') : []
  } catch {
    // Bad JSON or private mode — start clean rather than crash the app.
    return []
  }
}

function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode: state still works for this session, just won't survive.
  }
}

function readOwnerToken(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY)
  } catch {
    return null
  }
}

// Coerce anything the server (or storage) hands back into a clean string set.
function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((x): x is string => typeof x === 'string'))]
}

function sameMembers(set: ReadonlySet<string>, list: string[]): boolean {
  if (set.size !== list.length) return false
  for (const x of list) if (!set.has(x)) return false
  return true
}

// getSnapshot must return a stable reference while the data is unchanged, or
// useSyncExternalStore re-renders forever. So these are only reassigned on write.
let doneSnapshot: ReadonlySet<string> = new Set(readList(DONE_KEY))
let lastSnapshot: string | null = readList(LAST_KEY)[0] ?? null
let ownerToken: string | null = readOwnerToken()
let syncStatus: SyncStatus = 'idle'

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

function setStatus(next: SyncStatus) {
  if (syncStatus === next) return
  syncStatus = next
  emit()
}

// ---------------------------------------------------------------------------
// Owner sync (only runs while a token is set).
// ---------------------------------------------------------------------------

// Adopt a set returned by the server: mirror to the local cache, and only swap
// the live snapshot (a new reference → a render) when the members actually change.
function applyServerDone(next: string[]) {
  persist(DONE_KEY, next)
  if (sameMembers(doneSnapshot, next)) return
  doneSnapshot = new Set(next)
  emit()
}

async function request(method: string, body?: unknown): Promise<string[] | null> {
  const token = ownerToken
  if (!token) return null
  setStatus('saving')
  try {
    const res = await fetch(API, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) {
      // Token no longer valid (rotated/removed) — drop back to visitor mode.
      clearOwnerToken()
      return null
    }
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    setStatus('idle')
    return normalize(data?.done)
  } catch {
    // Network/server failure: keep the optimistic local state, flag the error.
    setStatus('error')
    return null
  }
}

async function hydrateFromServer() {
  const done = await request('GET')
  if (done) applyServerDone(done)
}

// Kick off a sync on load so an owner's devices converge without any interaction.
if (ownerToken) void hydrateFromServer()

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function toggleDone(path: string) {
  const next = new Set(doneSnapshot)
  let value: boolean
  if (next.delete(path)) value = false
  else {
    next.add(path)
    value = true
  }
  // Optimistic: update locally first so the UI responds instantly (and this is
  // the whole story for visitors).
  doneSnapshot = next
  persist(DONE_KEY, [...next])
  emit()
  if (ownerToken) {
    void request('POST', { path, value }).then((done) => {
      if (done) applyServerDone(done)
    })
  }
}

export function clearProgress() {
  doneSnapshot = new Set()
  persist(DONE_KEY, [])
  emit()
  if (ownerToken) void request('DELETE')
}

export function markVisited(path: string) {
  if (lastSnapshot === path) return
  lastSnapshot = path
  // Stored as a one-element array so it shares readList's parsing + guards.
  // Deliberately local-only: "Continue reading" is per-device, not synced.
  persist(LAST_KEY, [path])
  emit()
}

// ---------------------------------------------------------------------------
// Owner unlock
// ---------------------------------------------------------------------------

/**
 * Validate a token against the server and, if it's accepted, switch this device
 * into owner mode (syncing enabled). Returns whether the unlock succeeded.
 */
export async function setOwnerToken(token: string): Promise<boolean> {
  const trimmed = token.trim()
  if (!trimmed) return false
  setStatus('saving')
  try {
    const res = await fetch(API, { headers: { Authorization: `Bearer ${trimmed}` } })
    if (!res.ok) {
      // 401 = wrong token; anything else = server/network issue. Either way the
      // unlock failed; the UI shows an inline message.
      setStatus(res.status === 401 ? 'idle' : 'error')
      return false
    }
    const server = normalize((await res.json())?.done)
    ownerToken = trimmed
    try {
      localStorage.setItem(OWNER_KEY, trimmed)
    } catch {
      // Private mode: syncing works this session but won't be remembered.
    }
    emit() // useIsOwner flips to true
    if (server.length === 0 && doneSnapshot.size > 0) {
      // First device to sync and nothing stored yet — seed the server from the
      // marks already made here so they aren't lost.
      void request('PUT', { done: [...doneSnapshot] }).then((done) => {
        if (done) applyServerDone(done)
      })
    } else {
      applyServerDone(server)
      setStatus('idle')
    }
    return true
  } catch {
    setStatus('error')
    return false
  }
}

/** Leave owner mode on this device. The last-synced marks stay as the local view. */
export function clearOwnerToken() {
  if (ownerToken === null) return
  ownerToken = null
  try {
    localStorage.removeItem(OWNER_KEY)
  } catch {
    // Nothing to do — already gone or unavailable.
  }
  setStatus('idle')
  emit() // useIsOwner flips to false
}

// ---------------------------------------------------------------------------
// Cross-tab sync: another tab on this device changing any of these should show
// up here too.
// ---------------------------------------------------------------------------
window.addEventListener('storage', (e) => {
  if (e.key === DONE_KEY) {
    doneSnapshot = new Set(readList(DONE_KEY))
    emit()
  } else if (e.key === LAST_KEY) {
    lastSnapshot = readList(LAST_KEY)[0] ?? null
    emit()
  } else if (e.key === OWNER_KEY) {
    ownerToken = readOwnerToken()
    emit()
    if (ownerToken) void hydrateFromServer()
  }
})

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Paths of every note marked done. */
export function useDoneNotes(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => doneSnapshot, () => doneSnapshot)
}

/** Path of the note opened most recently, for "Continue reading". */
export function useLastVisited(): string | null {
  return useSyncExternalStore(subscribe, () => lastSnapshot, () => lastSnapshot)
}

/** Whether this device is unlocked as the owner (syncing across devices). */
export function useIsOwner(): boolean {
  return useSyncExternalStore(subscribe, () => ownerToken !== null, () => false)
}

/** Current sync state, for a subtle indicator in the owner control. */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, () => syncStatus, () => 'idle')
}
