const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

const colors = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
}

let minLevel: Level = 'info'

export function setLogLevel(level: Level) {
  minLevel = level
}

function log(level: Level, ...args: unknown[]) {
  if (LEVELS[level] < LEVELS[minLevel]) return
  const tag = `${colors[level]}[${level.toUpperCase()}]${colors.reset}`
  console.error(tag, ...args)
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
}
