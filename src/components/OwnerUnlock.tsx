import { useState, type FormEvent } from 'react'
import { LuLock, LuLockOpen, LuLogOut, LuTriangleAlert } from 'react-icons/lu'
import {
  useIsOwner,
  useSyncStatus,
  setOwnerToken,
  clearOwnerToken,
} from '../lib/useProgress'

// Unobtrusive owner sign-in that lives in the app footer. Visitors can ignore
// it; unlocking with the token turns on cross-device sync of the read/done set
// (see src/lib/useProgress.ts + netlify/functions/progress.mts).
export function OwnerUnlock() {
  const isOwner = useIsOwner()
  const status = useSyncStatus()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Owner: show sync state + a way out.
  if (isOwner) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm">
        {status === 'error' ? (
          <span className="inline-flex items-center gap-1.5 text-[color:var(--danger)]">
            <LuTriangleAlert className="h-4 w-4" />
            Sync failed — retries on your next change
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-secondary">
            <LuLockOpen className="h-4 w-4 text-accent" />
            {status === 'saving' ? 'Syncing…' : 'Synced across your devices'}
          </span>
        )}
        <button
          type="button"
          onClick={() => clearOwnerToken()}
          className="tap-target inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-secondary transition hover:border-accent hover:text-accent"
        >
          <LuLogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    )
  }

  // Visitor, collapsed: a faint affordance.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Owner sign-in — sync your read progress across your devices"
        className="tap-target inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-muted transition hover:text-accent"
      >
        <LuLock className="h-3.5 w-3.5" /> Owner
      </button>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const ok = await setOwnerToken(token)
    setBusy(false)
    if (ok) {
      setOpen(false)
      setToken('')
    } else {
      setError('That token was not accepted. Check it and try again.')
    }
  }

  // Visitor, expanded: the unlock form.
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center justify-end gap-2 text-sm">
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoFocus
        autoComplete="off"
        placeholder="Owner token"
        aria-label="Owner token"
        className="h-9 w-48 rounded-lg border border-border bg-surface px-3 text-fg outline-none transition focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy || !token.trim()}
        className="tap-target inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-contrast transition hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Unlock'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false)
          setToken('')
          setError(null)
        }}
        className="tap-target rounded-lg border border-border px-2.5 py-1.5 text-secondary transition hover:border-accent hover:text-accent"
      >
        Cancel
      </button>
      {error && <p className="w-full text-right text-[color:var(--danger)]">{error}</p>}
    </form>
  )
}
