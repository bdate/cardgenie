import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { landingIdentity, LANDING_EVENTS, landingCheckoutMetadata, recordLandingEvent,
  recordLandingPurchase, landingReport } from '../worker/landing-experiment.js'

const output = ts.transpileModule(readFileSync(new URL('../src/landingExperiment.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
}).outputText.replaceAll('import.meta.env.VITE_API_BASE_URL', 'undefined')
const client = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
const storage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), clear: () => values.clear() }
}
globalThis.localStorage = storage()
globalThis.sessionStorage = storage()
function locationAt(url) { globalThis.location = new URL(url, 'https://www.card-genie.com') }

test('welcome protects recipient links, checkout returns, account links, saved drafts, and GCU', () => {
  localStorage.clear(); sessionStorage.clear()
  for (const url of ['/c/secret', '/gcu/123', '/?card=private', '/?resume=private', '/?billing=success',
    '/?keepsake=success', '/?account=1', '/?contact=help', '/?thankYou=1', '/?create=1', '/#draft']) {
    locationAt(url); assert.equal(client.shouldShowWelcome(), false, url)
  }
  locationAt('/?gclid=ad&occasion=Birthday')
  assert.equal(client.shouldShowWelcome(), true)
  // Real Google Ads clicks carry gad_source/gad_campaignid (and sometimes gbraid) next to gclid.
  locationAt('/?gad_source=1&gad_campaignid=24392343745&gbraid=0AAAA&gclid=ad')
  assert.equal(client.shouldShowWelcome(), true)
  locationAt('/?gad_source=1&gad_campaignid=24392343745&gclid=ad&card=private')
  assert.equal(client.shouldShowWelcome(), false)
  for (const key of ['cardGenieAccountSession', 'cardGenieFormDraft', 'cardGenieInterviewSession',
    'cardgenie.generationJob', 'cardGenieCheckoutResume', 'cardGenieWelcomeStarted']) {
    localStorage.setItem(key, '{}'); assert.equal(client.shouldShowWelcome(), false, key); localStorage.clear()
    sessionStorage.setItem(key, '{}'); assert.equal(client.shouldShowWelcome(), false, key); sessionStorage.clear()
  }
})

test('assignment persists, separates paid traffic, rejects expired or malformed identities', () => {
  localStorage.clear(); locationAt('/?gclid=google')
  const first = client.assignLanding()
  assert.equal(first.source, 'paid'); assert.match(first.visitor, /^[0-9a-f]{32}$/)
  locationAt('/'); assert.deepEqual(client.assignLanding(), first)
  localStorage.setItem(client.landingStorageKey, JSON.stringify({ ...first, assignedAt: Date.now() - 31 * 864e5 }))
  assert.equal(client.readLandingAssignment(), null)
  const next = client.assignLanding(); assert.equal(next.source, 'other'); assert.notEqual(first.visitor, next.visitor)
  localStorage.setItem(client.landingStorageKey, JSON.stringify({ ...next, visitor: 'user@example.com' }))
  assert.equal(client.readLandingAssignment(), null)
  localStorage.clear(); locationAt('/?gad_source=1&gad_campaignid=24392343745')
  assert.equal(client.assignLanding().source, 'paid')
})

test('preview does not enroll, creation preserves click attribution and selected occasion', () => {
  localStorage.clear(); locationAt('/?welcome=b&gclid=ad123&utm_campaign=Birthday')
  assert.equal(client.shouldShowWelcome(), true)
  const next = new URL(client.creatorUrl('Anniversary', true), location.origin)
  assert.equal(next.searchParams.get('gclid'), 'ad123')
  assert.equal(next.searchParams.get('utm_campaign'), 'Birthday')
  assert.equal(next.searchParams.get('occasion'), 'Anniversary')
  assert.equal(next.searchParams.get('landing_preview'), '1')
  assert.equal(next.searchParams.has('welcome'), false)
  locationAt(next.href); assert.equal(client.shouldShowWelcome(), false); assert.equal(client.readLandingAssignment(), null)
  assert.equal(localStorage.getItem(client.landingStorageKey), null)
})

