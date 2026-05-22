import { useModuleStore } from '../../stores/moduleStore'
import type { CognitivePanelProps } from '../../modules/registry'

interface PanelDispatcherProps {
  moduleId: string
  cognitionLayer: string
  data: unknown
  spaceId: string
}

/**
 * Dispatches panel rendering to the module's registered cognitive renderer.
 * Returns null if no renderer is registered for the given layer.
 */
export function CognitivePanel({ moduleId, cognitionLayer, data, spaceId }: PanelDispatcherProps) {
  const modules = useModuleStore((s) => s.registeredModules)
  const mod = modules.find((m) => m.id === moduleId)
  const renderer = mod?.cognitiveRenderers?.[cognitionLayer as keyof typeof mod.cognitiveRenderers]

  if (!renderer) return null

  const Renderer = renderer
  return (
    <Renderer
      data={data}
      context={{ spaceId }}
    />
  )
}
