import { Link } from 'react-router-dom'

export function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 sm:px-6 py-24 text-center">
      <div className="text-gradient text-6xl font-black">404</div>
      <p className="mt-3 text-secondary">That note doesn’t exist (or was moved).</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-lg brand-gradient px-5 py-2.5 font-semibold text-accent-contrast shadow-sm shadow-[color:var(--glow)] transition hover:opacity-90"
      >
        ← Back to home
      </Link>
    </div>
  )
}
