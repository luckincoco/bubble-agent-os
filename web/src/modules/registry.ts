import type { ComponentType } from 'react'
import { ChatView } from '../components/chat/ChatView'
import { MemoryPanel } from '../components/memory/MemoryPanel'
import { BusinessFlow } from '../components/biz/BusinessFlow'

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
      title: '业务管理',
      description: '采购、销售、物流、收付款、发票、对账',
    },
    component: BusinessFlow,
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
    id: 'memory',
    tab: {
      key: 'memory',
      label: '记忆',
      icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 8a4 4 0 100 8 4 4 0 000-8z',
      order: 40,
    },
    locked: true,
    component: MemoryPanel,
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
