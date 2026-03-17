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

export async function uploadExcel(file: File): Promise<{ created: number; sheet: string; columns: string[] }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/api/import-excel`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}
