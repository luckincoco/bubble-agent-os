import { create } from 'zustand'
import { getDefaultEnabledIds, getVisibleModules, getAllModules } from '../modules/registry'
import { updatePreferences } from '../services/api'
import type { UserPreferences } from '../types'
import type { ModuleDefinition } from '../modules/registry'

interface ModuleState {
  enabledModuleIds: string[]
  isLoaded: boolean

  // ── Phase 1: Module registry (backward-compatible) ──
  registeredModules: ModuleDefinition[]
  registerModule: (module: ModuleDefinition) => void
  unregisterModule: (moduleId: string) => void

  initFromPreferences: (prefs?: UserPreferences) => void
  toggleModule: (moduleId: string) => void
  setModules: (ids: string[]) => void
  reset: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveToServer(enabledModuleIds: string[]) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    updatePreferences({ enabledModules: enabledModuleIds }).catch(() => {
      // Silent fail — preferences are also cached locally
    })
  }, 500)
}

export const useModuleStore = create<ModuleState>((set, get) => ({
  enabledModuleIds: getDefaultEnabledIds(),
  isLoaded: false,

  // Phase 1: registry initialized from built-in modules
  registeredModules: getAllModules(),

  registerModule: (module) => {
    const { registeredModules } = get()
    if (registeredModules.find((m) => m.id === module.id)) return // no dupes
    set({ registeredModules: [...registeredModules, module] })
  },

  unregisterModule: (moduleId) => {
    set((s) => ({
      registeredModules: s.registeredModules.filter((m) => m.id !== moduleId),
    }))
  },

  initFromPreferences: (prefs) => {
    const defaultIds = getDefaultEnabledIds()
    const userIds = prefs?.enabledModules ?? []
    // Merge: always include locked (core) modules + user's selections
    const merged = [...new Set([...defaultIds, ...userIds])]
    set({ enabledModuleIds: merged, isLoaded: true })
  },

  toggleModule: (moduleId) => {
    const { enabledModuleIds } = get()
    // Don't allow toggling locked modules (they're always in defaultIds)
    const isEnabled = enabledModuleIds.includes(moduleId)
    const newIds = isEnabled
      ? enabledModuleIds.filter(id => id !== moduleId)
      : [...enabledModuleIds, moduleId]
    set({ enabledModuleIds: newIds })
    saveToServer(newIds)
  },

  setModules: (ids) => {
    const defaultIds = getDefaultEnabledIds()
    const merged = [...new Set([...defaultIds, ...ids])]
    set({ enabledModuleIds: merged })
    saveToServer(merged)
  },

  reset: () => {
    set({ enabledModuleIds: getDefaultEnabledIds(), isLoaded: false })
  },
}))

// Selector helper: get visible modules for current user
export function useVisibleModules() {
  const enabledIds = useModuleStore(s => s.enabledModuleIds)
  return getVisibleModules(enabledIds)
}
