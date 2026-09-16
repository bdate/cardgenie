const starterCredits = 2
const phoneVerifyBonusCredits = 2
const newAccountCredits = starterCredits + phoneVerifyBonusCredits

const isoNow = () => new Date().toISOString()

const shortClient = (request) => String(request?.headers?.get?.('user-agent') || '').slice(0, 180)

const shortError = (error) => {
  const message = error instanceof Error ? error.message : String(error || 'error')
  return message.replace(/\s+/g, ' ').slice(0, 120)
}

const mapUser = (row) => {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    phoneE164: row.phone_e164,
    email: row.email || '',
    creditBalance: row.credit_balance ?? 0,
    creditsGranted: row.credits_granted ?? 0,
    creditsPurchased: row.credits_purchased ?? 0,
    creditsSpent: row.credits_spent ?? 0,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

const getUserByPhone = async (db, phoneE164) =>
  db.prepare('SELECT * FROM users WHERE phone_e164 = ?').bind(phoneE164).first()

const getUserById = async (db, userId) => db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()

export const accountDbReady = (env) => Boolean(env.ACCOUNT_DB)

export const upsertUserOnLogin = async (env, { phoneE164, request, existingUserId }) => {
  if (!env.ACCOUNT_DB) {
    return null
  }

  const now = isoNow()
  const client = shortClient(request)
  const existing = await getUserByPhone(env.ACCOUNT_DB, phoneE164)

  if (existing?.status === 'blocked') {
    throw new Error('This number cannot send cards right now. Email support@card-genie.com.')
  }

  if (existing) {
    await env.ACCOUNT_DB.prepare(
      `UPDATE users
       SET last_login_at = ?, last_used_at = ?, last_client = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, now, client, now, existing.id)
      .run()

    return { ...mapUser({ ...existing, last_login_at: now, last_used_at: now }), isNew: false }
  }

  const userId = existingUserId || crypto.randomUUID()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `INSERT INTO users (
        id, phone_e164, created_at, last_used_at, last_login_at, status, signup_source,
        credit_balance, credits_granted, last_client, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'web', ?, ?, ?, ?)`,
    ).bind(userId, phoneE164, now, now, now, newAccountCredits, newAccountCredits, client, now),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO credit_events (
        id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, note
      ) VALUES (?, ?, ?, 'grant', 'signup_starter', ?, ?, 'system', 'Starter credits')`,
    ).bind(crypto.randomUUID(), userId, now, starterCredits, starterCredits),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO credit_events (
        id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, note
      ) VALUES (?, ?, ?, 'grant', 'phone_verify_bonus', ?, ?, 'system', 'Bonus for confirming your mobile number')`,
    ).bind(
      crypto.randomUUID(),
      userId,
      now,
      phoneVerifyBonusCredits,
      newAccountCredits,
    ),
  ])

  return {
    ...mapUser({
      id: userId,
      phone_e164: phoneE164,
      email: '',
      credit_balance: newAccountCredits,
      credits_granted: newAccountCredits,
      credits_purchased: 0,
      credits_spent: 0,
      status: 'active',
      created_at: now,
      last_used_at: now,
    }),
    isNew: true,
    phoneVerifyBonusCredits,
  }
}

export const ensureAccountUser = async (env, { userId, phoneE164 }) => {
  if (!env.ACCOUNT_DB || !userId) {
    return null
  }

  const existing = await getUserById(env.ACCOUNT_DB, userId)
  if (existing) {
    return mapUser(existing)
  }

  if (phoneE164) {
    const byPhone = await getUserByPhone(env.ACCOUNT_DB, phoneE164)
    if (byPhone) {
      return mapUser(byPhone)
    }
  }

  const now = isoNow()
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `INSERT INTO users (
        id, phone_e164, created_at, last_used_at, last_login_at, status, signup_source,
        credit_balance, credits_granted, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'web', ?, ?, ?)`,
    ).bind(userId, phoneE164 || '', now, now, now, starterCredits, starterCredits, now),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO credit_events (
        id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, note
      ) VALUES (?, ?, ?, 'grant', 'signup_starter', ?, ?, 'system', 'Starter credits')`,
    ).bind(crypto.randomUUID(), userId, now, starterCredits, starterCredits),
  ])

  return mapUser({
    id: userId,
    phone_e164: phoneE164 || '',
    email: '',
    credit_balance: starterCredits,
    credits_granted: starterCredits,
    credits_purchased: 0,
    credits_spent: 0,
    status: 'active',
    created_at: now,
    last_used_at: now,
  })
}

