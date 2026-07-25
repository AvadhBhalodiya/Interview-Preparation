import { memo } from 'react'

/**
 * Ambient background: slow-drifting colour orbs behind the whole app.
 *
 * Rendered once by Layout, OUTSIDE the routed subtree, so navigating never
 * remounts it and the drift keeps its start time for the life of the page.
 *
 * The motion is pure CSS (see `.orb-field` in src/styles/index.css), not
 * motion/react, for two reasons: CSS transform animations run on the compositor
 * so they cannot stutter while NotePage does its synchronous markdown parse on
 * navigation, and they cost zero JS on a route that already ships motion as a
 * render-blocking chunk.
 *
 * `calm` dims and shrinks the field on note pages so it never competes with
 * long-form reading.
 */
export const OrbField = memo(function OrbField({ calm }: { calm: boolean }) {
  return (
    // `undefined` (not `false`) so React omits the attribute entirely — the CSS
    // hook is a bare [data-calm] selector, which would match `data-calm="false"`.
    <div className="orb-field" data-calm={calm ? '' : undefined} aria-hidden>
      <span className="orb orb-1" />
      <span className="orb orb-2" />
      <span className="orb orb-3" />
      <span className="orb orb-4" />
      <span className="orb orb-5" />
    </div>
  )
})
