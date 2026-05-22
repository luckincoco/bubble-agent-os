import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { logger, setLogLevel } from '../src/shared/logger.js'

describe('logger', () => {
  let consoleCalls: unknown[][]

  beforeEach(() => {
    consoleCalls = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setLogLevel('info') // reset to default
  })

  it('suppresses debug at default info level', () => {
    logger.debug('should not appear')
    expect(consoleCalls).toHaveLength(0)
  })

  it('logs info at default info level', () => {
    logger.info('hello')
    expect(consoleCalls).toHaveLength(1)
  })

  it('logs warn at default info level', () => {
    logger.warn('caution')
    expect(consoleCalls).toHaveLength(1)
  })

  it('logs error at default info level', () => {
    logger.error('fail')
    expect(consoleCalls).toHaveLength(1)
  })

  it('includes colored level tag and message', () => {
    logger.info('test message')
    expect(consoleCalls[0][0]).toContain('[INFO]')
    expect(consoleCalls[0][1]).toBe('test message')
  })

  it('setLogLevel(debug) enables debug output', () => {
    setLogLevel('debug')
    logger.debug('verbose')
    expect(consoleCalls).toHaveLength(1)
    expect(consoleCalls[0][1]).toBe('verbose')
  })

  it('setLogLevel(warn) suppresses info', () => {
    setLogLevel('warn')
    logger.info('should not appear')
    expect(consoleCalls).toHaveLength(0)
  })

  it('setLogLevel(error) suppresses warn', () => {
    setLogLevel('error')
    logger.warn('should not appear')
    expect(consoleCalls).toHaveLength(0)
  })

  it('error still logs at error level', () => {
    setLogLevel('error')
    logger.error('still shown')
    expect(consoleCalls).toHaveLength(1)
  })

  it('passes multiple arguments through', () => {
    logger.info('a', 42, { key: 'val' })
    expect(consoleCalls[0][1]).toBe('a')
    expect(consoleCalls[0][2]).toBe(42)
    expect(consoleCalls[0][3]).toEqual({ key: 'val' })
  })
})
