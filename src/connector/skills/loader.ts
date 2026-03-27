/**
 * SkillLoader — scans skills/ directory and parses SKILL.md files.
 * Each skill has YAML frontmatter with name, description, triggers, handler, priority.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { logger } from '../../shared/logger.js'

export interface SkillTriggers {
  patterns?: string[]
  keywords?: string[]
}

export interface SkillDefinition {
  name: string
  description: string
  triggers: SkillTriggers
  handler: string
  priority: number
  body: string
  dirPath: string
  // Compiled regex patterns for fast matching
  compiledPatterns: RegExp[]
}

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Supports a subset of YAML: scalar values, arrays (- item), and nested objects (one level).
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const yamlBlock = match[1]
  const body = match[2]
  const meta: Record<string, unknown> = {}

  let currentKey = ''
  let currentArray: string[] | null = null

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // Array item
    if (trimmed.startsWith('- ')) {
      if (currentArray) {
        currentArray.push(trimmed.slice(2).replace(/^["']|["']$/g, ''))
      }
      continue
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    // Flush previous array
    if (currentArray && currentKey) {
      meta[currentKey] = currentArray
      currentArray = null
    }

    const key = trimmed.slice(0, colonIdx).trim()
    const rawValue = trimmed.slice(colonIdx + 1).trim()

    // Nested object detection (indented keys under a parent)
    if (line.startsWith('    ') || line.startsWith('\t\t')) {
      // Nested key under currentKey
      if (currentKey && typeof meta[currentKey] === 'object' && !Array.isArray(meta[currentKey])) {
        ;(meta[currentKey] as Record<string, unknown>)[key] = parseValue(rawValue)
      }
      continue
    }

    currentKey = key

    if (rawValue === '') {
      // Could be start of array or nested object
      currentArray = []
      meta[key] = {}
    } else {
      currentArray = null
      meta[key] = parseValue(rawValue)
    }
  }

  // Flush final array
  if (currentArray && currentKey) {
    meta[currentKey] = currentArray
  }

  return { meta, body }
}

function parseValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const num = Number(raw)
  if (!isNaN(num) && raw !== '') return num
  return raw.replace(/^["']|["']$/g, '')
}

export class SkillLoader {
  private skills = new Map<string, SkillDefinition>()

  constructor(skillsDir: string) {
    this.loadSkills(skillsDir)
  }

  private loadSkills(skillsDir: string) {
    if (!existsSync(skillsDir)) {
      logger.debug(`SkillLoader: skills directory not found: ${skillsDir}`)
      return
    }

    const entries = readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = join(skillsDir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        const { meta, body } = parseFrontmatter(content)

        const triggers = meta.triggers as SkillTriggers | undefined
        const compiledPatterns: RegExp[] = []
        if (triggers?.patterns) {
          for (const p of triggers.patterns) {
            try {
              compiledPatterns.push(new RegExp(p))
            } catch {
              logger.warn(`SkillLoader: invalid pattern "${p}" in skill ${entry.name}`)
            }
          }
        }

        const skill: SkillDefinition = {
          name: (meta.name as string) || entry.name,
          description: (meta.description as string) || '',
          triggers: triggers || {},
          handler: (meta.handler as string) || '',
          priority: (meta.priority as number) || 0,
          body,
          dirPath: resolve(skillsDir, entry.name),
          compiledPatterns,
        }

        this.skills.set(skill.name, skill)
        logger.info(`SkillLoader: loaded skill "${skill.name}" (priority=${skill.priority}, patterns=${compiledPatterns.length}, keywords=${triggers?.keywords?.length || 0})`)
      } catch (err) {
        logger.error(`SkillLoader: failed to load ${skillMdPath}:`, err instanceof Error ? err.message : String(err))
      }
    }

    logger.info(`SkillLoader: ${this.skills.size} skill(s) loaded`)
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  getAllSkills(): SkillDefinition[] {
    return [...this.skills.values()]
  }
}
