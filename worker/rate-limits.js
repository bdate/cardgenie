// Fixed-window request counters in D1. Every check fails open, so a database hiccup never blocks shoppers.

let tableReady = null

const ensureTable = (db) => {
  if (!tableReady) {
    tableReady = db
      .prepare('CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL)')
      .run()
      .catch((error) => {
        tableReady = null
        throw error
      })
  }
  return tableReady
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)

const windowFor = (key, seconds, now = nowSeconds()) => {
  const window = Math.floor(now / seconds)
  return { k: `${key}:${seconds}:${window}`, expiresAt: (window + 1) * seconds }
}

/** Adds one to the counter and returns the new count. */
export const countHit = async (env, k, expiresAt) => {
  const db = env.ACCOUNT_DB
  if (!db) return 0
  await ensureTable(db)
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (k, n, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(k) DO UPDATE SET n = n + 1
       RETURNING n`,
    )
    .bind(k, expiresAt)
    .first()
  return Number(row?.n) || 1
}

export const addHit = async (env, key, seconds) => {
  try {
    const { k, expiresAt } = windowFor(key, seconds)
    return await countHit(env, k, expiresAt)
  } catch (error) {
    console.error('Rate limit count failed.', error)
    return 0
  }
}

export const peekCount = async (env, key, seconds) => {
  const db = env.ACCOUNT_DB
  if (!db) return 0
  try {
    await ensureTable(db)
    const { k } = windowFor(key, seconds)
    const row = await db.prepare('SELECT n FROM rate_limits WHERE k = ?').bind(k).first()
    return Number(row?.n) || 0
  } catch (error) {
    console.error('Rate limit read failed.', error)
    return 0
  }
}

/**
 * Counts this request against each { max, seconds } window for the key.
 * Returns { retryAfter, seconds } for the first window that is over its max, or null.
 */
export const checkRateLimits = async (env, key, limits) => {
  try {
    const now = nowSeconds()
    let blocked = null
    for (const { max, seconds } of limits) {
      const { k, expiresAt } = windowFor(key, seconds, now)
      const n = await countHit(env, k, expiresAt)
      if (n > max && !blocked) {
        blocked = { retryAfter: Math.max(1, expiresAt - now), seconds }
      }
    }
    return blocked
  } catch (error) {
    console.error('Rate limit check failed; allowing the request.', error)
    return null
  }
}

export const cleanupRateLimits = async (env) => {
  const db = env.ACCOUNT_DB
  if (!db) return
  try {
    await ensureTable(db)
    await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(nowSeconds()).run()
  } catch (error) {
    console.error('Rate limit cleanup failed.', error)
  }
}