const creditReasonLabel = (reason) => {
  const labels = {
    signup_starter: 'Starter credits',
    phone_verify_bonus: 'Phone confirmation bonus',
    demo_purchase: 'Credit purchase',
    stripe_purchase: 'Credit purchase',
    balance_sync: 'Credits added',
    cover_revise: 'Cover change',
    ai_copy: 'AI text change',
    card_send: 'Card sent',
    dev_set: 'Balance adjusted',
  }
  return labels[reason] || reason || 'Credit change'
}

export const getAccountHistory = async (env, userId, phoneE164) => {
  if (!env.ACCOUNT_DB || !userId) {
    return null
  }

  await ensureAccountUser(env, { userId, phoneE164 })
  const byPhone = phoneE164 ? await getUserByPhone(env.ACCOUNT_DB, phoneE164) : null
  const user = byPhone || (await getUserById(env.ACCOUNT_DB, userId))
  if (!user) {
    return null
  }

  userId = user.id

  const [events, cards, deliveries] = await Promise.all([
    env.ACCOUNT_DB.prepare(
      `SELECT created_at, kind, reason, credits_delta, balance_after, note
       FROM credit_events
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
      .bind(userId)
      .all(),
    env.ACCOUNT_DB.prepare(
      `SELECT id, created_at, status, recipient_name, occasion, sender_name
       FROM cards
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
      .bind(userId)
      .all(),
    env.ACCOUNT_DB.prepare(
      `SELECT id, card_id, created_at, method, destination, is_sender_copy, status
       FROM deliveries
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
      .bind(userId)
      .all(),
  ])

  let thankYous = { results: [] }
  try {
    thankYous = await env.ACCOUNT_DB.prepare(
      `SELECT card_id, created_at, preset_id, message, method, status, recipient_name
       FROM thank_yous
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
      .bind(userId)
      .all()
  } catch {
    thankYous = { results: [] }
  }

  return {
    account: mapUser(user),
    creditEvents: (events.results || []).map((row) => ({
      createdAt: row.created_at,
      kind: row.kind,
      reason: row.reason,
      label: creditReasonLabel(row.reason),
      creditsDelta: row.credits_delta,
      balanceAfter: row.balance_after,
      note: row.note || '',
    })),
    cards: (cards.results || []).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      recipientName: row.recipient_name || '',
      occasion: row.occasion || '',
      senderName: row.sender_name || '',
    })),
    deliveries: (deliveries.results || []).map((row) => ({
      id: row.id,
      cardId: row.card_id,
      createdAt: row.created_at,
      method: row.method,
      destination: row.destination,
      isSenderCopy: Boolean(row.is_sender_copy),
      status: row.status,
    })),
    thankYous: (thankYous.results || []).map((row) => ({
      id: row.card_id,
      cardId: row.card_id,
      createdAt: row.created_at,
      presetId: row.preset_id,
      message: row.message || '',
      method: row.method,
      status: row.status,
      recipientName: row.recipient_name || '',
    })),
  }
}

export const getThankYouForCard = async (env, cardId) => {
  if (!env.ACCOUNT_DB || !cardId) {
    return null
  }

  return env.ACCOUNT_DB.prepare('SELECT * FROM thank_yous WHERE card_id = ?').bind(cardId).first()
}

