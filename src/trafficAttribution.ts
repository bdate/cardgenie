/** First-touch traffic capture for durable card analytics (Cover gallery). */

export type TrafficAttribution = {
  channel: 'paid_search' | 'organic_search' | 'social' | 'referral' | 'email' | 'gcu' | 'direct' | 'other'
  source: string
  medium: string
  campaign: string
  term: string
  content: string
  referrerHost: string
  landingPath: string
  gclid: boolean
  capturedAt: number
}

const storageKey = 'cardGenieTrafficAttribution'
const maxAgeMs = 90 * 24 * 60 * 60 * 1000

const searchHosts = /(?:^|\.)((google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)\.[a-z.]+)$/i
const socialHosts =
  /(?:^|\.)((facebook|instagram|linkedin|twitter|x|t\.co|pinterest|tiktok|reddit|youtube)\.[a-z.]+)$/i

const clean = (value: unknown, max = 160) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max)

const hostFromUrl = (value: string) => {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

const classifyChannel = (input: {
  query: URLSearchParams
  referrerHost: string
  landingPath: string
}): TrafficAttribution['channel'] => {
  const medium = clean(input.query.get('utm_medium'), 80).toLowerCase()
  const source = clean(input.query.get('utm_source'), 80).toLowerCase()
  const hasPaidClick =
    ['gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'gad_source'].some((key) => input.query.has(key)) ||
    /^(cpc|ppc|paidsearch|paid[_\s-]?search)$/i.test(medium)

  if (hasPaidClick) return 'paid_search'
  if (/^email|e-mail$/i.test(medium) || source === 'email') return 'email'
  if (
    input.query.has('fbclid') ||
    /^(social|social[_\s-]?organic)$/i.test(medium) ||
    socialHosts.test(input.referrerHost)
  ) {
    return 'social'
  }
  if (/^\/gcu\//i.test(input.landingPath) || /greetingcarduniverse\.com$/i.test(input.referrerHost) || source === 'gcu') {
    return 'gcu'
  }
  if (input.referrerHost && searchHosts.test(input.referrerHost) && !hasPaidClick) return 'organic_search'
  if (input.referrerHost) return 'referral'
  if (source || medium || clean(input.query.get('utm_campaign'))) return 'other'
  return 'direct'
}

export const captureTrafficAttribution = (): TrafficAttribution | null => {
  if (typeof window === 'undefined') return null
  try {
    const existing = JSON.parse(window.localStorage.getItem(storageKey) || 'null') as TrafficAttribution | null
    if (
      existing &&
      typeof existing.channel === 'string' &&
      Number.isFinite(existing.capturedAt) &&
      Date.now() - existing.capturedAt < maxAgeMs
    ) {
      return existing
    }
  } catch {
    // Capture a fresh first-touch below.
  }

  const query = new URLSearchParams(window.location.search)
  const referrerHost = hostFromUrl(document.referrer || '')
  const landingPath = `${window.location.pathname || '/'}${window.location.search || ''}`.slice(0, 240)
  const attribution: TrafficAttribution = {
    channel: classifyChannel({ query, referrerHost, landingPath }),
    source: clean(query.get('utm_source')),
    medium: clean(query.get('utm_medium')),
    campaign: clean(query.get('utm_campaign')),
    term: clean(query.get('utm_term')),
    content: clean(query.get('utm_content')),
    referrerHost,
    landingPath,
    gclid: ['gclid', 'gbraid', 'wbraid', 'msclkid', 'gad_source'].some((key) => query.has(key)),
    capturedAt: Date.now(),
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(attribution))
  } catch {
    // In-memory value still returned for this session.
  }
  return attribution
}

export const readTrafficAttribution = (): TrafficAttribution | null => {
  if (typeof window === 'undefined') return null
  try {
    const existing = JSON.parse(window.localStorage.getItem(storageKey) || 'null') as TrafficAttribution | null
    if (
      existing &&
      typeof existing.channel === 'string' &&
      Number.isFinite(existing.capturedAt) &&
      Date.now() - existing.capturedAt < maxAgeMs
    ) {
      return existing
    }
  } catch {
    return null
  }
  return captureTrafficAttribution()
}

export const channelLabel = (channel?: string) => {
  switch (channel) {
    case 'paid_search':
      return 'Paid search'
    case 'organic_search':
      return 'Organic search'
    case 'social':
      return 'Social'
    case 'referral':
      return 'Referral'
    case 'email':
      return 'Email'
    case 'gcu':
      return 'GreetingCardUniverse'
    case 'direct':
      return 'Direct'
    case 'other':
      return 'Other'
    default:
      return channel || 'Unknown'
  }
}
