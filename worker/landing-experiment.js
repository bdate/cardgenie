// First-party welcome-page funnel. No names, phone numbers, images, card text, or IP addresses.
export const LANDING_EXPERIMENT = 'welcome-v1'
export const LANDING_EVENTS = new Set(['view', 'sample_open', 'create_start', 'form_start',
  'generation_start', 'generation_complete', 'generation_error', 'account_created', 'card_sent', 'checkout_start'])
const ready = new WeakMap()

export function landingIdentity(value) {
  if (value?.experiment !== LANDING_EXPERIMENT || !['a', 'b'].includes(value.variant) ||
    !/^[a-f0-9]{32}$/.test(String(value.visitor || '')) || !['paid', 'other'].includes(value.source)) return null
  return { experiment: LANDING_EXPERIMENT, variant: value.variant, visitor: value.visitor, source: value.source }
}

async function ensureTable(db) {
  if (!ready.has(db)) {
    ready.set(db, db.prepare(`CREATE TABLE IF NOT EXISTS landing_events (
      id TEXT PRIMARY KEY, experiment TEXT NOT NULL, variant TEXT NOT NULL,
      visitor TEXT NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    )`).run().catch(error => { ready.delete(db); throw error }))
  }
  await ready.get(db)
}

export async function recordLandingEvent(env, identity, event, purchase = null) {
  const valid = landingIdentity(identity)
  if (!env.ACCOUNT_DB || !valid || (!LANDING_EVENTS.has(event) && event !== 'purchase')) return false
  if (event === 'purchase' && (!purchase?.id || !(purchase.amountCents > 0))) return false
  await ensureTable(env.ACCOUNT_DB)
  const id = event === 'purchase' ? `purchase:${purchase.id}` : `${valid.visitor}:${event}`
  await env.ACCOUNT_DB.prepare(`INSERT OR IGNORE INTO landing_events
    (id, experiment, variant, visitor, source, event, amount_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, valid.experiment, valid.variant, valid.visitor,
      valid.source, event, event === 'purchase' ? Math.floor(purchase.amountCents) : 0,
      new Date().toISOString()).run()
  return true
}

export function landingCheckoutMetadata(identity) {
  const valid = landingIdentity(identity)
  return valid ? { landingExperiment: valid.experiment, landingVariant: valid.variant,
    landingVisitor: valid.visitor, landingSource: valid.source } : {}
}

export async function recordLandingPurchase(env, checkout) {
  const meta = checkout?.metadata || {}
  // This is called only after Stripe verification / authenticated checkout reconciliation.
  if (checkout.livemode !== true || checkout.payment_status !== 'paid' ||
    !(checkout.amount_total > 0) || meta.source === 'gcu') return false
  return recordLandingEvent(env, { experiment: meta.landingExperiment, variant: meta.landingVariant,
    visitor: meta.landingVisitor, source: meta.landingSource }, 'purchase',
    { id: checkout.id, amountCents: checkout.amount_total })
}

export async function landingReport(env) {
  if (!env.ACCOUNT_DB) return []
  await ensureTable(env.ACCOUNT_DB)
  // Join all milestones back to exposure: buyers are unique people, revenue includes repeat purchases.
  const result = await env.ACCOUNT_DB.prepare(`SELECT v.variant, v.source,
    COUNT(DISTINCT v.visitor) AS visitors,
    COUNT(DISTINCT CASE WHEN e.event = 'sample_open' THEN e.visitor END) AS samples,
    COUNT(DISTINCT CASE WHEN e.event = 'create_start' THEN e.visitor END) AS starts,
    COUNT(DISTINCT CASE WHEN e.event = 'form_start' THEN e.visitor END) AS forms,
    COUNT(DISTINCT CASE WHEN e.event = 'generation_complete' THEN e.visitor END) AS completed,
    COUNT(DISTINCT CASE WHEN e.event = 'generation_error' THEN e.visitor END) AS errors,
    COUNT(DISTINCT CASE WHEN e.event = 'account_created' THEN e.visitor END) AS accounts,
    COUNT(DISTINCT CASE WHEN e.event = 'card_sent' THEN e.visitor END) AS sends,
    COUNT(DISTINCT CASE WHEN e.event = 'checkout_start' THEN e.visitor END) AS checkouts,
    COUNT(DISTINCT CASE WHEN e.event = 'purchase' THEN e.visitor END) AS buyers,
    COALESCE(SUM(CASE WHEN e.event = 'purchase' THEN e.amount_cents ELSE 0 END), 0) AS revenueCents
    FROM landing_events v LEFT JOIN landing_events e
      ON e.visitor = v.visitor AND e.experiment = v.experiment AND e.variant = v.variant AND e.source = v.source
    WHERE v.event = 'view' AND v.experiment = ?
    GROUP BY v.variant, v.source ORDER BY v.source, v.variant`).bind(LANDING_EXPERIMENT).all()
  return result.results || []
}