export const getSenderContactForCard = async (env, cardId) => {
  if (!env.ACCOUNT_DB || !cardId) {
    return null
  }

  const card = await env.ACCOUNT_DB.prepare(
    `SELECT id, user_id, recipient_name, sender_name, status
     FROM cards
     WHERE id = ?`,
  )
    .bind(cardId)
    .first()

  if (!card?.user_id) {
    return null
  }

  const user = await getUserById(env.ACCOUNT_DB, card.user_id)
  if (!user) {
    return null
  }

  const senderCopy = await env.ACCOUNT_DB.prepare(
    `SELECT destination
     FROM deliveries
     WHERE card_id = ? AND is_sender_copy = 1 AND status = 'sent'
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(cardId)
    .first()

  const phoneE164 = user.phone_e164 || ''
  const email = user.email || senderCopy?.destination || ''

  if (!phoneE164 && !email) {
    return null
  }

  return {
    cardId: card.id,
    userId: user.id,
    recipientName: card.recipient_name || '',
    senderName: card.sender_name || '',
    phoneE164,
    email,
  }
}

export const recordThankYou = async (
  env,
  { cardId, userId, presetId, message, method, destination, recipientName },
) => {
  if (!env.ACCOUNT_DB || !cardId || !userId) {
    return null
  }

  const now = isoNow()
  try {
    await env.ACCOUNT_DB.prepare(
      `INSERT INTO thank_yous (
        card_id, user_id, created_at, preset_id, message, method, destination, status, recipient_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
    )
      .bind(cardId, userId, now, presetId, message, method, destination, recipientName || '')
      .run()
  } catch (error) {
    const existing = await getThankYouForCard(env, cardId)
    if (existing) {
      const conflict = new Error('A thank-you was already sent for this card.')
      conflict.code = 'already_sent'
      throw conflict
    }
    throw error
  }

  return { cardId, createdAt: now }
}

export const getAccountForSession = async (env, userId) => {
  if (!env.ACCOUNT_DB || !userId) {
    return null
  }

  return mapUser(await getUserById(env.ACCOUNT_DB, userId))
}

const ensureCard = async (env, { userId, record, now }) => {
  const existing = await env.ACCOUNT_DB.prepare('SELECT id FROM cards WHERE id = ?').bind(record.id).first()
  const details = record.details || {}

  if (existing) {
    await env.ACCOUNT_DB.prepare(
      `UPDATE cards
       SET updated_at = ?, recipient_name = ?, occasion = ?, sender_name = ?, status = 'sent'
       WHERE id = ?`,
    )
      .bind(
        now,
        details.recipientName || '',
        details.occasion || '',
        details.senderName || record.signature || '',
        record.id,
      )
      .run()
    return false
  }

  await env.ACCOUNT_DB.prepare(
    `INSERT INTO cards (
      id, user_id, created_at, updated_at, status, recipient_name, occasion, sender_name
    ) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?)`,
  )
    .bind(
      record.id,
      userId,
      record.createdAt || now,
      now,
      details.recipientName || '',
      details.occasion || '',
      details.senderName || record.signature || '',
    )
    .run()

  return true
}

export const recordSuccessfulDelivery = async (env, { userId, phoneE164, record, method, destination, senderCopyEmail }) => {
  if (!env.ACCOUNT_DB || !userId || !record?.id) {
    return
  }

  await ensureAccountUser(env, { userId, phoneE164 })
  const now = isoNow()
  const createdCard = await ensureCard(env, { userId, record, now })
  const copyEmail = senderCopyEmail ? String(senderCopyEmail).trim() : ''
  const statements = [
    env.ACCOUNT_DB.prepare(
      `INSERT INTO deliveries (
        id, user_id, card_id, created_at, method, destination, is_sender_copy, status
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'sent')`,
    ).bind(crypto.randomUUID(), userId, record.id, now, method, destination),
  ]

  if (copyEmail) {
    statements.push(
      env.ACCOUNT_DB.prepare(
        `INSERT INTO deliveries (
          id, user_id, card_id, created_at, method, destination, is_sender_copy, status
        ) VALUES (?, ?, ?, ?, 'email', ?, 1, 'sent')`,
      ).bind(crypto.randomUUID(), userId, record.id, now, copyEmail),
    )
  }

  statements.push(
    env.ACCOUNT_DB.prepare(
      `UPDATE users
       SET last_used_at = ?,
           updated_at = ?,
           last_card_sent_at = ?,
           first_card_sent_at = COALESCE(first_card_sent_at, ?),
           last_card_created_at = CASE WHEN ? = 1 THEN ? ELSE last_card_created_at END,
           first_card_created_at = CASE WHEN ? = 1 THEN COALESCE(first_card_created_at, ?) ELSE first_card_created_at END,
           cards_created_count = cards_created_count + ?,
           cards_sent_count = cards_sent_count + 1,
           copy_to_self_count = copy_to_self_count + ?,
           email = CASE WHEN ? != '' THEN ? ELSE email END,
           email_updated_at = CASE WHEN ? != '' THEN ? ELSE email_updated_at END
       WHERE id = ?`,
    ).bind(
      now,
      now,
      now,
      now,
      createdCard ? 1 : 0,
      now,
      createdCard ? 1 : 0,
      now,
      createdCard ? 1 : 0,
      copyEmail ? 1 : 0,
      copyEmail,
      copyEmail,
      copyEmail,
      now,
      userId,
    ),
  )

  await env.ACCOUNT_DB.batch(statements)
}

