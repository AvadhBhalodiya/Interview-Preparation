// Saving a rendered diagram to a file.
//
// The SVG mermaid hands back is styled partly by its own <style> block and
// partly by inherited page CSS (font, and the theme colours behind any
// currentColor). Written straight to disk it opens unstyled, so both exporters
// re-parent the markup, pin an explicit width/height and background, and inline
// the font stack before serializing.

function prepare(svgEl: SVGSVGElement, background: string): { clone: SVGSVGElement; w: number; h: number } {
  const box = svgEl.getBoundingClientRect()
  const viewBox = svgEl.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  const w = Math.max(1, Math.round(box.width || viewBox?.[2] || 800))
  const h = Math.max(1, Math.round(box.height || viewBox?.[3] || 600))

  const clone = svgEl.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  // useMaxWidth:true leaves an inline max-width that would re-shrink the export.
  clone.style.maxWidth = 'none'
  clone.style.background = background
  clone.style.fontFamily = getComputedStyle(svgEl).fontFamily

  return { clone, w, h }
}

function serialize(clone: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(clone)
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking synchronously can race the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function downloadSvg(svgEl: SVGSVGElement, filename: string, background: string) {
  const { clone } = prepare(svgEl, background)
  save(new Blob([serialize(clone)], { type: 'image/svg+xml;charset=utf-8' }), `${filename}.svg`)
}

/** Rasterize at 2x so the result stays sharp when dropped into notes or slides. */
export async function downloadPng(svgEl: SVGSVGElement, filename: string, background: string) {
  const { clone, w, h } = prepare(svgEl, background)
  const blob = new Blob([serialize(clone)], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  try {
    const img = new Image()
    img.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not rasterize the diagram'))
      img.src = url
    })

    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = w * scale
    canvas.height = h * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas is unavailable')
    // PNG over a transparent background is unreadable in either theme once it
    // lands on someone's white slide, so the theme's surface is painted in.
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (png) save(png, `${filename}.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
