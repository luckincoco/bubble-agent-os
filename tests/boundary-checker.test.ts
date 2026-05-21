import { describe, it, expect } from 'vitest'
import { checkBoundary, declareReversible, isReversible, addToWhitelist, removeFromWhitelist, getWhitelist } from '../src/connector/boundary-checker.js'

describe('BoundaryChecker — 白名单', () => {
  it('白名单工具直接放行', () => {
    const result = checkBoundary('web_search', { query: 'test' })
    expect(result.decision).toBe('allow')
    expect(result.source).toBe('whitelist')
  })

  it('memory_search 在白名单中', () => {
    expect(checkBoundary('memory_search', {}).decision).toBe('allow')
  })

  it('get_time 在白名单中', () => {
    expect(checkBoundary('get_time', {}).decision).toBe('allow')
  })
})

describe('BoundaryChecker — 硬规则 deny', () => {
  it('禁止文件系统 rm 操作', () => {
    const result = checkBoundary('exec_code', { code: 'rm -rf /' })
    expect(result.decision).toBe('deny')
    expect(result.triggeredRule).toBe('deny-file-system-access')
    expect(result.riskLevel).toBe('high')
  })

  it('禁止 dd 命令', () => {
    const result = checkBoundary('run_command', { command: 'dd if=/dev/zero of=/dev/sda' })
    expect(result.decision).toBe('deny')
  })

  it('普通命令不触发 deny', () => {
    const result = checkBoundary('exec_code', { code: 'ls -la' })
    expect(result.decision).not.toBe('deny')
  })

  it('禁止自演化核心路径', () => {
    const result = checkBoundary('self_evolve', { changes: [{ file: 'src/kernel/brain.ts' }] })
    expect(result.decision).toBe('deny')
    expect(result.triggeredRule).toBe('deny-core-path-evolution')
  })

  it('非核心路径的自演化允许', () => {
    const result = checkBoundary('self_evolve', { changes: [{ file: 'src/connector/tools/weather.ts' }] })
    expect(result.decision).not.toBe('deny')
  })
})

describe('BoundaryChecker — 硬规则 confirm', () => {
  it('biz_delete 需要确认', () => {
    const result = checkBoundary('biz_delete', { id: '123' })
    expect(result.decision).toBe('confirm')
    expect(result.riskLevel).toBe('high')
  })

  it('biz_create 不需要确认', () => {
    const result = checkBoundary('biz_create', { name: 'test' })
    expect(result.decision).not.toBe('confirm')
  })

  it('高 token 消耗需确认（非白名单工具）', () => {
    const result = checkBoundary('biz_create', { name: 'test', _estimatedTokens: 6000 })
    expect(result.decision).toBe('confirm')
    expect(result.triggeredRule).toBe('token-cost-threshold')
  })

  it('低 token 消耗不触发', () => {
    const result = checkBoundary('biz_create', { name: 'test', _estimatedTokens: 1000 })
    expect(result.decision).not.toBe('confirm')
  })
})

describe('BoundaryChecker — 工具可逆性', () => {
  it('默认不可逆（零信任）', () => {
    expect(isReversible('unknown_tool')).toBe(false)
  })

  it('声明后变为可逆', () => {
    declareReversible('test_tool')
    expect(isReversible('test_tool')).toBe(true)
  })
})

describe('BoundaryChecker — 白名单管理', () => {
  it('初始白名单包含常用工具', () => {
    const list = getWhitelist()
    expect(list).toContain('web_search')
    expect(list).toContain('memory_search')
    expect(list).toContain('get_time')
  })

  it('动态添加移除', () => {
    addToWhitelist('temp_tool')
    expect(getWhitelist()).toContain('temp_tool')

    removeFromWhitelist('temp_tool')
    expect(getWhitelist()).not.toContain('temp_tool')
  })
})

describe('BoundaryChecker — 未匹配规则时放行', () => {
  it('非白名单非规则工具返回 allow', () => {
    const result = checkBoundary('custom_tool', {})
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('无规则命中')
  })

  it('空参数不触发规则', () => {
    const result = checkBoundary('exec_code', {})
    expect(result.decision).toBe('allow')
  })
})
