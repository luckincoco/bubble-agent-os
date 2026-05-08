import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import type { ToolDefinition } from '../registry.js'

const MAX_OUTPUT_BYTES = 10240 // 10KB

function truncate(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const buf = Buffer.from(text)
  const truncated = buf.subarray(0, maxBytes).toString('utf-8')
  return truncated + '\n...[truncated, total ' + Buffer.byteLength(text) + ' bytes]'
}

export function createCodeTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: '读取指定路径的文件内容，可选行范围',
      parameters: {
        path: { type: 'string', description: '文件的绝对路径或相对路径', required: true },
        start_line: { type: 'string', description: '起始行号（从1开始）', required: false },
        end_line: { type: 'string', description: '结束行号', required: false },
      },
      async execute(args) {
        const filePath = String(args.path || '').trim()
        if (!filePath) return 'Error: path is required'

        try {
          const content = await readFile(filePath, 'utf-8')
          const startLine = parseInt(String(args.start_line || '0')) || 0
          const endLine = parseInt(String(args.end_line || '0')) || 0

          if (startLine > 0 || endLine > 0) {
            const lines = content.split('\n')
            const start = Math.max(0, startLine - 1)
            const end = endLine > 0 ? endLine : lines.length
            const sliced = lines.slice(start, end)
            return truncate(sliced.map((l, i) => `${start + i + 1}| ${l}`).join('\n'))
          }

          return truncate(content)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Error reading file: ${msg}`
        }
      },
    },
    {
      name: 'write_file',
      description: '将内容写入指定路径的文件（创建或覆盖）',
      parameters: {
        path: { type: 'string', description: '文件的绝对路径或相对路径', required: true },
        content: { type: 'string', description: '要写入的文件内容', required: true },
        create_dirs: { type: 'string', description: '是否自动创建父目录，默认 true', required: false },
      },
      async execute(args) {
        const filePath = String(args.path || '').trim()
        if (!filePath) return 'Error: path is required'
        const content = String(args.content ?? '')

        try {
          const shouldCreateDirs = String(args.create_dirs || 'true') !== 'false'
          if (shouldCreateDirs) {
            await mkdir(dirname(filePath), { recursive: true })
          }
          await writeFile(filePath, content, 'utf-8')
          return `Successfully wrote ${Buffer.byteLength(content)} bytes to ${filePath}`
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Error writing file: ${msg}`
        }
      },
    },
    {
      name: 'list_directory',
      description: '列出指定目录下的文件和子目录',
      parameters: {
        path: { type: 'string', description: '目录路径', required: true },
        recursive: { type: 'string', description: '是否递归列出，默认 false', required: false },
      },
      async execute(args) {
        const dirPath = String(args.path || '').trim()
        if (!dirPath) return 'Error: path is required'

        try {
          const recursive = String(args.recursive || 'false') === 'true'
          const entries = await readdir(dirPath, { withFileTypes: true, recursive })
          const MAX_ENTRIES = 200

          const lines: string[] = []
          let count = 0
          for (const entry of entries) {
            if (count >= MAX_ENTRIES) {
              lines.push(`\n...[truncated, showing ${MAX_ENTRIES} of ${entries.length} entries]`)
              break
            }
            const prefix = entry.isDirectory() ? '[DIR]  ' : '[FILE] '
            const relativePath = recursive && entry.parentPath
              ? resolve(entry.parentPath, entry.name).replace(resolve(dirPath) + '/', '')
              : entry.name
            lines.push(`${prefix}${relativePath}`)
            count++
          }

          return lines.join('\n') || '(empty directory)'
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Error listing directory: ${msg}`
        }
      },
    },
    {
      name: 'shell_exec',
      description: '执行 Shell 命令并返回输出',
      parameters: {
        command: { type: 'string', description: '要执行的命令', required: true },
        cwd: { type: 'string', description: '工作目录', required: false },
        timeout: { type: 'string', description: '超时时间（秒），默认 30', required: false },
      },
      async execute(args) {
        const command = String(args.command || '').trim()
        if (!command) return 'Error: command is required'

        const cwd = String(args.cwd || process.cwd()).trim()
        const timeoutSec = Math.min(parseInt(String(args.timeout || '30')) || 30, 60)
        const timeoutMs = timeoutSec * 1000

        return new Promise<string>((resolve) => {
          exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            const exitCode = err && 'code' in err ? (err as any).code : (err ? 1 : 0)
            let output = ''
            if (stdout) output += stdout
            if (stderr) output += (output ? '\n' : '') + '[STDERR] ' + stderr

            const result = `Exit code: ${exitCode}\n${truncate(output)}`
            resolve(result)
          })
        })
      },
    },
  ]
}
