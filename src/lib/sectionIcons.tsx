import type { IconType } from 'react-icons'
import { SiPython, SiDjango, SiFastapi, SiPostgresql, SiCelery, SiRedis, SiDocker } from 'react-icons/si'
import {
  LuPlug,
  LuGlobe,
  LuShieldCheck,
  LuFlaskConical,
  LuFolder,
  LuNetwork,
  LuUsers,
  LuCreditCard,
} from 'react-icons/lu'

// Professional section icons (replaces the emoji in SECTION_META). Real brand
// marks where they exist (react-icons/si), a Lucide line icon otherwise. Line
// icons ride the site accent. The single place to touch when adding a section.
//
// Brand colors resolve through CSS variables rather than literal hexes because
// they have to work on both canvases: the true brand mid-tones are legible on
// the dark surface but drop to ~2.2-3.0:1 on white. src/styles/index.css defines
// a darkened light-theme variant per brand — see --brand-* in both theme blocks.

export interface SectionIcon {
  Icon: IconType
  color: string
}

const ACCENT = 'var(--accent)'

const SECTION_ICONS: Record<string, SectionIcon> = {
  python: { Icon: SiPython, color: 'var(--brand-python)' },
  django: { Icon: SiDjango, color: 'var(--brand-django)' },
  drf: { Icon: LuPlug, color: ACCENT },
  fastapi: { Icon: SiFastapi, color: 'var(--brand-fastapi)' },
  databases: { Icon: SiPostgresql, color: 'var(--brand-databases)' },
  'task-processing': { Icon: SiCelery, color: 'var(--brand-celery)' },
  caching: { Icon: SiRedis, color: 'var(--brand-redis)' },
  'api-design': { Icon: LuGlobe, color: ACCENT },
  devops: { Icon: SiDocker, color: 'var(--brand-docker)' },
  security: { Icon: LuShieldCheck, color: ACCENT },
  testing: { Icon: LuFlaskConical, color: ACCENT },
  payments: { Icon: LuCreditCard, color: ACCENT },
  'system-design': { Icon: LuNetwork, color: ACCENT },
  behavioral: { Icon: LuUsers, color: ACCENT },
}

export function sectionIcon(slug: string): SectionIcon {
  return SECTION_ICONS[slug] ?? { Icon: LuFolder, color: ACCENT }
}
