import { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { LuMenu, LuPanelLeftOpen, LuPanelLeftClose, LuSun, LuMoon } from 'react-icons/lu'
import { Sidebar } from './Sidebar'
import { Search } from './Search'
import { OrbField } from './OrbField'
import { OwnerUnlock } from './OwnerUnlock'
import { useTheme } from '../lib/useTheme'

const SIDEBAR_KEY = 'sidebar'

export function Layout() {
  const [drawer, setDrawer] = useState(false)
  const { theme, toggle: toggleTheme } = useTheme()
  // The desktop sidebar remembers whether you left it open. Read lazily so the
  // very first render already has the right width and nothing animates on load.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== 'open'
    } catch {
      return true
    }
  })
  const location = useLocation()
  const reduce = useReducedMotion()

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? 'closed' : 'open')
    } catch {
      // Private mode — the sidebar just won't remember across reloads.
    }
  }, [collapsed])

  useEffect(() => {
    setDrawer(false)
  }, [location.pathname])

  // While the drawer is open: lock the page behind it (otherwise the content
  // keeps scrolling under your finger on touch) and let Escape close it.
  useEffect(() => {
    if (!drawer) return
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [drawer])

  // Opening a note *from Home* reveals the desktop sidebar (the accordion then
  // expands that section). Direct loads / refreshes stay as you left them.
  // Deliberately scoped to journeys that start at Home: now that the collapsed
  // state persists, firing on every navigation would silently overwrite a
  // collapse you chose, and re-open the sidebar just for clicking "next note".
  const prevPath = useRef<string | null>(null)
  useEffect(() => {
    const from = prevPath.current
    prevPath.current = location.pathname
    // Any route below Home counts: cards now land on /:section (one segment),
    // and notes are /:section/:slug (two).
    if (from === '/' && /^\/[^/]+/.test(location.pathname)) setCollapsed(false)
  }, [location.pathname])

  // Two path segments means a note page (/:section/:slug), where the ambient
  // background recedes so it doesn't compete with long-form reading. Derived
  // from the router, so it recomputes on navigation and never on scroll.
  const calmBackground = location.pathname.split('/').filter(Boolean).length >= 2

  return (
    <div className="min-h-screen">
      {/* Outside <main>'s AnimatePresence on purpose — see OrbField. */}
      <OrbField calm={calmBackground} />
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setDrawer((d) => !d)}
          aria-label="Toggle menu"
          className="tap-target grid h-9 w-9 place-items-center rounded-lg border border-border text-fg transition hover:border-accent hover:text-accent lg:hidden"
        >
          <LuMenu className="h-5 w-5" />
        </button>

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Open sidebar' : 'Close sidebar'}
          aria-expanded={!collapsed}
          className="hidden h-9 w-9 place-items-center rounded-lg border border-border text-fg transition hover:border-accent hover:text-accent lg:grid"
        >
          {collapsed ? <LuPanelLeftOpen className="h-5 w-5" /> : <LuPanelLeftClose className="h-5 w-5" />}
        </button>

        <Link to="/" className="flex items-center gap-2.5 font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-lg brand-gradient text-accent-contrast shadow-sm shadow-[color:var(--glow)]">
            <svg
              viewBox="0 0 24 24"
              className="h-[18px] w-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M6 8l4 4-4 4" />
              <path d="M13 16h5" />
            </svg>
          </span>
          <span className="text-[15px] leading-none">
            <span className="text-gradient">Interview Notes</span>
          </span>
        </Link>

        <div className="flex-1" />

        <button
          type="button"
          onClick={toggleTheme}
          // The icon shows the destination, not the current state, so the label
          // has to say so too — otherwise a screen reader reads it backwards.
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-pressed={theme === 'dark'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="tap-target grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border text-fg transition hover:border-accent hover:text-accent"
        >
          {theme === 'dark' ? <LuSun className="h-5 w-5" /> : <LuMoon className="h-5 w-5" />}
        </button>

        <Search />
      </header>

      <div className="flex items-start">
        {/* desktop sidebar - collapsible, animated width */}
        <motion.aside
          className="sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 overflow-hidden border-border bg-surface lg:block"
          initial={false}
          animate={{ width: collapsed ? 0 : 288 }}
          transition={reduce ? { duration: 0 } : { type: 'tween', duration: 0.28, ease: 'easeOut' }}
          style={{ borderRightWidth: collapsed ? 0 : 1 }}
        >
          <div className="h-full w-72 overflow-y-auto px-3 py-5">
            <Sidebar onNavigate={() => {}} />
          </div>
        </motion.aside>

        {/* mobile drawer */}
        <AnimatePresence>
          {drawer && (
            <>
              <motion.div
                className="fixed inset-x-0 bottom-0 top-14 z-40 bg-black/60 lg:hidden"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                onClick={() => setDrawer(false)}
                aria-hidden
              />
              <motion.aside
                // Capped so there is always a real scrim left to tap: a flat
                // w-72 is 288px, i.e. 90% of a 320px screen, and the remaining
                // sliver sits in iOS Safari's edge-swipe-back zone.
                className="fixed bottom-0 left-0 top-14 z-50 w-[min(18rem,calc(100vw-3.5rem))] overflow-y-auto border-r border-border bg-surface px-3 py-5 lg:hidden"
                initial={reduce ? false : { x: '-100%' }}
                animate={{ x: 0 }}
                exit={reduce ? undefined : { x: '-100%' }}
                transition={reduce ? { duration: 0 } : { type: 'tween', duration: 0.25, ease: 'easeOut' }}
              >
                <Sidebar onNavigate={() => setDrawer(false)} />
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <main className="min-w-0 flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Owner sign-in for cross-device read-progress sync; visitors can ignore it. */}
      <footer className="border-t border-border/60 px-4 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-end">
          <OwnerUnlock />
        </div>
      </footer>
    </div>
  )
}
