/**
 * EntityExtractor — LLM-powered extraction of semantic entities and temporal relations
 * from Episode content. Converts raw conversations/events into structured knowledge graph nodes.
 */

import type { LLMProvider } from '../shared/types.js'
import { createBubble } from '../bubble/model.js'
import { createTemporalLink, resolveContradiction } from './temporal-linker.js'
import { logger } from '../shared/logger.js'
import type { Episode } from './episode-store.js'

const ENTITY_EXTRACTION_PROMPT = `You are an entity and relationship extractor for a steel trading business.
Given a conversation or business event, extract:
1. Named entities (people, companies, products, projects, locations)
2. Relationships between entities (supplies, buys_from, transports_for, works_at)
3. Facts with temporal validity (prices, statuses, agreements)

Output JSON only:
{
  "entities": [
    { "name": "string", "type": "person|company|product|project|location", "attributes": {} }
  ],
  "relations": [
    { "source": "entity_name", "target": "entity_name", "relation": "string", "temporal": true|false }
  ],
  "facts": [
    { "subject": "entity_name", "predicate": "string", "object": "string", "temporal": true }
  ]
}

Context: Steel trading (钢贸) domain. Entities include: steel mills, trading companies, construction sites, drivers, products (螺纹钢, 线材, 盘螺, 板材).
If the content contains no extractable entities, return { "entities": [], "relations": [], "facts": [] }.
Be conservative — only extract clearly stated information, not inferences.`

export interface ExtractedEntity {
  name: string
  type: 'person' | 'company' | 'product' | 'project' | 'location'
  attributes: Record<string, unknown>
}

export interface ExtractedRelation {
  source: string
  target: string
  relation: string
  temporal: boolean
}

export interface ExtractedFact {
  subject: string
  predicate: string
  object: string
  temporal: boolean
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
  facts: ExtractedFact[]
}

export class EntityExtractor {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  /**
   * Extract entities and relations from an episode.
   * Creates bubbles for new entities and temporal links for relations.
   */
  async extractFromEpisode(episode: Episode, spaceId: string): Promise<{ entitiesCreated: number; linksCreated: number }> {
    // Skip very short content
    if (episode.content.length < 20) return { entitiesCreated: 0, linksCreated: 0 }

    let result: ExtractionResult
    try {
      result = await this.extract(episode.content)
    } catch (err) {
      logger.warn(`EntityExtractor: LLM extraction failed for episode ${episode.id}: ${err}`)
      return { entitiesCreated: 0, linksCreated: 0 }
    }

    if (result.entities.length === 0 && result.relations.length === 0 && result.facts.length === 0) {
      return { entitiesCreated: 0, linksCreated: 0 }
    }

    let entitiesCreated = 0
    let linksCreated = 0

    // Create entity bubbles (or find existing ones)
    const entityBubbleMap = new Map<string, string>()  // name → bubbleId
    for (const entity of result.entities) {
      const bubbleId = await this.findOrCreateEntityBubble(entity, spaceId, episode.id)
      if (bubbleId) {
        entityBubbleMap.set(entity.name, bubbleId)
        entitiesCreated++
      }
    }

    // Create temporal links for relations
    for (const rel of result.relations) {
      const sourceId = entityBubbleMap.get(rel.source)
      const targetId = entityBubbleMap.get(rel.target)
      if (!sourceId || !targetId) continue

      // Check for contradiction and resolve if needed
      const resolved = resolveContradiction({
        sourceId,
        targetId,
        relation: rel.relation,
        episodeId: episode.id,
        validFrom: episode.createdAt,
        linkSource: 'entity-extractor',
      })

      if (!resolved) {
        // No contradiction — create the link directly
        createTemporalLink({
          sourceId,
          targetId,
          relation: rel.relation,
          episodeId: episode.id,
          validFrom: episode.createdAt,
          linkSource: 'entity-extractor',
        })
      }
      linksCreated++
    }

    // Create fact bubbles with temporal links
    for (const fact of result.facts) {
      const subjectId = entityBubbleMap.get(fact.subject)
      if (!subjectId) continue

      const factBubble = createBubble({
        type: 'memory',
        title: `${fact.subject}: ${fact.predicate}`,
        content: `${fact.subject} ${fact.predicate} ${fact.object}`,
        tags: ['fact', 'extracted'],
        source: 'entity-extractor',
        confidence: 0.7,
        spaceId,
        validFrom: episode.createdAt,
        episodeId: episode.id,
      })

      createTemporalLink({
        sourceId: subjectId,
        targetId: factBubble.id,
        relation: fact.predicate,
        episodeId: episode.id,
        validFrom: episode.createdAt,
        linkSource: 'entity-extractor',
      })
      linksCreated++
    }

    logger.info(`EntityExtractor: episode ${episode.id} → ${entitiesCreated} entities, ${linksCreated} links`)
    return { entitiesCreated, linksCreated }
  }

  /**
   * Raw LLM extraction (no side effects).
   */
  async extract(content: string): Promise<ExtractionResult> {
    const response = await this.llm.chat([
      { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
      { role: 'user', content },
    ])

    try {
      // Try to parse JSON from response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { entities: [], relations: [], facts: [] }
      const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult
      return {
        entities: parsed.entities || [],
        relations: parsed.relations || [],
        facts: parsed.facts || [],
      }
    } catch {
      logger.warn('EntityExtractor: failed to parse LLM response as JSON')
      return { entities: [], relations: [], facts: [] }
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private async findOrCreateEntityBubble(entity: ExtractedEntity, spaceId: string, episodeId: string): Promise<string | null> {
    const { getDatabase } = await import('../storage/database.js')
    const db = getDatabase()

    // Search for existing entity bubble with same title
    const existing = db.prepare(
      "SELECT id FROM bubbles WHERE type = 'entity' AND title = ? AND space_id = ? AND (valid_until IS NULL) LIMIT 1"
    ).get(entity.name, spaceId) as { id: string } | undefined

    if (existing) return existing.id

    // Create new entity bubble
    const bubble = createBubble({
      type: 'entity',
      title: entity.name,
      content: `${entity.type}: ${entity.name}${Object.keys(entity.attributes).length > 0 ? '\n' + JSON.stringify(entity.attributes) : ''}`,
      tags: ['entity', entity.type],
      source: 'entity-extractor',
      confidence: 0.8,
      spaceId,
      validFrom: Date.now(),
      episodeId,
      metadata: { entityType: entity.type, ...entity.attributes },
    })

    return bubble.id
  }
}
