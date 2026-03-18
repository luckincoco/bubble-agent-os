import type { WSMessage, ConnectionStatus } from '../types'
import { useAuthStore } from '../stores/authStore'

type MessageHandler = (msg: WSMessage) => void
type StatusHandler = (status: ConnectionStatus) => void

export class WSManager {
  private ws: WebSocket | null = null
  private url: string
  private onMessage: MessageHandler
  private onStatus: StatusHandler
  private retryCount = 0
  private maxRetry = 30000
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, onMessage: MessageHandler, onStatus: StatusHandler) {
    this.url = url
    this.onMessage = onMessage
    this.onStatus = onStatus
  }

  connect() {
    this.onStatus('connecting')
    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.onStatus('error')
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.retryCount = 0
      this.onStatus('connected')
    }

    this.ws.onmessage = (e) => {
      try {
        const msg: WSMessage = JSON.parse(e.data)
        this.onMessage(msg)
      } catch { /* ignore bad json */ }
    }

    this.ws.onclose = () => {
      this.onStatus('disconnected')
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.onStatus('error')
    }
  }

  send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  disconnect() {
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), this.maxRetry)
    this.retryCount++
    this.timer = setTimeout(() => this.connect(), delay)
  }
}

export function getWSUrl(): string {
  const token = useAuthStore.getState().token || ''
  if (import.meta.env.DEV) return `ws://localhost:3000/ws?token=${token}`
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws?token=${token}`
}
