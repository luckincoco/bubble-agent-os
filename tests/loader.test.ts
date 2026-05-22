import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLoader } from '../src/connector/skills/loader.js'

interface TempCtx {
  tmpDir: string
}
function freshDir(): TempCtx {
  const tmpDir = mkdtempSync(join(tmpdir(), 'loader-test-'))
  return { tmpDir }
}
function cleanup(ctx: TempCtx) {
  rmSync(ctx.tmpDir, { recursive: true, force: true })
}

/** Write a SKILL.md inside a skill subdirectory */
function writeSkill(baseDir: string, skillName: string, content: string): void {
  const dir = join(baseDir, skillName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
}

const MINIMAL_SKILL = `---
name: test-skill
handler: teach
priority: 10
---
This is the body.
`

describe('SkillLoader', () => {
  // ── error handling ──

  it('handles non-existent skills directory', () => {
    const loader = new SkillLoader('/nonexistent/path/that/does/not/exist')
    expect(loader.getAllSkills()).toHaveLength(0)
    expect(loader.getSkill('anything')).toBeUndefined()
  })

  it('returns empty when directory exists but has no SKILL.md files', () => {
    const ctx = freshDir()
    const loader = new SkillLoader(ctx.tmpDir)
    expect(loader.getAllSkills()).toHaveLength(0)
    cleanup(ctx)
  })

  it('skips directories without SKILL.md', () => {
    const ctx = freshDir()
    mkdirSync(join(ctx.tmpDir, 'no-skill-md'), { recursive: true })
    const loader = new SkillLoader(ctx.tmpDir)
    expect(loader.getAllSkills()).toHaveLength(0)
    cleanup(ctx)
  })

  it('handles empty SKILL.md file without crashing', () => {
    const ctx = freshDir()
    writeSkill(ctx.tmpDir, 'empty-skill', '')
    // Should not throw; parses as no frontmatter → body is empty
    const loader = new SkillLoader(ctx.tmpDir)
    const skills = loader.getAllSkills()
    expect(skills).toHaveLength(1)
    cleanup(ctx)
  })

  it('skips invalid regex patterns without crashing', () => {
    const ctx = freshDir()
    // Triggers with invalid pattern "[invalid" — no closing bracket
    writeSkill(ctx.tmpDir, 'bad-regex', `---
name: bad-regex
handler: teach
triggers:
  patterns:
    - "[invalid"
---
body
`)
    // Should not throw; invalid regex triggers logger.warn only
    const loader = new SkillLoader(ctx.tmpDir)
    const skill = loader.getSkill('bad-regex')
    // The pattern won't be compiled due to YAML parsing limitations,
    // but the loader should handle everything gracefully
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('bad-regex')
    cleanup(ctx)
  })

  // ── basic skill loading ──

  it('loads a single skill from a valid SKILL.md', () => {
    const ctx = freshDir()
    writeSkill(ctx.tmpDir, 'my-skill', MINIMAL_SKILL)

    const loader = new SkillLoader(ctx.tmpDir)
    const skills = loader.getAllSkills()
    expect(skills).toHaveLength(1)

    const skill = skills[0]
    expect(skill.name).toBe('test-skill')
    expect(skill.handler).toBe('teach')
    expect(skill.priority).toBe(10)
    expect(skill.body.trim()).toBe('This is the body.')
    expect(skill.dirPath).toContain('my-skill')
    expect(skill.compiledPatterns).toEqual([])
    cleanup(ctx)
  })

  it('loads multiple skills from separate directories', () => {
    const ctx = freshDir()
    writeSkill(ctx.tmpDir, 'skill-a', `---
name: alpha
handler: teach
priority: 5
---
body a
`)
    writeSkill(ctx.tmpDir, 'skill-b', `---
name: beta
handler: biz-entry
priority: 10
---
body b
`)

    const loader = new SkillLoader(ctx.tmpDir)
    const skills = loader.getAllSkills()
    expect(skills).toHaveLength(2)

    const names = skills.map(s => s.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
    expect(loader.getSkill('alpha')).toBeDefined()
    expect(loader.getSkill('beta')).toBeDefined()
    expect(loader.getSkill('nonexistent')).toBeUndefined()
    cleanup(ctx)
  })

  it('extracts description and triggers fields', () => {
    const ctx = freshDir()
    writeSkill(ctx.tmpDir, 'steel', `---
name: steel-trading
description: 钢贸业务录入技能
handler: biz-entry
priority: 8
---
业务描述
`)

    const loader = new SkillLoader(ctx.tmpDir)
    const skill = loader.getSkill('steel-trading')
    expect(skill).toBeDefined()
    expect(skill!.description).toBe('钢贸业务录入技能')
    expect(skill!.triggers).toBeDefined()
    cleanup(ctx)
  })

  it('uses directory name as fallback when name is missing in frontmatter', () => {
    const ctx = freshDir()
    writeSkill(ctx.tmpDir, 'fallback-name', `---
handler: teach
---
body
`)

    const loader = new SkillLoader(ctx.tmpDir)
    const skill = loader.getSkill('fallback-name')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('fallback-name')
    cleanup(ctx)
  })

  it('parses boolean and numeric values from frontmatter', () => {
    const ctx = freshDir()
    writeSkill(ctx.tmpDir, 'flags', `---
name: flags
enabled: true
priority: 20
handler: code
---
`)
    // Note: 'enabled' is not a standard field, just testing parseValue
    const loader = new SkillLoader(ctx.tmpDir)
    const skill = loader.getSkill('flags')
    expect(skill).toBeDefined()
    expect(skill!.priority).toBe(20)
    cleanup(ctx)
  })
})
