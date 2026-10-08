import { METRICS_EARLIEST_DAY, METRICS_TIME_ZONE, pacificDayKeyFromDate } from './account-db.js'

export const COST_UNIT_PRICES = {
  coverImage: 0.07,
  coverImageReferencePhoto: 0.02,
  textModelCall: 0.0005,
  realtimeVoicePerMinute: 0.1,
  realtimeMinimumMinutesPerSession: 1,
  ttsPerUse: 0.01,
  transcriptionPerMinute: 0.006,
  transcriptionPerUse: 0.003,
  smsPerSegment: 0.012,
  mmsPerMessage: 0.03,
  emailPerMessage: 0.0005,
  printedCardMaterialsAndPostage: 2,
  stripePercent: 0.029,
  stripeFixedPerPayment: 0.3,
  cloudflareWorkersPerMonth: 5,
  estimatedTextCallsPerCard: 3,
}

export const USAGE_KINDS = {
  imageNew: 'image_new',
  imageNewWithPhoto: 'image_new_photo',
  imageRevise: 'image_revise',
  imageReviseWithPhoto: 'image_revise_photo',
  textModel: 'openai_text',
  tts: 'tts',
  transcription: 'transcription',
  realtimeSession: 'realtime_session',
  realtimeSeconds: 'realtime_seconds',
  smsCard: 'sms_card',
  smsAccount: 'sms_account',
  mms: 'mms',
  email: 'email',
}

const COST_CATEGORIES = [
  { id: 'images', label: 'Images', unitLabel: 'covers' },
  { id: 'voice', label: 'Genie voice', unitLabel: 'min' },
  { id: 'texts', label: 'Texts', unitLabel: 'segments' },
  { id: 'emails', label: 'Emails', unitLabel: 'emails' },
  { id: 'printing', label: 'Printing', unitLabel: 'cards' },
  { id: 'stripe', label: 'Stripe fees', unitLabel: 'payments' },
  { id: 'textAi', label: 'Text AI', unitLabel: 'calls' },
  { id: 'fixed', label: 'Fixed', unitLabel: 'days' },
]

let usageTableReady = null

