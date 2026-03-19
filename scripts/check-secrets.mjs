#!/usr/bin/env node
/**
 * Pre-commit secret scanner
 * Scans staged files for potential secrets, API keys, and sensitive data.
 * Exit code 1 = secrets found (blocks commit)
 */
import { readFileSync } from 'node:fs'

const SECRET_PATTERNS = [
  { name: 'API Key (sk-*)',       re: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'AWS Access Key',       re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub Token (ghp)',   re: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'GitHub OAuth (gho)',   re: /gho_[a-zA-Z0-9]{36}/g },
  { name: 'Private Key Block',    re: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/g },
  { name: 'Hardcoded password',   re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/gi },
  { name: 'Private IP address',   re: /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})/g },
]

// Paths in arguments (lint-staged passes file paths)
const files = process.argv.slice(2)
if (files.length === 0) process.exit(0)

let found = false

for (const file of files) {
  // Skip test files, examples, and this script itself
  if (/\.(test|spec)\.[jt]sx?$/.test(file)) continue
  if (file.includes('.env.example')) continue
  if (file.includes('check-secrets')) continue

  let content
  try {
    content = readFileSync(file, 'utf-8')
  } catch {
    continue
  }

  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    const matches = content.match(re)
    if (matches) {
      // Filter out common false positives
      const real = matches.filter(m => {
        // Allow localhost/loopback IPs
        if (/^(127\.|0\.0\.0\.0|localhost)/.test(m)) return false
        // Allow env var references like process.env.DEEPSEEK_API_KEY
        if (/process\.env\./.test(m)) return false
        return true
      })
      if (real.length > 0) {
        console.error(`\x1b[31mSECRET DETECTED\x1b[0m in ${file}: ${name}`)
        real.forEach(m => console.error(`  -> ${m.slice(0, 40)}...`))
        found = true
      }
    }
  }
}

if (found) {
  console.error('\n\x1b[31mCommit blocked: potential secrets detected.\x1b[0m')
  console.error('Remove secrets from source code and use environment variables instead.')
  process.exit(1)
}
