import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Home } from './components/Home'
import { SectionOverview } from './components/SectionOverview'
import { NotFound } from './components/NotFound'

// Lazy-load the note view (pulls in the Markdown renderer + highlighter) so it
// stays out of the initial bundle.
const NotePage = lazy(() => import('./components/NotePage'))

export default function App() {
  // Warm the NotePage chunk during idle so the first note opens instantly
  // instead of flashing the Suspense fallback. Reuses the same dynamic import
  // as lazy() above, so navigation is a cache hit.
  useEffect(() => {
    const run = () => {
      void import('./components/NotePage')
    }
    if (typeof window !== 'undefined' && window.requestIdleCallback) {
      window.requestIdleCallback(run)
      return
    }
    const t = setTimeout(run, 200)
    return () => clearTimeout(t)
  }, [])

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          {/* Section landing page. Declared before the note route so the more
              specific two-segment path still wins for actual notes. */}
          <Route path=":section" element={<SectionOverview />} />
          <Route
            path=":section/:slug"
            element={
              <Suspense fallback={<div className="p-10 text-secondary">Loading…</div>}>
                <NotePage />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
