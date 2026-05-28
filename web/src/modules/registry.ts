import type { ComponentType } from 'react'
import type { CognitionLayer, ToolDescriptor } from '../types'
import { ChatView } from '../components/chat/ChatView'
import { KnowledgeBrowser } from '../components/knowledge/KnowledgeBrowser'
import { BusinessFlow } from '../components/biz/BusinessFlow'
import { ForgeManager } from '../components/forge/ForgeManager'
import { FeedbackDashboard } from '../components/feedback/FeedbackDashboard'
import { ObservationCard } from '../components/biz/ObservationCard'

export interface ModuleDefinition {
  id: string
  tab: {
    key: string
    label: string
    icon: string   // SVG path d
    order: number  // smaller = more left
  }
  locked: boolean  // true = core module, cannot be disabled
  onboarding?: {
    emoji: string
    title: string
    description: string
  }
  component: ComponentType

  // ── Phase 1: Module registration system (optional, backward-compatible) ──

  /** Tools registered by this module that the Agent can call */
  tools?: ToolDescriptor[]

  /** Phase 2: cognitive panel renderers keyed by cognition layer */
  cognitiveRenderers?: Partial<Record<CognitionLayer, ComponentType<CognitivePanelProps>>>

  /** Context providers that inject space/business context into Agent */
  contextProviders?: Array<{
    key: string
    provide: () => string
  }>

  /** MCP server connections (Phase 4) */
  mcpServers?: Array<{
    name: string
    url: string
  }>
}

/** Context passed to cognitive renderers */
export interface RenderContext {
  spaceId: string
  onAgentCall?: (prompt: string) => void
}

/** Props for a cognitive panel renderer component */
export interface CognitivePanelProps {
  data: unknown
  context: RenderContext
}

const MODULES: ModuleDefinition[] = [
  {
    id: 'biz',
    tab: {
      key: 'biz',
      label: '业务',
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
      order: 10,
    },
    locked: false,
    onboarding: {
      emoji: '\u{1F4CA}',
      title: '\u{4E1A}\u{52A1}\u{7BA1}\u{7406}',
      description: '\u{91C7}\u{8D2D}\u{3001}\u{9500}\u{552E}\u{3001}\u{7269}\u{6D41}\u{3001}\u{6536}\u{4ED8}\u{6B3E}\u{3001}\u{53D1}\u{7968}\u{3001}\u{5BF9}\u{8D26}',
    },
    component: BusinessFlow,
    // Phase 2: cognitive panel renderer demo
    cognitiveRenderers: {
      observation: ObservationCard,
    },
  },
  {
    id: 'chat',
    tab: {
      key: 'chat',
      label: 'AI',
      icon: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
      order: 30,
    },
    locked: true,
    component: ChatView,
  },
  {
    id: 'knowledge',
    tab: {
      key: 'memory',
      label: '知识',
      icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 8a4 4 0 100 8 4 4 0 000-8z',
      order: 40,
    },
    locked: true,
    component: KnowledgeBrowser,
  },
  {
    id: 'feedback',
    tab: {
      key: 'feedback',
      label: '反馈',
      icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
      order: 45,
    },
    locked: false,
    component: FeedbackDashboard,
  },
  {
    id: 'forge',
    tab: {
      key: 'forge',
      label: '自编码',
      icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
      order: 50,
    },
    locked: true,
    component: ForgeManager,
  },
]

export function getAllModules(): ModuleDefinition[] {
  return MODULES
}

export function getCoreModules(): ModuleDefinition[] {
  return MODULES.filter(m => m.locked)
}

export function getOptionalModules(): ModuleDefinition[] {
  return MODULES.filter(m => !m.locked)
}

export function getModuleById(id: string): ModuleDefinition | undefined {
  return MODULES.find(m => m.id === id)
}

export function getVisibleModules(enabledIds: string[]): ModuleDefinition[] {
  const enabledSet = new Set(enabledIds)
  return MODULES
    .filter(m => m.locked || enabledSet.has(m.id))
    .sort((a, b) => a.tab.order - b.tab.order)
}

export function getDefaultEnabledIds(): string[] {
  return MODULES.filter(m => m.locked).map(m => m.id)
}
