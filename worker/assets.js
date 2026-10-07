/**
 * Long-lived images (cover thumbs, recipient photos, GCU inside pages) live in R2 (CARD_ASSETS).
 * Anything saved before R2 was bound is still in KV, so reads fall back to the KV key.
 * `where` is { r2Key, kvKey }.
 */

export const putAsset = async (env, where, value, contentType) => {
  if (env.CARD_ASSETS) {
    await env.CARD_ASSETS.put(where.r2Key, value, { httpMetadata: { contentType } })
    return true
  }
  if (env.CARD_STORE) {
    await env.CARD_STORE.put(where.kvKey, value)
    return true
  }
  return false
}

/** type is 'arrayBuffer' or 'text'. Returns { value, contentType } or null. */
export const getAsset = async (env, where, type = 'arrayBuffer') => {
  if (env.CARD_ASSETS) {
    const object = await env.CARD_ASSETS.get(where.r2Key)
    if (object) {
      return {
        value: type === 'text' ? await object.text() : await object.arrayBuffer(),
        contentType: object.httpMetadata?.contentType || null,
      }
    }
  }
  if (env.CARD_STORE) {
    const value = await env.CARD_STORE.get(where.kvKey, type)
    if (value !== null) {
      return { value, contentType: null }
    }
  }
  return null
}

export const hasAsset = async (env, where) => {
  if (env.CARD_ASSETS && (await env.CARD_ASSETS.head(where.r2Key))) {
    return true
  }
  return env.CARD_STORE ? (await env.CARD_STORE.get(where.kvKey, 'stream')) !== null : false
}

export const deleteAsset = async (env, where) => {
  await Promise.all([env.CARD_ASSETS?.delete(where.r2Key), env.CARD_STORE?.delete(where.kvKey)])
}

const ASSET_KINDS = [
  { kvPrefix: 'thumb:', r2Key: (id) => `thumbs/${id}.jpg`, contentType: 'image/jpeg', type: 'arrayBuffer' },
  {
    kvPrefix: 'recipient-photo:',
    r2Key: (rest) => {
      const [recipientId, index] = rest.split(':')
      return `recipient-photos/${recipientId}/${index}`
    },
    contentType: 'text/plain',
    type: 'text',
  },
  { kvPrefix: 'gcu:inside:', r2Key: (pid) => `gcu/inside/${pid}.jpg`, contentType: 'image/jpeg', type: 'arrayBuffer' },
]

/**
 * Copies KV-only assets into R2 (skipping ones already there). With deleteKv, also removes the KV
 * copy once R2 holds an object of the same size. Resumable: pass back the returned cursor.
 */
export const migrateAssetsToR2 = async (env, { kind = 0, cursor, deleteKv = false, limit = 50 } = {}) => {
  if (!env.CARD_ASSETS || !env.CARD_STORE) {
    throw new Error('Both CARD_ASSETS and CARD_STORE must be bound.')
  }
  const spec = ASSET_KINDS[kind]
  if (!spec) {
    return { done: true }
  }
  const page = await env.CARD_STORE.list({ prefix: spec.kvPrefix, cursor, limit })
  const stats = { kind: spec.kvPrefix, copied: 0, alreadyInR2: 0, deletedFromKv: 0, missing: 0 }
  for (const { name } of page.keys) {
    const r2Key = spec.r2Key(name.slice(spec.kvPrefix.length))
    const value = await env.CARD_STORE.get(name, spec.type)
    if (value === null) {
      stats.missing += 1
      continue
    }
    const size = spec.type === 'text' ? new TextEncoder().encode(value).byteLength : value.byteLength
    const existing = await env.CARD_ASSETS.head(r2Key)
    if (existing) {
      stats.alreadyInR2 += 1
    } else {
      await env.CARD_ASSETS.put(r2Key, value, { httpMetadata: { contentType: spec.contentType } })
      stats.copied += 1
    }
    if (deleteKv) {
      const stored = existing || (await env.CARD_ASSETS.head(r2Key))
      // A newer R2 copy can legitimately differ in size (e.g. a replaced thumb); either way R2 wins on read.
      if (stored && (stored.size === size || existing)) {
        await env.CARD_STORE.delete(name)
        stats.deletedFromKv += 1
      }
    }
  }
  const next = page.list_complete ? { kind: kind + 1, cursor: undefined } : { kind, cursor: page.cursor }
  return { ...stats, next, done: page.list_complete && kind + 1 >= ASSET_KINDS.length }
}
