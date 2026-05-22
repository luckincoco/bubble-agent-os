import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SemanticBridge } from '../src/memory/semantic-bridge.js'

const mockSearchBubbles = vi.fn()
const mockAddLink = vi.fn()
const mockUpdateBubble = vi.fn()

vi.mock('../src/bubble/model.js', () => ({
  searchBubbles: (...args: unknown[]) => mockSearchBubbles(...args),
  updateBubble: (...args: unknown[]) => mockUpdateBubble(...args),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: (...args: unknown[]) => mockAddLink(...args),
}))

const bridge = new SemanticBridge()

beforeEach(() => {
  vi.clearAllMocks()
})

// ── 实体列识别 ────────────────────────────────────────────────────

describe('bridgeExcelImport — 实体列识别', () => {
  it('无实体列时提前返回', async () => {
    const rows = [{ 数量: 10 }]
    await bridge.bridgeExcelImport(['b1'], rows, ['数量'], 's1')

    expect(mockSearchBubbles).not.toHaveBeenCalled()
    expect(mockAddLink).not.toHaveBeenCalled()
  })

  it('空 rows 时跳过', async () => {
    await bridge.bridgeExcelImport(['b1'], [], ['供应商'], 's1')

    expect(mockSearchBubbles).not.toHaveBeenCalled()
    expect(mockAddLink).not.toHaveBeenCalled()
  })
})

// ── 实体值收集 ────────────────────────────────────────────────────

describe('bridgeExcelImport — 实体值收集', () => {
  it('短名称 (< 2 字符) 被过滤', async () => {
    const rows = [{ 供应商: 'A' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    // 'A' is length 1, filtered out → no entities → early return
    expect(mockSearchBubbles).not.toHaveBeenCalled()
  })

  it('非字符串值转为 String', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'existing-1' }])
    const rows = [{ 供应商: 10086 }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    expect(mockSearchBubbles).toHaveBeenCalledWith('10086', 5, undefined)
  })
})

// ── 搜索与链接 ────────────────────────────────────────────────────

describe('bridgeExcelImport — 搜索与链接', () => {
  it('匹配已有 bubble 创建 related 链接', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'existing-1' }])
    const rows = [{ 供应商: '北京科技' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    expect(mockAddLink).toHaveBeenCalledWith('b1', 'existing-1', 'related', 0.7, 'inferred')
    // summaryId also linked
    expect(mockAddLink).toHaveBeenCalledWith('s1', 'existing-1', 'related', 0.7, 'inferred')
  })

  it('新增 bubble 不在匹配结果中 (newIdSet 排除)', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'b1' }]) // b1 is in newIdSet
    const rows = [{ 供应商: '北京科技' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    // b1 is excluded via newIdSet → no links created
    expect(mockAddLink).not.toHaveBeenCalled()
  })

  it('每个实体只链接最佳匹配 (break)', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 'match-1' },
      { id: 'match-2' },
    ])
    const rows = [{ 供应商: '北京科技' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    // Only match-1 is linked, match-2 is skipped via break
    expect(mockAddLink).toHaveBeenCalledWith('b1', 'match-1', 'related', 0.7, 'inferred')
    expect(mockAddLink).not.toHaveBeenCalledWith('b1', 'match-2', 'related', 0.7, 'inferred')
  })

  it('多个实体列同时匹配', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'existing-1' }])
    const rows = [{ 供应商: '科技公司', 客户: '某集团' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商', '客户'], 's1')

    // Two entities (2 searches) + summary update (1 search) = 3
    expect(mockSearchBubbles).toHaveBeenCalledTimes(3)
    expect(mockAddLink).toHaveBeenCalled()
  })

  it('pass spaceId to searchBubbles', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'existing-1' }])
    const rows = [{ 供应商: '北京科技' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1', 'space-1')

    expect(mockSearchBubbles).toHaveBeenCalledWith('北京科技', 5, ['space-1'])
  })
})

// ── Summary 更新 ──────────────────────────────────────────────────

describe('bridgeExcelImport — Summary 更新', () => {
  it('链接触发 summary 内容追加', async () => {
    mockSearchBubbles
      .mockReturnValueOnce([{ id: 'existing-1' }]) // entity search
      .mockReturnValueOnce([{ id: 's1', content: '总览' }]) // summary search via updateBubble

    const rows = [{ 供应商: '北京科技' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    expect(mockUpdateBubble).toHaveBeenCalledWith('s1', {
      content: expect.stringContaining('[语义桥]'),
    })
  })

  it('无链接时不更新 summary', async () => {
    mockSearchBubbles.mockReturnValue([]) // no matches
    const rows = [{ 供应商: '北京科技' }]
    await bridge.bridgeExcelImport(['b1'], rows, ['供应商'], 's1')

    expect(mockUpdateBubble).not.toHaveBeenCalled()
  })
})
