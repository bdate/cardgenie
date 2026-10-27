// Google Ads "Card Genie - Credit Purchase" conversion. The server only queues a conversion after
// Stripe's signed webhook confirms a live, paid credit purchase; this module fires each queued one
// once through the sitewide Google tag (public/ads-tag.js) and tells the server it was reported.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

type PendingConversion = { transactionId: string; value: number; currency: string }

const creditPurchaseSendTo = 'AW-18531832400/HnD8CN-gq6YdENCk1YRF'
const firedStorageKey = 'card-genie-ads-conversions-fired'
const checkPendingStorageKey = 'card-genie-ads-conversion-check'
const checkPendingMaxAgeMs = 3 * 24 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const readFiredIds = (): string[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(firedStorageKey) || '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const rememberFiredIds = (ids: string[]) => {
  try {
    const merged = [...new Set([...readFiredIds(), ...ids])].slice(-50)
    window.localStorage.setItem(firedStorageKey, JSON.stringify(merged))
  } catch {
    // Storage may be unavailable; the server-side reported flag still prevents repeats.
  }
}

export const markConversionCheckPending = () => {
  try {
    window.localStorage.setItem(checkPendingStorageKey, String(Date.now()))
  } catch {
    // Ignore storage failures.
  }
}

export const clearConversionCheckPending = () => {
  try {
    window.localStorage.removeItem(checkPendingStorageKey)
  } catch {
    // Ignore storage failures.
  }
}

export const hasConversionCheckPending = () => {
  try {
    const startedAt = Number(window.localStorage.getItem(checkPendingStorageKey) || 0)
    if (!startedAt) return false
    if (Date.now() - startedAt > checkPendingMaxAgeMs) {
      window.localStorage.removeItem(checkPendingStorageKey)
      return false
    }
    return true
  } catch {
    return false
  }
}

const waitForGtag = async (timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  while (typeof window.gtag !== 'function' && Date.now() < deadline) {
    await sleep(200)
  }
  return typeof window.gtag === 'function'
}

const isValidConversion = (item: unknown): item is PendingConversion => {
  const entry = item as PendingConversion
  return (
    Boolean(entry) &&
    typeof entry.transactionId === 'string' &&
    entry.transactionId.length > 0 &&
    typeof entry.value === 'number' &&
    Number.isFinite(entry.value) &&
    entry.value > 0 &&
    typeof entry.currency === 'string'
  )
}

// Secondary (observation-only) Google Ads conversions for earlier funnel steps. A step stays off
// until its send_to label from Google Ads is filled in here.
export type FunnelStep = 'landing_click' | 'card_created' | 'account_created' | 'card_sent'
const funnelSendTo: Record<FunnelStep, string> = {
  landing_click: 'AW-18531832400/39zvCJuAk6sdENCk1YRF',
  card_created: 'AW-18531832400/liNkCJ6Ak6sdENCk1YRF',
  account_created: 'AW-18531832400/5QFfCIiRl6sdENCk1YRF',
  card_sent: 'AW-18531832400/n0hcCKGAk6sdENCk1YRF',
}
const funnelFiredStorageKey = 'card-genie-ads-funnel-fired'

const shortHash = (value: string) => {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  return (hash >>> 0).toString(36)
}

/** Fires a funnel step once per browser for the given item (a card, or the visitor for one-time steps). */
export const trackFunnelConversion = (step: FunnelStep, itemKey = 'once') => {
  const sendTo = funnelSendTo[step]
  if (!sendTo || typeof window.gtag !== 'function' || /^\/gcu\//i.test(window.location.pathname)) return false
  const firedKey = `${step}:${shortHash(itemKey)}`
  let fired: string[] = []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(funnelFiredStorageKey) || '[]')
    fired = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    fired = []
  }
  if (fired.includes(firedKey)) return false
  window.gtag('event', 'conversion', { send_to: sendTo })
  try {
    window.localStorage.setItem(funnelFiredStorageKey, JSON.stringify([...fired, firedKey].slice(-100)))
  } catch {
    // Storage may be unavailable; Google Ads "Count: One" still limits repeats per ad click.
  }
  return true
}

let inFlight: Promise<number> | null = null

/**
 * Fires any verified, not-yet-reported credit purchase conversions for the signed-in account.
 * Polls a few times because Stripe's webhook can land a moment after the shopper returns.
 */
export const reportCreditPurchaseConversions = (options: {
  token: string
  apiUrl: (path: string) => string
  attempts?: number
}) => {
  if (!inFlight) {
    inFlight = runReport(options).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

const runReport = async ({
  token,
  apiUrl,
  attempts = 1,
}: {
  token: string
  apiUrl: (path: string) => string
  attempts?: number
}) => {
  if (!token || !(await waitForGtag())) {
    return 0
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(1500)
    }
    let conversions: PendingConversion[] = []
    try {
      const response = await fetch(apiUrl('/api/billing/conversions'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) continue
      const data = await response.json()
      conversions = Array.isArray(data?.conversions) ? data.conversions.filter(isValidConversion) : []
    } catch {
      continue
    }
    if (!conversions.length) continue

    const alreadyFired = new Set(readFiredIds())
    const reported: string[] = []
    for (const conversion of conversions) {
      if (!alreadyFired.has(conversion.transactionId)) {
        window.gtag?.('event', 'conversion', {
          send_to: creditPurchaseSendTo,
          value: conversion.value,
          currency: conversion.currency,
          transaction_id: conversion.transactionId,
        })
      }
      reported.push(conversion.transactionId)
    }
    rememberFiredIds(reported)
    clearConversionCheckPending()
    try {
      await fetch(apiUrl('/api/billing/conversions/reported'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transactionIds: reported }),
      })
    } catch {
      // The local fired list keeps this browser from firing again; the next check retries the ack.
    }
    return reported.length
  }
  return 0
}