export const applyCreditChange = async (
  env,
  { userId, phoneE164, balance, delta, reason, kind, note, paymentId, amountPaidCents },
) => {
  if (!env.ACCOUNT_DB || !userId) {
    return null
  }

  await ensureAccountUser(env, { userId, phoneE164 })
  const user = await getUserById(env.ACCOUNT_DB, userId)
  if (!user) {
    return null
  }

  const current = Number(user.credit_balance) || 0
  const nextBalance = Number.isFinite(balance) ? Math.max(0, Math.floor(balance)) : current + Math.floor(delta || 0)
  const creditsDelta = nextBalance - current
  const now = isoNow()
  const eventKind = kind || (creditsDelta >= 0 ? 'grant' : 'adjustment')
  const paidCents = Number.isFinite(Number(amountPaidCents)) ? Math.max(0, Math.floor(Number(amountPaidCents))) : 0
  const isPurchase = eventKind === 'purchase' || reason === 'stripe_purchase' || reason === 'balance_sync'
  const markPurchase = isPurchase && creditsDelta > 0 ? 1 : 0

  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE users
       SET credit_balance = ?,
           credits_granted = credits_granted + ?,
           credits_purchased = credits_purchased + ?,
           credits_spent = credits_spent + ?,
           amount_paid_cents = amount_paid_cents + ?,
           first_purchase_at = CASE WHEN ? = 1 THEN COALESCE(first_purchase_at, ?) ELSE first_purchase_at END,
           last_purchase_at = CASE WHEN ? = 1 THEN ? ELSE last_purchase_at END,
           last_used_at = ?,
           updated_at = ?
       WHERE id = ?`,
    ).bind(
      nextBalance,
      creditsDelta > 0 && !isPurchase ? creditsDelta : 0,
      creditsDelta > 0 && isPurchase ? creditsDelta : 0,
      creditsDelta < 0 ? Math.abs(creditsDelta) : 0,
      markPurchase ? paidCents : 0,
      markPurchase,
      now,
      markPurchase,
      now,
      now,
      now,
      userId,
    ),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO credit_events (
        id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, payment_id, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      now,
      eventKind,
      reason || 'adjustment',
      creditsDelta,
      nextBalance,
      paymentId || null,
      note || '',
    ),
  ])

  return nextBalance
}

export const findPaymentByStripeCheckoutId = async (env, stripeCheckoutId) => {
  if (!env.ACCOUNT_DB || !stripeCheckoutId) {
    return null
  }

  return (
    (await env.ACCOUNT_DB.prepare(
      `SELECT id, status, credits_purchased, user_id
       FROM payments
       WHERE stripe_checkout_id = ?
       LIMIT 1`,
    )
      .bind(stripeCheckoutId)
      .first()) || null
  )
}

export const recordStripeCreditPurchase = async (
  env,
  {
    userId,
    phoneE164,
    credits,
    amountCents,
    currency = 'usd',
    stripeCheckoutId,
    stripePaymentIntentId,
    stripeCustomerId,
    receiptEmail,
    packId,
    priceId,
  },
) => {
  if (!env.ACCOUNT_DB || !userId || !stripeCheckoutId) {
    return null
  }

  const existing = await findPaymentByStripeCheckoutId(env, stripeCheckoutId)
  if (existing) {
    return { alreadyProcessed: true, paymentId: existing.id, creditBalance: null }
  }

  const paymentId = crypto.randomUUID()
  const now = isoNow()
  const creditAmount = Math.max(0, Math.floor(Number(credits) || 0))
  const paidCents = Math.max(0, Math.floor(Number(amountCents) || 0))

  try {
    await env.ACCOUNT_DB.prepare(
      `INSERT INTO payments (
        id, user_id, created_at, paid_at, status, credits_purchased, amount_cents,
        amount_refunded_cents, currency, stripe_checkout_id, stripe_payment_intent_id,
        stripe_customer_id, receipt_email, failure_code
      ) VALUES (?, ?, ?, ?, 'paid', ?, ?, 0, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        paymentId,
        userId,
        now,
        now,
        creditAmount,
        paidCents,
        currency || 'usd',
        stripeCheckoutId,
        stripePaymentIntentId || null,
        stripeCustomerId || null,
        receiptEmail || null,
      )
      .run()
  } catch (error) {
    const raced = await findPaymentByStripeCheckoutId(env, stripeCheckoutId)
    if (raced) {
      return { alreadyProcessed: true, paymentId: raced.id, creditBalance: null }
    }
    throw error
  }

  const dollars = (paidCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
  })
  const note =
    creditAmount > 0
      ? `${creditAmount} credit pack · ${dollars}`
      : `Credit pack · ${dollars}`
  const creditBalance = await applyCreditChange(env, {
    userId,
    phoneE164,
    delta: creditAmount,
    reason: 'stripe_purchase',
    kind: 'purchase',
    note,
    paymentId,
    amountPaidCents: paidCents,
  })

  return { alreadyProcessed: false, paymentId, creditBalance }
}