test('interaction tracking deduplicates on-change events and excludes customer details', async () => {
  localStorage.clear(); locationAt('/?utm_medium=cpc')
  const assignment = client.assignLanding()
  const requests = []
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true } }
  client.trackLanding('form_start'); client.trackLanding('form_start'); await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)).sort(),
    ['assignedAt', 'event', 'experiment', 'source', 'variant', 'visitor'].sort())
  locationAt('/gcu/123'); client.trackLanding('view', assignment); assert.equal(requests.length, 1)
})

test('live routing only enables the experiment when the reporting API is ready', async () => {
  globalThis.fetch = async () => ({ ok: false })
  assert.equal(await client.landingExperimentReady(), false)
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.equal(await client.landingExperimentReady(), false)
  for (const config of [{ enabled: true }, { experiment: 'old', enabled: true }, { experiment: 'welcome-v1', enabled: false }]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => config })
    assert.equal(await client.landingExperimentReady(), false)
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ experiment: 'welcome-v1', enabled: true }) })
  assert.equal(await client.landingExperimentReady(), true)
})

function database() {
  const db = new DatabaseSync(':memory:')
  return { ACCOUNT_DB: { prepare(sql) {
    let params = []
    return { bind(...args) { params = args; return this },
      async run() { return db.prepare(sql).run(...params) },
      async all() { return { results: db.prepare(sql).all(...params) } } }
  } } }
}
const identity = { experiment: 'welcome-v1', variant: 'a', visitor: 'a'.repeat(32), source: 'paid' }
const paidCheckout = { id: 'cs_one', livemode: true, payment_status: 'paid', amount_total: 500,
  metadata: landingCheckoutMetadata(identity) }

test('fixed schema rejects malformed identities and never accepts public purchase events', () => {
  assert.equal(landingIdentity({ ...identity, visitor: 'not-an-anonymous-id' }), null)
  assert.equal(landingIdentity({ ...identity, variant: 'c' }), null)
  assert.equal(landingIdentity({ ...identity, source: 'anything' }), null)
  assert.equal(LANDING_EVENTS.has('purchase'), false)
})

test('funnel deduplicates milestones and webhook retries, totals repeat paid purchases once each', async () => {
  const env = database()
  await recordLandingEvent(env, identity, 'view'); await recordLandingEvent(env, identity, 'view')
  await recordLandingEvent(env, identity, 'create_start'); await recordLandingEvent(env, identity, 'create_start')
  await recordLandingEvent(env, identity, 'generation_complete')
  await recordLandingPurchase(env, paidCheckout); await recordLandingPurchase(env, paidCheckout)
  await recordLandingPurchase(env, { ...paidCheckout, id: 'cs_two', amount_total: 1000 })
  const [row] = await landingReport(env)
  assert.equal(row.visitors, 1); assert.equal(row.starts, 1); assert.equal(row.completed, 1)
  assert.equal(row.buyers, 1); assert.equal(row.revenueCents, 1500)
})

test('test-mode, unpaid, free, GCU, and unattributed checkouts never become welcome purchases', async () => {
  const env = database(); await recordLandingEvent(env, identity, 'view')
  for (const change of [{ livemode: false }, { payment_status: 'unpaid' }, { amount_total: 0 },
    { metadata: { ...paidCheckout.metadata, source: 'gcu' } }, { metadata: {} }]) {
    assert.equal(await recordLandingPurchase(env, { ...paidCheckout, ...change }), false)
  }
  const [row] = await landingReport(env); assert.equal(row.buyers, 0); assert.equal(row.revenueCents, 0)
})

test('cohorts remain separate and non-exposed clients never inflate conversion rates', async () => {
  const env = database()
  await recordLandingEvent(env, identity, 'view')
  const other = { ...identity, visitor: 'b'.repeat(32), variant: 'b', source: 'other' }
  await recordLandingEvent(env, other, 'view')
  await recordLandingEvent(env, { ...other, visitor: 'c'.repeat(32) }, 'generation_complete')
  const rows = await landingReport(env)
  assert.equal(rows.length, 2); assert.equal(rows.reduce((n, row) => n + row.visitors, 0), 2)
  assert.equal(rows.reduce((n, row) => n + row.completed, 0), 0)
})
