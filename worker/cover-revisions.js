/** Cover revision history — full image bytes retained for 7 days. */

export const COVER_REVISION_TTL_SECONDS = 60 * 60 * 24 * 7
export const COVER_REVISION_MAX_PER_CARD = 40

const revisionIndexKey = (cardId) => `rev-index:${cardId}`
const revisionImageKey = (revisionId) => `rev-image:${revisionId}`

const fallbackRevisionIndex = new Map()
const fallbackRevisionImages = new Map()

const parseDataUrlImage = (imageUrl) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(imageUrl || ''))
  if (!match) {
    return null
  }
  try {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return { mimeType: match[1], bytes }
  } catch {
    return null
  }
}

const createRevisionId = () => crypto.randomUUID()

const readRevisionIndex = async (env, cardId) => {
  if (!cardId) {
    return { cardId: '', revisions: [] }
  }

  if (env.CARD_STORE) {
    const existing = await env.CARD_STORE.get(revisionIndexKey(cardId), 'json')
    if (existing && Array.isArray(existing.revisions)) {
      return existing
    }
  } else {
    const existing = fallbackRevisionIndex.get(cardId)
    if (existing && Array.isArray(existing.revisions)) {
      return existing
    }
  }

  return { cardId, revisions: [] }
}

const writeRevisionIndex = async (env, index) => {
  const payload = {
    cardId: index.cardId,
    revisions: Array.isArray(index.revisions) ? index.revisions.slice(0, COVER_REVISION_MAX_PER_CARD) : [],
    updatedAt: new Date().toISOString(),
  }

  if (env.CARD_STORE) {
    await env.CARD_STORE.put(revisionIndexKey(payload.cardId), JSON.stringify(payload), {
      expirationTtl: COVER_REVISION_TTL_SECONDS,
    })
  } else {
    fallbackRevisionIndex.set(payload.cardId, payload)
  }

  return payload
}

const putRevisionImageBytes = async (env, revisionId, bytes, contentType) => {
  if (env.CARD_STORE) {
    await env.CARD_STORE.put(revisionImageKey(revisionId), bytes, {
      expirationTtl: COVER_REVISION_TTL_SECONDS,
      metadata: { contentType: contentType || 'image/jpeg' },
    })
    return
  }

  fallbackRevisionImages.set(revisionId, {
    bytes,
    contentType: contentType || 'image/jpeg',
    expiresAt: Date.now() + COVER_REVISION_TTL_SECONDS * 1000,
  })
}

/**
 * Persist a full cover snapshot for support / recovery.
 * Images and the per-card index expire after 7 days.
 */
export const appendCoverRevision = async (
  env,
  {
    cardId,
    imageUrl,
    imageBytes = null,
    contentType = '',
    source = 'save',
    refinement = '',
    orderNumber = null,
    details = null,
  } = {},
) => {
  const trimmedCardId = String(cardId || '').trim()
  if (!trimmedCardId) {
    return null
  }

  let bytes = imageBytes instanceof Uint8Array ? imageBytes : null
  let mimeType = String(contentType || '').trim() || 'image/jpeg'

  if (!bytes?.byteLength) {
    const parsed = parseDataUrlImage(imageUrl)
    if (!parsed?.bytes?.byteLength) {
      return null
    }
    bytes = parsed.bytes
    mimeType = parsed.mimeType || mimeType
  }

  const revisionId = createRevisionId()
  const createdAt = new Date().toISOString()
  const entry = {
    id: revisionId,
    cardId: trimmedCardId,
    createdAt,
    source: String(source || 'save').slice(0, 40),
    refinement: String(refinement || '').trim().slice(0, 500),
    contentType: mimeType,
    byteLength: bytes.byteLength,
    orderNumber: orderNumber == null || orderNumber === '' ? null : String(orderNumber),
    details: details
      ? {
          recipientName: String(details.recipientName || '').slice(0, 120),
          senderName: String(details.senderName || '').slice(0, 120),
          occasion: String(details.occasion || '').slice(0, 120),
        }
      : null,
  }

  await putRevisionImageBytes(env, revisionId, bytes, entry.contentType)

  const index = await readRevisionIndex(env, trimmedCardId)
  index.cardId = trimmedCardId
  index.revisions = [entry, ...(index.revisions || [])].slice(0, COVER_REVISION_MAX_PER_CARD)
  await writeRevisionIndex(env, index)

  return entry
}

export const listCoverRevisions = async (env, cardId) => {
  const index = await readRevisionIndex(env, String(cardId || '').trim())
  return index.revisions || []
}

export const getCoverRevisionBytes = async (env, revisionId) => {
  const id = String(revisionId || '').trim()
  if (!id) {
    return null
  }

  if (env.CARD_STORE) {
    const value = await env.CARD_STORE.getWithMetadata(revisionImageKey(id), 'arrayBuffer')
    if (!value?.value) {
      return null
    }
    return {
      bytes: new Uint8Array(value.value),
      contentType: value.metadata?.contentType || 'image/jpeg',
    }
  }

  const local = fallbackRevisionImages.get(id)
  if (!local || (local.expiresAt && local.expiresAt < Date.now())) {
    if (local) {
      fallbackRevisionImages.delete(id)
    }
    return null
  }

  return { bytes: local.bytes, contentType: local.contentType }
}
