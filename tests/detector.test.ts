import { describe, it, expect } from 'vitest'
import { detectTeachIntent } from '../src/connector/teach/detector.js'

describe('detectTeachIntent', () => {
  it('detects 记住 action', () => {
    const r = detectTeachIntent('泡泡记住：品牌A没有盘螺产品')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
    expect(r.bodyText).toBe('品牌A没有盘螺产品')
  })

  it('detects 注意 action with colon', () => {
    const r = detectTeachIntent('泡泡注意：项目B回款拖延')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('note')
    expect(r.bodyText).toBe('项目B回款拖延')
  })

  it('detects 更新 action', () => {
    const r = detectTeachIntent('泡泡更新: 供应商C联系人换成李总')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('update')
  })

  it('detects 忘记 action', () => {
    const r = detectTeachIntent('泡泡忘记: 品牌A没有盘螺')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('forget')
  })

  it('handles alternative verbs', () => {
    expect(detectTeachIntent('泡泡学习: 螺纹钢知识').action).toBe('remember')
    expect(detectTeachIntent('泡泡留意: 项目回款').action).toBe('note')
    expect(detectTeachIntent('泡泡修改: 供应商联系').action).toBe('update')
    expect(detectTeachIntent('泡泡删除: 品牌A信息').action).toBe('forget')
  })

  it('returns not detected for text without 泡泡', () => {
    const r = detectTeachIntent('记住：品牌A没有盘螺')
    expect(r.detected).toBe(false)
  })

  it('returns not detected for text shorter than 6 chars', () => {
    expect(detectTeachIntent('泡').detected).toBe(false)
    expect(detectTeachIntent('').detected).toBe(false)
  })

  it('returns not detected for text longer than 500 chars', () => {
    const long = '泡泡记住：' + 'x'.repeat(500)
    expect(detectTeachIntent(long).detected).toBe(false)
  })

  it('returns not detected for body text shorter than 4 chars', () => {
    const r = detectTeachIntent('泡泡记住: ab')
    expect(r.detected).toBe(false)
  })

  it('returns not detected when verb is unknown', () => {
    const r = detectTeachIntent('泡泡煮水：100度')
    expect(r.detected).toBe(false)
  })
})
