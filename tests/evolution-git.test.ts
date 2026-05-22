import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockExec = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))

// ── Module-level mocks ─────────────────────────────────────

vi.mock('node:child_process', () => ({ exec: mockExec }))
vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

// ── Imports ────────────────────────────────────────────────

import { gitStatus, gitCommitChanges, gitRevert, validateTypeCheck } from '../src/scheduler/tasks/evolution-git.js'

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════

/** Create an exec mock that calls back with success (null error, given stdout/stderr) */
function execOk(stdout = '', stderr = '') {
  return (_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, stdout, stderr)
  }
}

/** Create an exec mock that calls back with a failure (Error with code) */
function execFail(stderr = 'error', code = 1) {
  return (_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const err = new Error(stderr) as Error & { code: number }
    err.code = code
    cb(err, '', stderr)
  }
}

// ════════════════════════════════════════════════════════════
//  evolution-git functions
// ════════════════════════════════════════════════════════════

describe('gitStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty string when working tree is clean', async () => {
    mockExec.mockImplementation(execOk(''))
    const result = await gitStatus('/test/project')
    expect(result).toBe('')
    expect(mockExec).toHaveBeenCalledWith(
      'git status --porcelain',
      expect.objectContaining({ cwd: '/test/project' }),
      expect.any(Function),
    )
  })

  it('returns diff text when working tree is dirty', async () => {
    mockExec.mockImplementation(execOk('M src/foo.ts\n?? new-file.ts'))
    const result = await gitStatus('/test/project')
    expect(result).toBe('M src/foo.ts\n?? new-file.ts')
  })
})

describe('gitCommitChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success=false when add fails', async () => {
    mockExec
      .mockImplementationOnce(execOk('M foo.ts'))    // git status → dirty
      .mockImplementationOnce(execFail('add failed')) // git add → fail

    const result = await gitCommitChanges('/p', 'my change', 'b1')
    expect(result).toEqual({ hash: '', success: false })
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('add failed'))
  })

  it('returns success=false when commit fails', async () => {
    mockExec
      .mockImplementationOnce(execOk('M foo.ts'))      // git status → dirty
      .mockImplementationOnce(execOk())                 // git add → ok
      .mockImplementationOnce(execFail('commit failed')) // git commit → fail

    const result = await gitCommitChanges('/p', 'my change', 'b1')
    expect(result).toEqual({ hash: '', success: false })
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('commit failed'))
  })

  it('returns hash on success', async () => {
    mockExec
      .mockImplementationOnce(execOk('M foo.ts'))   // git status → dirty
      .mockImplementationOnce(execOk())              // git add → ok
      .mockImplementationOnce(execOk())              // git commit → ok
      .mockImplementationOnce(execOk('abc123def\n')) // git rev-parse → hash

    const result = await gitCommitChanges('/p', 'my change', 'b1')
    expect(result).toEqual({ hash: 'abc123def', success: true })
  })

  it('passes tagged commit message with bubbleId', async () => {
    // Only test the commit command args
    const calls: string[] = []
    mockExec
      .mockImplementationOnce(execOk('M foo.ts'))   // status
      .mockImplementationOnce(execOk())              // add
      .mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
        calls.push(_cmd)
        cb(null, '', '')
      })                                              // commit + rev-parse

    await gitCommitChanges('/p', 'my change', 'b1')

    const commitCmd = calls.find(c => c.startsWith('git commit'))
    expect(commitCmd).toContain('[self-evolution]')
    expect(commitCmd).toContain('(b1)')
  })
})

describe('gitRevert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true on success', async () => {
    mockExec.mockImplementation(execOk())
    const result = await gitRevert('/p', 'abc123')
    expect(result).toBe(true)
    expect(mockExec).toHaveBeenCalledWith(
      'git revert --no-edit abc123',
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('returns false on failure', async () => {
    mockExec.mockImplementation(execFail('revert conflict'))
    const result = await gitRevert('/p', 'abc123')
    expect(result).toBe(false)
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('revert failed'))
  })
})

describe('validateTypeCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns pass=true when tsc exit code 0', async () => {
    mockExec.mockImplementation(execOk('', ''))
    const result = await validateTypeCheck('/p')
    expect(result).toEqual({ pass: true, output: '' })
  })

  it('returns pass=false with stderr output when tsc fails', async () => {
    const errOutput = 'src/foo.ts(5,1): error TS2322: Type "number" is not assignable'
    mockExec.mockImplementation(execFail(errOutput))
    const result = await validateTypeCheck('/p')
    expect(result.pass).toBe(false)
    expect(result.output).toContain('TS2322')
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('tsc validation failed'))
  })
})