export const createTestimonial = async (
  env,
  { name, rating, comment, source, userId, phoneE164 },
) => {
  if (!env.ACCOUNT_DB || !comment) {
    return null
  }

  const id = crypto.randomUUID()
  const now = isoNow()
  await env.ACCOUNT_DB.prepare(
    `INSERT INTO testimonials (
      id, created_at, name, rating, comment, status, user_id, phone_e164, source
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      id,
      now,
      name || null,
      rating == null ? null : rating,
      comment,
      userId || null,
      phoneE164 || null,
      source,
    )
    .run()

  return { id, createdAt: now, status: 'pending' }
}

export const recordFailedDelivery = async (env, { userId, cardId, method, destination, error }) => {
  if (!env.ACCOUNT_DB || !userId) {
    return
  }

  const now = isoNow()
  const errorCode = shortError(error)
  const statements = [
    env.ACCOUNT_DB.prepare(
      `UPDATE users
       SET last_used_at = ?, updated_at = ?, send_failure_count = send_failure_count + 1,
           last_error_at = ?, last_error_code = ?
       WHERE id = ?`,
    ).bind(now, now, now, errorCode, userId),
  ]

  if (cardId && destination) {
    statements.push(
      env.ACCOUNT_DB.prepare(
        `INSERT INTO deliveries (
          id, user_id, card_id, created_at, method, destination, is_sender_copy, status, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'failed', ?)`,
      ).bind(crypto.randomUUID(), userId, cardId, now, method || 'email', destination, errorCode),
    )
  }

  await env.ACCOUNT_DB.batch(statements)
}

const adminPhoneNumbers = new Set(['+19259637453'])

export const isAdminPhone = (phoneE164) => Boolean(phoneE164 && adminPhoneNumbers.has(phoneE164))

const METRICS_TIME_ZONE = 'America/Los_Angeles'

const pacificDayKeyFromDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value || '').slice(0, 10)
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: METRICS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

const buildDayRangeEndingOn = (endDayKey, dayCount) => {
  const count = Math.max(1, Number(dayCount) || 1)
  const [year, month, day] = String(endDayKey)
    .split('-')
    .map((part) => Number(part))
  if (!year || !month || !day) {
    return [pacificDayKeyFromDate()]
  }

  const keys = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, month - 1, day - offset))
    keys.push(date.toISOString().slice(0, 10))
  }
  return keys
}

const resolveMetricsPeriod = (period) => {
  const today = pacificDayKeyFromDate()
  const [year, month, day] = today.split('-').map((part) => Number(part))
  const normalized = String(period || '7d').trim().toLowerCase()

  if (normalized === 'today') {
    return { period: 'today', today, dayKeys: buildDayRangeEndingOn(today, 1) }
  }
  if (normalized === '30d') {
    return { period: '30d', today, dayKeys: buildDayRangeEndingOn(today, 30) }
  }
  if (normalized === 'ytd') {
    const start = Date.UTC(year, 0, 1)
    const end = Date.UTC(year, month - 1, day)
    const days = Math.floor((end - start) / 86400000) + 1
    return { period: 'ytd', today, dayKeys: buildDayRangeEndingOn(today, days) }
  }
  return { period: '7d', today, dayKeys: buildDayRangeEndingOn(today, 7) }
}

const querySinceIso = (firstDayKey) => {
  const [year, month, day] = String(firstDayKey)
    .split('-')
    .map((part) => Number(part))
  // Pull a small buffer so Pacific-day edges near UTC midnight are included.
  return new Date(Date.UTC(year, month - 1, day - 2, 0, 0, 0)).toISOString()
}

const countByPacificDay = (rows, timestampField = 'created_at') => {
  const map = new Map()
  for (const row of rows || []) {
    const raw = row[timestampField] || row.day || row.created_at
    if (!raw) continue
    const key = String(raw).includes('T') ? pacificDayKeyFromDate(raw) : String(raw).slice(0, 10)
    if (!key) continue
    const amount = Number(row.n ?? row.count ?? row.amount ?? 1)
    map.set(key, (map.get(key) || 0) + (Number.isFinite(amount) ? amount : 0))
  }
  return map
}

const seriesFromMap = (dayKeys, map) => dayKeys.map((day) => ({ day, count: map.get(day) || 0 }))

const safeCount = async (db, sql, binds = []) => {
  try {
    const row = await db.prepare(sql).bind(...binds).first()
    return Number(row?.n || 0)
  } catch {
    return 0
  }
}

const safeAll = async (db, sql, binds = []) => {
  try {
    const result = await db.prepare(sql).bind(...binds).all()
    return result?.results || []
  } catch {
    return []
  }
}

const sumMapDay = (map, day) => Number(map.get(day) || 0)

export const getAdminMetrics = async (env, { period = '7d' } = {}) => {
  if (!env.ACCOUNT_DB) {
    return null
  }

  const resolved = resolveMetricsPeriod(period)
  const dayKeysOldestFirst = resolved.dayKeys
  const dayKeys = dayKeysOldestFirst.slice().reverse()
  const today = resolved.today
  const since = querySinceIso(dayKeysOldestFirst[0])
  const db = env.ACCOUNT_DB

  const [
    accountsTotal,
    cardsTotal,
    sendsTotal,
    failedSendsTotal,
    thankYousTotal,
    testimonialsTotal,
    testimonialsPending,
    activeUsers7,
    activeUsers30,
    creditsPurchasedTotal,
    creditsSpentTotal,
    accountRows,
    cardRows,
    sendRows,
    thankYouRows,
    loginRows,
    testimonialRows,
    creditPurchaseRows,
    creditSpendRows,
  ] = await Promise.all([
    safeCount(db, `SELECT COUNT(*) AS n FROM users`),
    safeCount(db, `SELECT COUNT(*) AS n FROM cards`),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM deliveries WHERE is_sender_copy = 0 AND status = 'sent'`,
    ),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM deliveries WHERE is_sender_copy = 0 AND status = 'failed'`,
    ),
    safeCount(db, `SELECT COUNT(*) AS n FROM thank_yous`),
    safeCount(db, `SELECT COUNT(*) AS n FROM testimonials`),
    safeCount(db, `SELECT COUNT(*) AS n FROM testimonials WHERE status = 'pending'`),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM users WHERE last_used_at >= ?`,
      [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()],
    ),
    safeCount(
      db,
      `SELECT COUNT(*) AS n FROM users WHERE last_used_at >= ?`,
      [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()],
    ),
    safeCount(
      db,
      `SELECT COALESCE(SUM(CASE WHEN credits_delta > 0 AND kind = 'purchase' THEN credits_delta ELSE 0 END), 0) AS n
       FROM credit_events`,
    ),
    safeCount(
      db,
      `SELECT COALESCE(SUM(CASE WHEN credits_delta < 0 THEN ABS(credits_delta) ELSE 0 END), 0) AS n
       FROM credit_events`,
    ),
    safeAll(db, `SELECT created_at FROM users WHERE created_at >= ?`, [since]),
    safeAll(db, `SELECT created_at FROM cards WHERE created_at >= ?`, [since]),
    safeAll(
      db,
      `SELECT created_at FROM deliveries
       WHERE is_sender_copy = 0 AND status = 'sent' AND created_at >= ?`,
      [since],
    ),
    safeAll(db, `SELECT created_at FROM thank_yous WHERE created_at >= ?`, [since]),
    safeAll(db, `SELECT last_login_at AS created_at FROM users WHERE last_login_at >= ?`, [since]),
    safeAll(db, `SELECT created_at FROM testimonials WHERE created_at >= ?`, [since]),
    safeAll(
      db,
      `SELECT created_at, credits_delta AS amount FROM credit_events
       WHERE created_at >= ? AND credits_delta > 0 AND kind = 'purchase'`,
      [since],
    ),
    safeAll(
      db,
      `SELECT created_at, ABS(credits_delta) AS amount FROM credit_events
       WHERE created_at >= ? AND credits_delta < 0`,
      [since],
    ),
  ])

  const accountsByDay = countByPacificDay(accountRows)
  const cardsByDay = countByPacificDay(cardRows)
  const sendsByDay = countByPacificDay(sendRows)
  const thankYousByDay = countByPacificDay(thankYouRows)
  const loginsByDay = countByPacificDay(loginRows)
  const testimonialsByDay = countByPacificDay(testimonialRows)
  const creditsPurchasedByDay = countByPacificDay(creditPurchaseRows)
  const creditsSpentByDay = countByPacificDay(creditSpendRows)

  return {
    generatedAt: isoNow(),
    today,
    period: resolved.period,
    timezone: METRICS_TIME_ZONE,
    days: dayKeysOldestFirst.length,
    rangeStart: dayKeysOldestFirst[0],
    rangeEnd: today,
    totals: {
      accounts: accountsTotal,
      cards: cardsTotal,
      sends: sendsTotal,
      failedSends: failedSendsTotal,
      thankYous: thankYousTotal,
      testimonials: testimonialsTotal,
      testimonialsPending,
      activeUsers7,
      activeUsers30,
      creditsPurchased: creditsPurchasedTotal,
      creditsSpent: creditsSpentTotal,
    },
    todayStats: {
      accounts: sumMapDay(accountsByDay, today),
      cards: sumMapDay(cardsByDay, today),
      sends: sumMapDay(sendsByDay, today),
      thankYous: sumMapDay(thankYousByDay, today),
      testimonials: sumMapDay(testimonialsByDay, today),
      logins: sumMapDay(loginsByDay, today),
      creditsPurchased: sumMapDay(creditsPurchasedByDay, today),
      creditsSpent: sumMapDay(creditsSpentByDay, today),
    },
    daily: {
      accounts: seriesFromMap(dayKeys, accountsByDay),
      cards: seriesFromMap(dayKeys, cardsByDay),
      sends: seriesFromMap(dayKeys, sendsByDay),
      thankYous: seriesFromMap(dayKeys, thankYousByDay),
      logins: seriesFromMap(dayKeys, loginsByDay),
      testimonials: seriesFromMap(dayKeys, testimonialsByDay),
      creditsPurchased: seriesFromMap(dayKeys, creditsPurchasedByDay),
      creditsSpent: seriesFromMap(dayKeys, creditsSpentByDay),
    },
  }
}

