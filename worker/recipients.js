const RECIPIENT_PHOTO_PREFIX = 'recipient-photo:'
export const MAX_RECIPIENT_PHOTOS = 3
const MAX_TRACKED_CARD_IDS = 100

const isoNow = () => new Date().toISOString()

export const recipientNameKey = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max)

const parseJson = (raw, fallback) => {
  try {
    const parsed = JSON.parse(raw || '')
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

const normalizeMailing = (address) => {
  if (!address || typeof address !== 'object') {
    return null
  }
  const mailing = {
    name: clean(address.name, 120),
    line1: clean(address.line1, 160),
    line2: clean(address.line2, 160),
    city: clean(address.city, 80),
    state: clean(address.state, 2).toUpperCase(),
    zip: clean(address.zip, 10).replace(/\s+/g, ''),
    country: 'US',
  }
  return mailing.line1 && mailing.city && mailing.state && mailing.zip ? mailing : null
}

const sameStreetAddress = (left, right) =>
  Boolean(
    left &&
      right &&
      recipientNameKey(left.line1) === recipientNameKey(right.line1) &&
      String(left.zip || '').slice(0, 5) === String(right.zip || '').slice(0, 5),
  )

const photoKey = (recipientId, index) => `${RECIPIENT_PHOTO_PREFIX}${recipientId}:${index}`

export const ensureRecipientsTable = async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS recipients (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        relation TEXT,
        email TEXT,
        phone_e164 TEXT,
        mailing_json TEXT,
        key_details TEXT,
        tone TEXT,
        image_style TEXT,
        birthday TEXT,
        anniversary TEXT,
        notes TEXT,
        photo_count INTEGER NOT NULL DEFAULT 0,
        card_ids_json TEXT,
        last_card_id TEXT,
        last_occasion TEXT,
        last_sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name_key)
      )`,
    )
    .run()
}

const mapRecipient = (row) => ({
  id: row.id,
  name: row.name,
  relation: row.relation || '',
  email: row.email || '',
  phoneE164: row.phone_e164 || '',
  mailingAddress: parseJson(row.mailing_json, null),
  keyDetails: row.key_details || '',
  tone: row.tone || '',
  imageStyle: row.image_style || '',
  birthday: row.birthday || '',
  anniversary: row.anniversary || '',
  notes: row.notes || '',
  photoCount: row.photo_count || 0,
  cardsCount: parseJson(row.card_ids_json, []).length,
  lastCardId: row.last_card_id || '',
  lastOccasion: row.last_occasion || '',
  lastSentAt: row.last_sent_at || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const getRecipientRow = async (db, userId, recipientId) =>
  db.prepare('SELECT * FROM recipients WHERE id = ? AND user_id = ?').bind(recipientId, userId).first()

const storeRecipientPhotos = async (env, recipientId, photos, previousCount) => {
  const valid = (Array.isArray(photos) ? photos : [])
    .filter((photo) => typeof photo === 'string' && /^data:image\/[a-z+.-]+;base64,/i.test(photo))
    .slice(0, MAX_RECIPIENT_PHOTOS)
  if (!valid.length || !env.CARD_STORE) {
    return previousCount
  }
  await Promise.all(valid.map((photo, index) => env.CARD_STORE.put(photoKey(recipientId, index), photo)))
  for (let index = valid.length; index < Math.max(previousCount, MAX_RECIPIENT_PHOTOS); index += 1) {
    await env.CARD_STORE.delete(photoKey(recipientId, index))
  }
  return valid.length
}

/**
 * Create or update the shopper's saved recipient from a sent or printed card.
 * Contact info that matches the shopper's own phone, email, or address is ignored (sending to yourself).
 */
export const upsertRecipientFromCard = async (
  env,
  { userId, details, cardId, at, email = '', phoneE164 = '', mailingAddress = null, photos = [], sent = true },
) => {
  const name = clean(details?.recipientName, 120)
  if (!env.ACCOUNT_DB || !userId || !name) {
    return null
  }
  const db = env.ACCOUNT_DB
  await ensureRecipientsTable(db)

  const user = await db.prepare('SELECT email, phone_e164, mailing_address_json FROM users WHERE id = ?').bind(userId).first()
  const ownEmail = String(user?.email || '').trim().toLowerCase()
  const ownPhone = String(user?.phone_e164 || '').trim()
  const ownMailing = parseJson(user?.mailing_address_json, null)

  const nextEmail = clean(email, 200).toLowerCase()
  const nextPhone = clean(phoneE164, 20)
  const nextMailing = normalizeMailing(mailingAddress)
  const usableEmail = nextEmail && nextEmail !== ownEmail ? nextEmail : ''
  const usablePhone = nextPhone && nextPhone !== ownPhone ? nextPhone : ''
  const usableMailing = nextMailing && !sameStreetAddress(nextMailing, ownMailing) ? nextMailing : null

  const nameKey = recipientNameKey(name)
  const now = isoNow()
  const eventAt = at || now
  const existing = await db.prepare('SELECT * FROM recipients WHERE user_id = ? AND name_key = ?').bind(userId, nameKey).first()

  const cardIds = parseJson(existing?.card_ids_json, [])
  if (cardId && !cardIds.includes(cardId)) {
    cardIds.push(cardId)
  }
  const isLatest = !existing?.last_sent_at || String(eventAt) >= String(existing.last_sent_at)
  const pick = (incoming, current) => (incoming && (isLatest || !current) ? incoming : current || '')

  const recipientId = existing?.id || crypto.randomUUID()
  const photoCount = await storeRecipientPhotos(env, recipientId, photos, existing?.photo_count || 0)

  const values = {
    relation: pick(clean(details?.recipientType, 80), existing?.relation),
    email: pick(usableEmail, existing?.email),
    phone_e164: pick(usablePhone, existing?.phone_e164),
    mailing_json: usableMailing && (isLatest || !existing?.mailing_json) ? JSON.stringify(usableMailing) : existing?.mailing_json || null,
    key_details: pick(clean(details?.keyDetails, 4000), existing?.key_details),
    tone: pick(clean(details?.tone, 40), existing?.tone),
    image_style: pick(clean(details?.imageStyle, 120), existing?.image_style),
    card_ids_json: JSON.stringify(cardIds.slice(-MAX_TRACKED_CARD_IDS)),
    last_card_id: isLatest ? cardId || existing?.last_card_id || null : existing?.last_card_id || null,
    last_occasion: pick(clean(details?.occasion, 120), existing?.last_occasion),
    last_sent_at: sent && isLatest ? eventAt : existing?.last_sent_at || null,
  }

  if (existing) {
    await db
      .prepare(
        `UPDATE recipients SET relation = ?, email = ?, phone_e164 = ?, mailing_json = ?, key_details = ?, tone = ?,
           image_style = ?, photo_count = ?, card_ids_json = ?, last_card_id = ?, last_occasion = ?, last_sent_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        values.relation || null,
        values.email || null,
        values.phone_e164 || null,
        values.mailing_json,
        values.key_details || null,
        values.tone || null,
        values.image_style || null,
        photoCount,
        values.card_ids_json,
        values.last_card_id,
        values.last_occasion || null,
        values.last_sent_at,
        now,
        recipientId,
      )
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO recipients (
           id, user_id, name, name_key, relation, email, phone_e164, mailing_json, key_details, tone, image_style,
           photo_count, card_ids_json, last_card_id, last_occasion, last_sent_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, name_key) DO NOTHING`,
      )
      .bind(
        recipientId,
        userId,
        name,
        nameKey,
        values.relation || null,
        values.email || null,
        values.phone_e164 || null,
        values.mailing_json,
        values.key_details || null,
        values.tone || null,
        values.image_style || null,
        photoCount,
        values.card_ids_json,
        values.last_card_id,
        values.last_occasion || null,
        values.last_sent_at,
        eventAt < now ? eventAt : now,
        now,
      )
      .run()
  }
  return recipientId
}

export const listRecipients = async (env, userId) => {
  if (!env.ACCOUNT_DB || !userId) {
    return []
  }
  await ensureRecipientsTable(env.ACCOUNT_DB)
  const result = await env.ACCOUNT_DB.prepare(
    'SELECT * FROM recipients WHERE user_id = ? ORDER BY COALESCE(last_sent_at, updated_at) DESC LIMIT 500',
  )
    .bind(userId)
    .all()
  return (result.results || []).map(mapRecipient)
}

export const updateRecipient = async (env, userId, recipientId, fields) => {
  await ensureRecipientsTable(env.ACCOUNT_DB)
  const existing = await getRecipientRow(env.ACCOUNT_DB, userId, recipientId)
  if (!existing) {
    return null
  }
  const name = clean(fields.name ?? existing.name, 120)
  if (!name) {
    throw new Error('Enter the recipient’s name.')
  }
  const nameKey = recipientNameKey(name)
  if (nameKey !== existing.name_key) {
    const clash = await env.ACCOUNT_DB.prepare('SELECT id FROM recipients WHERE user_id = ? AND name_key = ? AND id != ?')
      .bind(userId, nameKey, recipientId)
      .first()
    if (clash) {
      throw new Error(`You already have a recipient named ${name}.`)
    }
  }
  const mailing = fields.mailingAddress === undefined ? parseJson(existing.mailing_json, null) : normalizeMailing(fields.mailingAddress)
  const field = (key, column, max) => (fields[key] === undefined ? existing[column] || '' : clean(fields[key], max))
  await env.ACCOUNT_DB.prepare(
    `UPDATE recipients SET name = ?, name_key = ?, relation = ?, email = ?, phone_e164 = ?, mailing_json = ?,
       key_details = ?, birthday = ?, anniversary = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  )
    .bind(
      name,
      nameKey,
      field('relation', 'relation', 80) || null,
      field('email', 'email', 200).toLowerCase() || null,
      field('phoneE164', 'phone_e164', 20) || null,
      mailing ? JSON.stringify(mailing) : null,
      field('keyDetails', 'key_details', 4000) || null,
      field('birthday', 'birthday', 10) || null,
      field('anniversary', 'anniversary', 10) || null,
      field('notes', 'notes', 2000) || null,
      isoNow(),
      recipientId,
      userId,
    )
    .run()
  return mapRecipient(await getRecipientRow(env.ACCOUNT_DB, userId, recipientId))
}

