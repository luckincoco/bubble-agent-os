const BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''

export async function fetchMemories() {
  const res = await fetch(`${BASE}/api/memories`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchHealth() {
  const res = await fetch(`${BASE}/api/health`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
