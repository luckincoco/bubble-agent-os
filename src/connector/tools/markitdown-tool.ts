import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ToolDefinition } from '../registry.js'

/**
 * MarkItDown tool — converts documents (PDF, Word, PPT, images, audio, etc.)
 * to Markdown via Microsoft's markitdown CLI.
 *
 * Prerequisites: Python 3.10+ and `pip install 'markitdown[all]'` on the host.
 * The tool gracefully returns an error message if markitdown is not installed.
 */

const MAX_OUTPUT_BYTES = 32768 // 32KB — documents can be longer than code files
const DEFAULT_TIMEOUT_SEC = 60

function truncate(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const buf = Buffer.from(text)
  const truncated = buf.subarray(0, maxBytes).toString('utf-8')
  return truncated + '\n...[truncated, total ' + Buffer.byteLength(text) + ' bytes]'
}

export function createMarkitdownTool(): ToolDefinition[] {
  return [
    {
      name: 'convert_document',
      description: '将文档文件（PDF、Word、PPT、图片、音频、HTML、CSV、ZIP等）转换为 Markdown 文本。需要服务器已安装 markitdown CLI。',
      parameters: {
        path: { type: 'string', description: '文件的绝对路径', required: true },
        timeout: { type: 'string', description: '超时时间（秒），默认 60', required: false },
      },
      async execute(args) {
        const filePath = String(args.path || '').trim()
        if (!filePath) return 'Error: path is required'

        if (!existsSync(filePath)) {
          return `Error: file not found — ${filePath}`
        }

        const timeoutSec = Math.min(
          parseInt(String(args.timeout || String(DEFAULT_TIMEOUT_SEC))) || DEFAULT_TIMEOUT_SEC,
          300, // hard cap 5 minutes
        )

        return new Promise<string>((resolve) => {
          // Use markitdown CLI; quote path to handle spaces
          const cmd = `markitdown "${filePath.replace(/"/g, '\\"')}"`

          exec(cmd, {
            timeout: timeoutSec * 1000,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large docs
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          }, (err, stdout, stderr) => {
            if (err) {
              // Check common failure modes
              const errMsg = err.message || ''
              if (errMsg.includes('not found') || errMsg.includes('ENOENT')) {
                resolve('Error: markitdown CLI not installed. Run: pip install \'markitdown[all]\'')
                return
              }
              if (errMsg.includes('ETIMEDOUT') || (err as any).killed) {
                resolve(`Error: conversion timed out after ${timeoutSec}s — file may be too large`)
                return
              }
              const detail = stderr ? stderr.slice(0, 500) : errMsg.slice(0, 500)
              resolve(`Error: conversion failed — ${detail}`)
              return
            }

            if (!stdout || stdout.trim().length === 0) {
              resolve('(empty result — markitdown produced no output for this file)')
              return
            }

            resolve(truncate(stdout))
          })
        })
      },
    },
  ]
}