export const deleteRecipient = async (env, userId, recipientId) => {
  await ensureRecipientsTable(env.ACCOUNT_DB)
  const existing = await getRecipientRow(env.ACCOUNT_DB, userId, recipientId)
  if (!existing) {
    return false
  }
  for (let index = 0; index < MAX_RECIPIENT_PHOTOS; index += 1) {
    await env.CARD_STORE?.delete(photoKey(recipientId, index))
  }
  await env.ACCOUNT_DB.prepare('DELETE FROM recipients WHERE id = ? AND user_id = ?').bind(recipientId, userId).run()
  return true
}

export const deleteRecipientPhoto = async (env, userId, recipientId, index) => {
  await ensureRecipientsTable(env.ACCOUNT_DB)
  const existing = await getRecipientRow(env.ACCOUNT_DB, userId, recipientId)
  if (!existing || !env.CARD_STORE) {
    return null
  }
  const count = existing.photo_count || 0
  const kept = []
  for (let current = 0; current < count; current += 1) {
    if (current !== index) {
      const photo = await env.CARD_STORE.get(photoKey(recipientId, current))
      if (photo) {
        kept.push(photo)
      }
    }
  }
  for (let current = 0; current < MAX_RECIPIENT_PHOTOS; current += 1) {
    if (kept[current]) {
      await env.CARD_STORE.put(photoKey(recipientId, current), kept[current])
    } else {
      await env.CARD_STORE.delete(photoKey(recipientId, current))
    }
  }
  await env.ACCOUNT_DB.prepare('UPDATE recipients SET photo_count = ?, updated_at = ? WHERE id = ?')
    .bind(kept.length, isoNow(), recipientId)
    .run()
  return mapRecipient(await getRecipientRow(env.ACCOUNT_DB, userId, recipientId))
}

