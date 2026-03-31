import { ulid } from 'ulid'
import type { CustomAgent } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'

interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt: string
  avatar?: string
  tools?: string[]
  spaceIds?: string[]
  creatorId: string
}

function rowToAgent(row: any): CustomAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    systemPrompt: row.system_prompt,
    avatar: row.avatar || '',
    tools: JSON.parse(row.tools || '[]'),
    spaceIds: JSON.parse(row.space_ids || '[]'),
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createAgent(input: CreateAgentInput): CustomAgent {
  const db = getDatabase()
  const now = Date.now()
  const id = ulid()

  db.prepare(`
    INSERT INTO custom_agents (id, name, description, system_prompt, avatar, tools, space_ids, creator_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description || '',
    input.systemPrompt,
    input.avatar || '',
    JSON.stringify(input.tools || []),
    JSON.stringify(input.spaceIds || []),
    input.creatorId,
    now,
    now,
  )

  return { id, name: input.name, description: input.description || '', systemPrompt: input.systemPrompt, avatar: input.avatar || '', tools: input.tools || [], spaceIds: input.spaceIds || [], creatorId: input.creatorId, createdAt: now, updatedAt: now }
}

export function getAgent(id: string): CustomAgent | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM custom_agents WHERE id = ?').get(id) as any
  return row ? rowToAgent(row) : null
}

export function listAgents(creatorId?: string, spaceIds?: string[]): CustomAgent[] {
  const db = getDatabase()
  // Return agents created by the user, or agents whose space_ids overlap with user's spaces
  const rows = db.prepare('SELECT * FROM custom_agents ORDER BY updated_at DESC').all() as any[]

  return rows.filter(row => {
    // System-created agents (e.g., "问") are visible to all users
    if (row.creator_id === 'system') return true
    if (creatorId && row.creator_id === creatorId) return true
    if (spaceIds?.length) {
      const agentSpaces: string[] = JSON.parse(row.space_ids || '[]')
      if (agentSpaces.some(s => spaceIds.includes(s))) return true
    }
    return false
  }).map(rowToAgent)
}

export function updateAgent(id: string, updates: Partial<Pick<CustomAgent, 'name' | 'description' | 'systemPrompt' | 'avatar' | 'tools' | 'spaceIds'>>): boolean {
  const db = getDatabase()
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [Date.now()]

  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name) }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description) }
  if (updates.systemPrompt !== undefined) { sets.push('system_prompt = ?'); params.push(updates.systemPrompt) }
  if (updates.avatar !== undefined) { sets.push('avatar = ?'); params.push(updates.avatar) }
  if (updates.tools !== undefined) { sets.push('tools = ?'); params.push(JSON.stringify(updates.tools)) }
  if (updates.spaceIds !== undefined) { sets.push('space_ids = ?'); params.push(JSON.stringify(updates.spaceIds)) }

  params.push(id)
  const result = db.prepare(`UPDATE custom_agents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return result.changes > 0
}

export function deleteAgent(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM custom_agents WHERE id = ?').run(id)
  return result.changes > 0
}
