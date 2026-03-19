import { logger } from '../../shared/logger.js'

/** Parse PDF buffer and extract text + page count */
export async function parsePDF(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  const pageCount = result.total
  await parser.destroy()
  return { text: result.text, pageCount }
}

/** Parse .docx buffer and extract raw text */
export async function parseDocx(buffer: Buffer): Promise<{ text: string }> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return { text: result.value }
}

/** Parse .txt buffer */
export function parseTxt(buffer: Buffer): { text: string } {
  return { text: buffer.toString('utf-8') }
}

/**
 * Split text into chunks of roughly `maxChars` characters.
 * Prefers splitting at paragraph boundaries (\n\n), then sentence endings.
 */
export function splitIntoChunks(text: string, maxChars = 2000): string[] {
  if (!text.trim()) return []
  if (text.length <= maxChars) return [text.trim()]

  const chunks: string[] = []
  // First split by paragraphs
  const paragraphs = text.split(/\n\n+/)
  let current = ''

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    // If a single paragraph exceeds maxChars, split it by sentences
    if (trimmed.length > maxChars) {
      // Flush current buffer first
      if (current.trim()) {
        chunks.push(current.trim())
        current = ''
      }
      // Split long paragraph by sentence endings
      const sentences = trimmed.split(/(?<=[。！？.!?\n])\s*/)
      for (const sentence of sentences) {
        if (current.length + sentence.length > maxChars && current.trim()) {
          chunks.push(current.trim())
          current = ''
        }
        current += (current ? ' ' : '') + sentence
      }
      continue
    }

    if (current.length + trimmed.length + 2 > maxChars && current.trim()) {
      chunks.push(current.trim())
      current = ''
    }
    current += (current ? '\n\n' : '') + trimmed
  }

  if (current.trim()) {
    chunks.push(current.trim())
  }

  return chunks
}

/** Detect file type from filename extension */
export function detectFileType(filename: string): 'pdf' | 'docx' | 'txt' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.txt')) return 'txt'
  return null
}
