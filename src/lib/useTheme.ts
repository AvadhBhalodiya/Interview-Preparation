import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

// Keep these two in sync with the inline pre-mount script in index.html, which
// applies the stored theme before first paint to avoid a flash of the wrong
// palette. That script is the source of truth on load; this hook owns changes.
const STORAGE_KEY = 'theme'
const CANVAS: Record<Theme, string> = { light: '#f6f7f9', dark: '#15161b' }

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  // Tints the browser chrome on mobile; without this the address bar keeps the
  // old theme's color until a hard reload.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CANVAS[theme])
}

// Read-only subscription to the active theme, for components that need to react
// to it but must not own it. Deliberately watches the DOM attribute rather than
// exposing the useTheme state: a note can hold 31 diagrams, and this way they
// share ONE MutationObserver instead of registering 31 `storage` listeners.
// Watching the attribute also picks up every path that can change the theme —
// the header toggle, the cross-tab `storage` handler below, and the pre-paint
// script in index.html — because all three end at the same `dataset.theme`.
let observer: MutationObserver | null = null
const listeners = new Set<() => void>()

function subscribeToTheme(cb: () => void) {
  listeners.add(cb)
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((l) => l()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

export function useDocumentTheme(): Theme {
  return useSyncExternalStore(subscribeToTheme, currentTheme, () => 'light' as Theme)
}

export function useTheme() {
  // Seed from the DOM, not from storage: the pre-mount script has already read
  // storage and applied the result, so the DOM is both correct and cheaper.
  const [theme, setTheme] = useState<Theme>(currentTheme)

  useEffect(() => {
    // Keep other open tabs in step. `storage` only fires in *other* tabs, so
    // there's no risk of this echoing back the change we just made ourselves.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      const next: Theme = e.newValue === 'dark' ? 'dark' : 'light'
      applyTheme(next)
      setTheme(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const toggle = useCallback(() => {
    // Read the live DOM value rather than the closed-over state so this stays
    // correct even if something else flipped the theme since the last render.
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private mode: the toggle still works, it just won't survive a reload.
    }
    setTheme(next)
  }, [])

  return { theme, toggle }
}