const ensureUsageTable = (db) => {
  if (!usageTableReady) {
    usageTableReady = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS usage_daily (
          day TEXT NOT NULL,
          kind TEXT NOT NULL,
          events INTEGER NOT NULL DEFAULT 0,
          units REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (day, kind)
        )`,
      )
      .run()
      .catch((error) => {
        usageTableReady = null
        throw error
      })
  }
  return usageTableReady
}

export const recordUsage = async (env, kind, { events = 1, units = events } = {}) => {
  if (!env?.ACCOUNT_DB || !kind) {
    return
  }
  try {
    await ensureUsageTable(env.ACCOUNT_DB)
    const safeEvents = Math.max(0, Math.floor(Number(events) || 0))
    const safeUnits = Math.max(0, Number(units) || 0)
    if (!safeEvents && !safeUnits) {
      return
    }
    await env.ACCOUNT_DB.prepare(
      `INSERT INTO usage_daily (day, kind, events, units, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (day, kind) DO UPDATE SET
         events = usage_daily.events + excluded.events,
         units = usage_daily.units + excluded.units,
         updated_at = excluded.updated_at`,
    )
      .bind(pacificDayKeyFromDate(), kind, safeEvents, safeUnits, new Date().toISOString())
      .run()
  } catch (error) {
    console.error('usage tracking failed', kind, error)
  }
}

export const smsSegmentCount = (text) => {
  const body = String(text || '')
  if (!body) {
    return 1
  }
  const isUnicode = /[^\x0A\x0D\x20-\x7E]/.test(body)
  const single = isUnicode ? 70 : 160
  const multi = isUnicode ? 67 : 153
  return body.length <= single ? 1 : Math.ceil(body.length / multi)
}

const parseDayKey = (dayKey) => {
  const [year, month, day] = String(dayKey).split('-').map((part) => Number(part))
  return { year, month, day }
}

const shiftDayKey = (dayKey, offset) => {
  const { year, month, day } = parseDayKey(dayKey)
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10)
}

const daysInMonthOf = (dayKey) => {
  const { year, month } = parseDayKey(dayKey)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const listDayKeys = (startDay, endDay) => {
  const keys = []
  for (let day = startDay; day <= endDay; day = shiftDayKey(day, 1)) {
    keys.push(day)
  }
  return keys
}

const safeRows = async (db, sql, binds = []) => {
  try {
    const result = await db.prepare(sql).bind(...binds).all()
    return result?.results || []
  } catch {
    return []
  }
}

const dayOf = (timestamp) => (timestamp ? pacificDayKeyFromDate(timestamp) : '')

const roundMoney = (value) => Math.round((Number(value) || 0) * 10000) / 10000

const emptyDay = (day) => ({
  day,
  tracked: false,
  usage: {},
  cardsCreated: 0,
  coverRevisions: 0,
  aiCopyEdits: 0,
  emailDeliveries: 0,
  textDeliveries: 0,
  printOrders: 0,
  payments: [],
})

const usageOf = (bucket, kind) => bucket.usage[kind] || { events: 0, units: 0 }

const priceDay = (bucket) => {
  const p = COST_UNIT_PRICES
  const trackedNew = usageOf(bucket, USAGE_KINDS.imageNew).events
  const trackedNewPhoto = usageOf(bucket, USAGE_KINDS.imageNewWithPhoto).events
  const trackedRevise = usageOf(bucket, USAGE_KINDS.imageRevise).events
  const trackedRevisePhoto = usageOf(bucket, USAGE_KINDS.imageReviseWithPhoto).events
  const trackedImages = trackedNew + trackedNewPhoto + trackedRevise + trackedRevisePhoto
  const photoImages = trackedNewPhoto + trackedRevisePhoto
  const images = Math.max(trackedImages, bucket.cardsCreated + bucket.coverRevisions)

  const realtimeSessions = usageOf(bucket, USAGE_KINDS.realtimeSession).events
  const realtimeMinutes = Math.max(
    usageOf(bucket, USAGE_KINDS.realtimeSeconds).units / 60,
    realtimeSessions * p.realtimeMinimumMinutesPerSession,
  )
  const ttsUses = usageOf(bucket, USAGE_KINDS.tts).events
  const transcriptionUses = usageOf(bucket, USAGE_KINDS.transcription).events
  const transcriptionMinutes = usageOf(bucket, USAGE_KINDS.transcription).units

  const smsSegments = Math.max(
    usageOf(bucket, USAGE_KINDS.smsCard).units + usageOf(bucket, USAGE_KINDS.smsAccount).units,
    bucket.textDeliveries,
  )
  const smsMessages = Math.max(
    usageOf(bucket, USAGE_KINDS.smsCard).events + usageOf(bucket, USAGE_KINDS.smsAccount).events,
    bucket.textDeliveries,
  )
  const mmsMessages = usageOf(bucket, USAGE_KINDS.mms).events
  const emails = Math.max(usageOf(bucket, USAGE_KINDS.email).events, bucket.emailDeliveries)
  const textCalls = Math.max(
    usageOf(bucket, USAGE_KINDS.textModel).events,
    bucket.cardsCreated * p.estimatedTextCallsPerCard + bucket.aiCopyEdits,
  )
  const stripeFees = bucket.payments.reduce(
    (sum, cents) => sum + (cents / 100) * p.stripePercent + p.stripeFixedPerPayment,
    0,
  )
  const revenueCents = bucket.payments.reduce((sum, cents) => sum + cents, 0)

  const categories = {
    images: { cost: images * p.coverImage + photoImages * p.coverImageReferencePhoto, units: images },
    voice: {
      cost:
        realtimeMinutes * p.realtimeVoicePerMinute +
        ttsUses * p.ttsPerUse +
        (transcriptionMinutes > 0
          ? transcriptionMinutes * p.transcriptionPerMinute
          : transcriptionUses * p.transcriptionPerUse),
      units: realtimeMinutes,
    },
    texts: { cost: smsSegments * p.smsPerSegment + mmsMessages * p.mmsPerMessage, units: smsSegments },
    emails: { cost: emails * p.emailPerMessage, units: emails },
    printing: { cost: bucket.printOrders * p.printedCardMaterialsAndPostage, units: bucket.printOrders },
    stripe: { cost: stripeFees, units: bucket.payments.length },
    textAi: { cost: textCalls * p.textModelCall, units: textCalls },
    fixed: { cost: p.cloudflareWorkersPerMonth / daysInMonthOf(bucket.day), units: 1 },
  }

  const cost = Object.values(categories).reduce((sum, entry) => sum + entry.cost, 0)
  return {
    day: bucket.day,
    tracked: bucket.tracked,
    cost,
    revenue: revenueCents / 100,
    cardsCreated: bucket.cardsCreated,
    categories,
    detail: {
      imagesWithPhoto: photoImages,
      imageRevisions: Math.max(trackedRevise + trackedRevisePhoto, bucket.coverRevisions),
      realtimeSessions,
      ttsUses,
      transcriptionUses,
      smsMessages,
      mmsMessages,
    },
  }
}

const summarize = (pricedDays) => {
  const categories = Object.fromEntries(COST_CATEGORIES.map((category) => [category.id, { cost: 0, units: 0 }]))
  const detail = {}
  let cost = 0
  let revenue = 0
  let cardsCreated = 0
  for (const entry of pricedDays) {
    cost += entry.cost
    revenue += entry.revenue
    cardsCreated += entry.cardsCreated
    for (const [id, value] of Object.entries(entry.categories)) {
      categories[id].cost += value.cost
      categories[id].units += value.units
    }
    for (const [key, value] of Object.entries(entry.detail)) {
      detail[key] = (detail[key] || 0) + value
    }
  }
  for (const value of Object.values(categories)) {
    value.cost = roundMoney(value.cost)
    value.units = Math.round(value.units * 10) / 10
  }
  return {
    days: pricedDays.length,
    startDay: pricedDays[0]?.day || '',
    endDay: pricedDays[pricedDays.length - 1]?.day || '',
    cost: roundMoney(cost),
    revenue: roundMoney(revenue),
    net: roundMoney(revenue - cost),
    cardsCreated,
    costPerCard: cardsCreated > 0 ? roundMoney(cost / cardsCreated) : null,
    categories,
    detail,
  }
}

export const getAdminCosts = async (env) => {
  const db = env.ACCOUNT_DB
  if (!db) {
    return null
  }

  const today = pacificDayKeyFromDate()
  const monthStart = `${today.slice(0, 8)}01`
  const last30Start = shiftDayKey(today, -29)
  const earliestWanted = monthStart < last30Start ? monthStart : last30Start
  const firstDay = earliestWanted < METRICS_EARLIEST_DAY ? METRICS_EARLIEST_DAY : earliestWanted
  const dayKeys = listDayKeys(firstDay, today)
  const since = `${shiftDayKey(firstDay, -1)}T00:00:00.000Z`

  const [usageRows, trackingStartRows, cardRows, creditRows, deliveryRows, printRows, paymentRows] =
    await Promise.all([
      safeRows(db, `SELECT day, kind, events, units FROM usage_daily WHERE day >= ?`, [firstDay]),
      safeRows(db, `SELECT MIN(day) AS day FROM usage_daily`),
      safeRows(db, `SELECT created_at FROM cards WHERE created_at >= ?`, [since]),
      safeRows(
        db,
        `SELECT created_at, reason FROM credit_events
         WHERE created_at >= ? AND reason IN ('cover_revise', 'ai_copy')`,
        [since],
      ),
      safeRows(
        db,
        `SELECT created_at, method FROM deliveries WHERE created_at >= ? AND status = 'sent'`,
        [since],
      ),
      safeRows(db, `SELECT created_at, order_source, amount_cents FROM print_orders WHERE created_at >= ?`, [since]),
      safeRows(
        db,
        `SELECT COALESCE(paid_at, created_at) AS created_at,
                (amount_cents - COALESCE(amount_refunded_cents, 0)) AS amount_cents
         FROM payments
         WHERE status = 'paid' AND COALESCE(paid_at, created_at) >= ?`,
        [since],
      ),
    ])

  const buckets = new Map(dayKeys.map((day) => [day, emptyDay(day)]))
  const bucketFor = (day) => buckets.get(day)

  for (const row of usageRows) {
    const bucket = bucketFor(row.day)
    if (!bucket) continue
    bucket.tracked = true
    bucket.usage[row.kind] = { events: Number(row.events) || 0, units: Number(row.units) || 0 }
  }
  for (const row of cardRows) {
    const bucket = bucketFor(dayOf(row.created_at))
    if (bucket) bucket.cardsCreated += 1
  }
  for (const row of creditRows) {
    const bucket = bucketFor(dayOf(row.created_at))
    if (!bucket) continue
    if (row.reason === 'cover_revise') bucket.coverRevisions += 1
    if (row.reason === 'ai_copy') bucket.aiCopyEdits += 1
  }
  for (const row of deliveryRows) {
    const bucket = bucketFor(dayOf(row.created_at))
    if (!bucket) continue
    if (row.method === 'email') bucket.emailDeliveries += 1
    if (row.method === 'text') bucket.textDeliveries += 1
  }
  for (const row of printRows) {
    const bucket = bucketFor(dayOf(row.created_at))
    if (!bucket) continue
    bucket.printOrders += 1
    const cents = Number(row.amount_cents) || 0
    if (row.order_source === 'recipient' && cents > 0) bucket.payments.push(cents)
  }
  for (const row of paymentRows) {
    const bucket = bucketFor(dayOf(row.created_at))
    const cents = Number(row.amount_cents) || 0
    if (bucket && cents > 0) bucket.payments.push(cents)
  }

  const priced = dayKeys.map((day) => priceDay(buckets.get(day)))
  const inRange = (start) => priced.filter((entry) => entry.day >= start && entry.day <= today)

  return {
    generatedAt: new Date().toISOString(),
    today,
    timezone: METRICS_TIME_ZONE,
    earliestDay: METRICS_EARLIEST_DAY,
    trackingStartedOn: trackingStartRows[0]?.day || null,
    unitPrices: COST_UNIT_PRICES,
    categoryInfo: COST_CATEGORIES,
    summaries: {
      today: summarize(inRange(today)),
      last7: summarize(inRange(shiftDayKey(today, -6))),
      last30: summarize(inRange(last30Start)),
      month: summarize(inRange(monthStart)),
    },
    daily: inRange(last30Start)
      .slice()
      .reverse()
      .map((entry) => ({
        day: entry.day,
        tracked: entry.tracked,
        cost: roundMoney(entry.cost),
        revenue: roundMoney(entry.revenue),
        net: roundMoney(entry.revenue - entry.cost),
        cardsCreated: entry.cardsCreated,
        categories: Object.fromEntries(
          Object.entries(entry.categories).map(([id, value]) => [id, roundMoney(value.cost)]),
        ),
      })),
  }
}
