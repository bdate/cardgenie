export type LandingVariant = 'a' | 'b'
export type LandingAssignment = {
  experiment: 'welcome-v1'
  variant: LandingVariant
  visitor: string
  source: 'paid' | 'other'
  assignedAt: number
}
export type LandingEvent = 'view' | 'sample_open' | 'create_start' | 'form_start' | 'generation_start' | 'generation_complete' | 'generation_error' | 'account_created' | 'card_sent' | 'checkout_start'
export const landingStorageKey = 'cardGenieWelcomeV1'
const maxAge = 30 * 24 * 60 * 60 * 1000
const apiBase = (import.meta.env.VITE_API_BASE_URL || 'https://api.card-genie.com').replace(/\/$/, '')
const sent = new Set<string>()

export async function landingExperimentReady(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(`${apiBase}/api/landing-experiment`, {
      signal: controller.signal, cache: 'no-store',
    })
    if (!response.ok) return false
    const config = await response.json()
    return config?.experiment === 'welcome-v1' && config?.enabled === true
  } catch { return false }
  finally { clearTimeout(timer) }
}

export function readLandingAssignment(): LandingAssignment | null {
  if (new URLSearchParams(location.search).has('landing_preview')) return null
  try {
    const value = JSON.parse(localStorage.getItem(landingStorageKey) || 'null')
    if (value?.experiment !== 'welcome-v1' || !['a', 'b'].includes(value.variant) ||
      !/^[a-f0-9]{32}$/.test(value.visitor) || !['paid', 'other'].includes(value.source) ||
      !Number.isFinite(value.assignedAt) || Date.now() - value.assignedAt > maxAge) return null
    return value
  } catch { return null }
}

export function shouldShowWelcome(): boolean {
  if (location.pathname !== '/' && location.pathname !== '/index.html') return false
  const query = new URLSearchParams(location.search)
  if (query.get('welcome') === 'a' || query.get('welcome') === 'b') return true
  // Never intercept personal cards, checkout returns, account links, or saved work.
  let specialLink = Boolean(location.hash)
  // Ad and analytics tags (Google Ads adds gad_source/gad_campaignid next to gclid) are normal traffic.
  query.forEach((_value, key) => {
    if (!/^(gclid|gbraid|wbraid|dclid|gad_[a-z]+|msclkid|fbclid|srsltid|_gl|utm_[a-z]+|occasion|style)$/i.test(key)) specialLink = true
  })
  if (specialLink) return false
  try {
    const keys = ['cardGenieAccountSession', 'cardGenieFormDraft', 'cardGenieInterviewSession',
      'cardgenie.generationJob', 'cardGenieCheckoutResume', 'cardGenieWelcomeStarted']
    return !keys.some(key => localStorage.getItem(key) || sessionStorage.getItem(key))
  } catch { return false }
}

export function assignLanding(): LandingAssignment {
  const existing = readLandingAssignment()
  if (existing) return existing
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const query = new URLSearchParams(location.search)
  const assignment: LandingAssignment = {
    experiment: 'welcome-v1',
    variant: bytes[0] < 128 ? 'a' : 'b',
    visitor: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
    source: ['gclid', 'gbraid', 'wbraid', 'gad_source'].some(key => query.has(key)) ||
      /^(cpc|ppc|paidsearch)$/i.test(query.get('utm_medium') || '') ? 'paid' : 'other',
    assignedAt: Date.now(),
  }
  try { localStorage.setItem(landingStorageKey, JSON.stringify(assignment)) } catch { /* In-memory assignment still works. */ }
  return assignment
}

export function trackLanding(event: LandingEvent, assignment = readLandingAssignment()) {
  if (!assignment || /^\/gcu\//i.test(location.pathname)) return
  const key = `${assignment.visitor}:${event}`
  if (sent.has(key)) return
  sent.add(key)
  // Only experiment identifiers and a fixed event name are sent. Never names, photos, or form text.
  void fetch(`${apiBase}/api/landing-events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...assignment, event }), keepalive: true,
  }).then(response => { if (!response.ok) sent.delete(key) }).catch(() => {
    sent.delete(key) // A later interaction can retry; analytics never blocks the product.
  })
}

export function creatorUrl(occasion?: string, preview = false): string {
  const query = new URLSearchParams(location.search)
  query.delete('welcome')
  query.set('create', '1')
  if (occasion) query.set('occasion', occasion)
  if (preview) query.set('landing_preview', '1')
  return `/?${query}`
}
