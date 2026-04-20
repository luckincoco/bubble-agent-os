import { create } from 'zustand'
import type { AuthUserInfo, SpaceInfo, LoginResponse } from '../types'
import { useModuleStore } from './moduleStore'
import { useChatStore } from './chatStore'
import { useBizStore } from './bizStore'

const TOKEN_KEY = 'bubble_token'
const USER_KEY = 'bubble_user'
const SPACE_KEY = 'bubble_space'

interface AuthState {
  token: string | null
  user: AuthUserInfo | null
  currentSpaceId: string | null
  isLoading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  init: () => void
  switchSpace: (spaceId: string) => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  currentSpaceId: null,
  isLoading: true,
  error: null,

  login: async (username: string, password: string) => {
    set({ error: null, isLoading: true })
    try {
      const BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''
      const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '登录失败' }))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data: LoginResponse = await res.json()
      localStorage.setItem(TOKEN_KEY, data.token)
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
      const savedSpace = localStorage.getItem(SPACE_KEY)
      const initialSpace = (savedSpace && data.user.spaceIds.includes(savedSpace))
        ? savedSpace
        : data.user.spaceIds[0] || null
      if (initialSpace) localStorage.setItem(SPACE_KEY, initialSpace)
      set({
        token: data.token,
        user: data.user,
        currentSpaceId: initialSpace,
        isLoading: false,
        error: null,
      })
      useModuleStore.getState().initFromPreferences(data.user.preferences)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '登录失败', isLoading: false })
    }
  },

  logout: () => {
    // Disconnect WebSocket and clear chat history FIRST
    useChatStore.getState().disconnect()
    useChatStore.setState({ messages: [], isStreaming: false })
    // Clear biz data (no reset method, clear key arrays directly)
    useBizStore.setState({
      products: [], counterparties: [], projects: [],
      purchases: [], sales: [], logistics: [], payments: [], invoices: [],
      dashboard: null,
    })
    // Clear auth state
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    localStorage.removeItem(SPACE_KEY)
    set({ token: null, user: null, currentSpaceId: null, error: null })
    useModuleStore.getState().reset()
  },

  init: () => {
    const token = localStorage.getItem(TOKEN_KEY)
    const userStr = localStorage.getItem(USER_KEY)
    if (token && userStr) {
      try {
        // Check token expiry (JWT payload is base64)
        const payload = JSON.parse(atob(token.split('.')[1]))
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          // Token expired
          localStorage.removeItem(TOKEN_KEY)
          localStorage.removeItem(USER_KEY)
          set({ isLoading: false })
          return
        }
        const user: AuthUserInfo = JSON.parse(userStr)
        const savedSpace = localStorage.getItem(SPACE_KEY)
        const restoredSpace = (savedSpace && user.spaceIds.includes(savedSpace))
          ? savedSpace
          : user.spaceIds[0] || null
        set({ token, user, currentSpaceId: restoredSpace, isLoading: false })
        useModuleStore.getState().initFromPreferences(user.preferences)
      } catch {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
        set({ isLoading: false })
      }
    } else {
      set({ isLoading: false })
    }
  },

  switchSpace: (spaceId: string) => {
    const { user } = get()
    if (user?.spaceIds.includes(spaceId)) {
      localStorage.setItem(SPACE_KEY, spaceId)
      set({ currentSpaceId: spaceId })
    }
  },
}))
