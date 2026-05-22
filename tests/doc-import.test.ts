import { describe, it, expect } from 'vitest'
import { detectFileType, splitIntoChunks, parseTxt } from '../src/connector/tools/doc-import.js'

describe('detectFileType', () => {
  it('returns pdf for .pdf extension', () => {
    expect(detectFileType('report.pdf')).toBe('pdf')
    expect(detectFileType('REPORT.PDF')).toBe('pdf')
  })

  it('returns docx for .docx extension', () => {
    expect(detectFileType('doc.docx')).toBe('docx')
    expect(detectFileType('DOC.DOCX')).toBe('docx')
  })

  it('returns txt for .txt extension', () => {
    expect(detectFileType('notes.txt')).toBe('txt')
    expect(detectFileType('NOTES.TXT')).toBe('txt')
  })

  it('returns null for unknown extensions', () => {
    expect(detectFileType('file.csv')).toBeNull()
    expect(detectFileType('file')).toBeNull()
    expect(detectFileType('')).toBeNull()
  })
})

describe('parseTxt', () => {
  it('decodes buffer to utf-8 string', () => {
    const result = parseTxt(Buffer.from('Hello World', 'utf-8'))
    expect(result.text).toBe('Hello World')
  })

  it('handles Chinese text', () => {
    const result = parseTxt(Buffer.from('你好世界', 'utf-8'))
    expect(result.text).toBe('你好世界')
  })
})

describe('splitIntoChunks', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoChunks('')).toEqual([])
    expect(splitIntoChunks('   ')).toEqual([])
  })

  it('returns single chunk for short text', () => {
    expect(splitIntoChunks('short text')).toEqual(['short text'])
  })

  it('splits at paragraph boundaries', () => {
    const text = 'A'.repeat(500) + '\n\n' + 'B'.repeat(500)
    const chunks = splitIntoChunks(text, 600)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toContain('A')
    expect(chunks[1]).toContain('B')
  })

  it('handles text shorter than maxChars', () => {
    const result = splitIntoChunks('Hello', 2000)
    expect(result).toEqual(['Hello'])
  })

  it('preserves trimmed content in each chunk', () => {
    const result = splitIntoChunks('  hello world  ', 2000)
    expect(result).toEqual(['hello world'])
  })
})
