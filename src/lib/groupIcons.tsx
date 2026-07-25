import type { IconType } from 'react-icons'
import {
  LuBraces,
  LuVariable,
  LuBoxes,
  LuInfinity,
  LuZap,
  LuDatabase,
  LuType,
  LuBug,
  LuHash,
  LuMessagesSquare,
  LuCompass,
  LuScale,
  LuWebhook,
  LuServer,
  LuKeyRound,
  LuShield,
  LuArrowLeftRight,
  LuLock,
  LuSlidersHorizontal,
  LuListChecks,
  LuWorkflow,
  LuBookOpen,
  LuGauge,
  LuArrowRightLeft,
  LuNetwork,
  LuInbox,
  LuRefreshCw,
  LuCalendarClock,
  LuLayers,
  LuBox,
  LuGlobe,
  LuPencilRuler,
  LuShieldCheck,
  LuContainer,
  LuCloud,
  LuActivity,
  LuShieldAlert,
  LuLockKeyhole,
  LuFlaskConical,
  LuBadgeCheck,
} from 'react-icons/lu'

// Icon per topic-group (shared by the home cards + sidebar group labels).
const GROUP_ICONS: Record<string, IconType> = {
  // Python
  'Language Basics': LuBraces,
  'Functions & Scope': LuVariable,
  OOP: LuBoxes,
  'Iterators & Generators': LuInfinity,
  Concurrency: LuZap,
  Memory: LuDatabase,
  Typing: LuType,
  Errors: LuBug,
  // Django
  'Core & Request Cycle': LuServer,
  'ORM & Database': LuDatabase,
  'Views & Auth': LuKeyRound,
  'Performance & Security': LuShield,
  // DRF
  'Serializers & Views': LuArrowLeftRight,
  'Auth & Permissions': LuLock,
  'API Controls': LuSlidersHorizontal,
  // FastAPI
  'Requests & Validation': LuListChecks,
  'Dependencies & Async': LuWorkflow,
  'Docs & Framework Choice': LuBookOpen,
  // Databases & SQL
  'Queries & Optimization': LuGauge,
  'Transactions & Concurrency': LuArrowRightLeft,
  'Schema & Scaling': LuNetwork,
  'Postgres & NoSQL': LuDatabase,
  // Async & Task Processing
  'Architecture & Brokers': LuInbox,
  Reliability: LuRefreshCw,
  'Scheduling & Frameworks': LuCalendarClock,
  // Caching (Redis)
  'Caching Patterns': LuLayers,
  'Redis in Practice': LuBox,
  // API Design & REST
  'REST Fundamentals': LuGlobe,
  'API Design': LuPencilRuler,
  'Security & Integration': LuShieldCheck,
  // AWS, Docker & DevOps
  Docker: LuContainer,
  AWS: LuCloud,
  'DevOps & Observability': LuActivity,
  // Security
  'Web Vulnerabilities': LuShieldAlert,
  'Access & Data Protection': LuLockKeyhole,
  // Testing
  'Test Types & Tools': LuFlaskConical,
  'Quality & Practice': LuBadgeCheck,
  // Payments & Fintech
  'Money Movement': LuArrowLeftRight,
  Integration: LuWebhook,
  Compliance: LuScale,
  // System Design
  'Design Fundamentals': LuCompass,
  'Classic Designs': LuNetwork,
  // Behavioral
  Framework: LuListChecks,
  'Story Bank': LuMessagesSquare,
}

export function groupIcon(name: string): IconType {
  return GROUP_ICONS[name] ?? LuHash
}
