// Display metadata for content sections (the folders under src/content/).
//
// A new folder works with ZERO config (it falls back to a prettified name and
// a default icon). Add an entry here only when you want a nicer label / icon /
// ordering. This is the single place to touch when adding a section.

export interface SectionMeta {
  label: string
  icon: string
  order: number
}

export const SECTION_META: Record<string, SectionMeta> = {
  python: { label: 'Python', icon: '🐍', order: 1 },
  django: { label: 'Django', icon: '🎸', order: 2 },
  drf: { label: 'DRF', icon: '🔌', order: 3 },
  fastapi: { label: 'FastAPI', icon: '⚡', order: 4 },
  databases: { label: 'Databases & SQL', icon: '🗄️', order: 5 },
  'task-processing': { label: 'Async & Task Processing', icon: '⚙️', order: 6 },
  caching: { label: 'Caching (Redis)', icon: '🔴', order: 7 },
  'api-design': { label: 'API Design & REST', icon: '🌐', order: 8 },
  devops: { label: 'AWS, Docker & DevOps', icon: '☁️', order: 9 },
  security: { label: 'Security', icon: '🛡️', order: 10 },
  testing: { label: 'Testing', icon: '🧪', order: 11 },
  // Domain section. Payments notes could live scattered across api-design /
  // task-processing / security, but grouped they read as the depth signal they
  // are for a fintech candidate, instead of being buried three sections deep.
  payments: { label: 'Payments & Fintech', icon: '💳', order: 12 },
  // Appended after the technical sections: by interview stage, system design and
  // behavioural rounds come after the fundamentals they build on.
  'system-design': { label: 'System Design', icon: '🏗️', order: 13 },
  behavioral: { label: 'Behavioral', icon: '💬', order: 14 },
  // Example for the future - just create the folder + (optionally) uncomment:
  // postgres: { label: 'PostgreSQL', icon: '🐘', order: 5 },
}

export function sectionMeta(slug: string): SectionMeta {
  const known = SECTION_META[slug]
  if (known) return known
  const label = slug
    .split(/[-_]/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
  return { label, icon: '📁', order: 99 }
}