/** Returns the photo data URL. Pass userId = null for admin access. */
export const getRecipientPhoto = async (env, userId, recipientId, index) => {
  if (!env.ACCOUNT_DB || !env.CARD_STORE) {
    return null
  }
  await ensureRecipientsTable(env.ACCOUNT_DB)
  const row = userId
    ? await getRecipientRow(env.ACCOUNT_DB, userId, recipientId)
    : await env.ACCOUNT_DB.prepare('SELECT * FROM recipients WHERE id = ?').bind(recipientId).first()
  if (!row || index < 0 || index >= (row.photo_count || 0)) {
    return null
  }
  return env.CARD_STORE.get(photoKey(recipientId, index))
}

/** One-time fill of every shopper's recipients from past sends and printed orders. */
export const backfillRecipients = async (env, { loadCardDetails }) => {
  const db = env.ACCOUNT_DB
  await ensureRecipientsTable(db)
  const deliveries = await db
    .prepare(
      `SELECT user_id, card_id, created_at, method, destination FROM deliveries
       WHERE is_sender_copy = 0 AND status = 'sent' AND user_id IS NOT NULL AND card_id IS NOT NULL`,
    )
    .all()
  let prints = { results: [] }
  try {
    prints = await db
      .prepare('SELECT user_id, card_id, created_at, ship_to_json FROM print_orders WHERE user_id IS NOT NULL')
      .all()
  } catch {
    // No print orders table yet.
  }

  const events = [
    ...(deliveries.results || []).map((row) => ({
      userId: row.user_id,
      cardId: row.card_id,
      at: row.created_at,
      email: row.method === 'email' ? row.destination : '',
      phoneE164: row.method === 'text' ? row.destination : '',
    })),
    ...(prints.results || []).map((row) => ({
      userId: row.user_id,
      cardId: row.card_id,
      at: row.created_at,
      mailingAddress: parseJson(row.ship_to_json, null),
    })),
  ].sort((left, right) => String(left.at).localeCompare(String(right.at)))

  const detailsCache = new Map()
  let saved = 0
  let skipped = 0
  for (const event of events) {
    if (!detailsCache.has(event.cardId)) {
      detailsCache.set(event.cardId, await loadCardDetails(event.cardId))
    }
    const details = detailsCache.get(event.cardId)
    if (!details?.recipientName) {
      skipped += 1
      continue
    }
    await upsertRecipientFromCard(env, { ...event, details })
    saved += 1
  }
  return { events: events.length, saved, skipped }
}

/** Saves recipients that only appear on created-but-never-sent cards (missed before create-time saving). */
export const backfillCreatedCardRecipients = async (env, { loadCardDetails }) => {
  const db = env.ACCOUNT_DB
  await ensureRecipientsTable(db)
  const cards = await db
    .prepare(
      `SELECT c.id, c.user_id, c.created_at, c.recipient_name FROM cards c
       WHERE c.user_id IS NOT NULL AND trim(coalesce(c.recipient_name, '')) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM recipients r
           WHERE r.user_id = c.user_id AND r.name_key = lower(trim(c.recipient_name))
         )
       ORDER BY c.created_at`,
    )
    .all()
  let saved = 0
  let skipped = 0
  for (const row of cards.results || []) {
    const details = (await loadCardDetails(row.id)) || { recipientName: row.recipient_name }
    if (!details?.recipientName) {
      skipped += 1
      continue
    }
    await upsertRecipientFromCard(env, { userId: row.user_id, cardId: row.id, at: row.created_at, details, sent: false })
    saved += 1
  }
  return { cards: (cards.results || []).length, saved, skipped }
}
