const starterCredits = 5

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
    ).bind(userId, phoneE164, now, now, now, starterCredits, starterCredits, client, now),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO credit_events (
        id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, note
      ) VALUES (?, ?, ?, 'grant', 'signup_starter', ?, ?, 'system', 'Starter credits')`,
    ).bind(crypto.randomUUID(), userId, now, starterCredits, starterCredits),
  ])

  return {
    ...mapUser({
      id: userId,
      phone_e164: phoneE164,
      email: '',
      credit_balance: starterCredits,
      status: 'active',
      created_at: now,
      last_used_at: now,
    }),
    isNew: true,
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
    demo_purchase: 'Credit purchase',
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
  }
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

export const applyCreditChange = async (env, { userId, phoneE164, balance, delta, reason, kind, note }) => {
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

  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare(
      `UPDATE users
       SET credit_balance = ?,
           credits_granted = credits_granted + ?,
           credits_purchased = credits_purchased + ?,
           credits_spent = credits_spent + ?,
           last_used_at = ?,
           updated_at = ?
       WHERE id = ?`,
    ).bind(
      nextBalance,
      creditsDelta > 0 && eventKind !== 'purchase' ? creditsDelta : 0,
      creditsDelta > 0 && (eventKind === 'purchase' || reason === 'balance_sync') ? creditsDelta : 0,
      creditsDelta < 0 ? Math.abs(creditsDelta) : 0,
      now,
      now,
      userId,
    ),
    env.ACCOUNT_DB.prepare(
      `INSERT INTO credit_events (
        id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?)`,
    ).bind(crypto.randomUUID(), userId, now, eventKind, reason || 'adjustment', creditsDelta, nextBalance, note || ''),
  ])

  return nextBalance
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