export const listTestimonials = async (env, { status = 'pending', limit = 50 } = {}) => {
  if (!env.ACCOUNT_DB) {
    return []
  }

  const allowed = new Set(['pending', 'approved', 'rejected'])
  const cleanStatus = allowed.has(status) ? status : 'pending'
  const cleanLimit = Math.min(Math.max(Number(limit) || 50, 1), 100)

  try {
    const result = await env.ACCOUNT_DB.prepare(
      `SELECT id, created_at, name, rating, comment, status, source, phone_e164
       FROM testimonials
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(cleanStatus, cleanLimit)
      .all()

    return (result?.results || []).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      name: row.name || '',
      rating: row.rating == null ? null : Number(row.rating),
      comment: row.comment || '',
      status: row.status,
      source: row.source || '',
      phoneE164: row.phone_e164 || '',
    }))
  } catch {
    return []
  }
}

export const updateTestimonialStatus = async (env, { id, status }) => {
  if (!env.ACCOUNT_DB || !id) {
    return null
  }

  const allowed = new Set(['pending', 'approved', 'rejected'])
  if (!allowed.has(status)) {
    return null
  }

  const existing = await env.ACCOUNT_DB.prepare(`SELECT id, status FROM testimonials WHERE id = ?`)
    .bind(id)
    .first()
  if (!existing) {
    return null
  }

  await env.ACCOUNT_DB.prepare(`UPDATE testimonials SET status = ? WHERE id = ?`).bind(status, id).run()
  return { id, status }
}
