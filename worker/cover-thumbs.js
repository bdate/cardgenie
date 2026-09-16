/** Durable cover thumbnails for account history hover previews. */

export const COVER_THUMB_MAX_EDGE = 320
export const COVER_THUMB_JPEG_QUALITY = 72

const r2ThumbKey = (cardId) => `thumbs/${cardId}.jpg`
const kvThumbKey = (cardId) => `thumb:${cardId}`

export const getCoverThumbUrl = (request, env, cardId) => {
  if (!cardId) {
    return ''
  }

  // Thumbs must be served by the Worker/API host. www.card-genie.com/c/* is often
  // handled by GitHub Pages for the SPA, which cannot return image bytes.
  const configuredApi = String(env.PUBLIC_API_URL || '').replace(/\/$/, '')
  const requestOrigin = new URL(request.url).origin
  const base = configuredApi || requestOrigin
  return `${base}/c/${encodeURIComponent(cardId)}/thumb`
}

export const hasCoverThumb = async (env, cardId) => {
  if (!cardId) {
    return false
  }

  if (env.CARD_ASSETS) {
    const object = await env.CARD_ASSETS.head(r2ThumbKey(cardId))
    return Boolean(object)
  }

  if (env.CARD_STORE) {
    const existing = await env.CARD_STORE.get(kvThumbKey(cardId))
    return existing !== null
  }

  return false
}

export const putCoverThumbBytes = async (env, cardId, bytes, contentType = 'image/jpeg') => {
  if (!cardId || !bytes?.byteLength) {
    return false
  }

  if (env.CARD_ASSETS) {
    await env.CARD_ASSETS.put(r2ThumbKey(cardId), bytes, {
      httpMetadata: { contentType },
    })
    return true
  }

  if (env.CARD_STORE) {
    // No expirationTtl — keep thumbs for account history after shared cards expire.
    await env.CARD_STORE.put(kvThumbKey(cardId), bytes)
    return true
  }

  return false
}

export const getCoverThumbBytes = async (env, cardId) => {
  if (!cardId) {
    return null
  }

  if (env.CARD_ASSETS) {
    const object = await env.CARD_ASSETS.get(r2ThumbKey(cardId))
    if (!object) {
      return null
    }
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: object.httpMetadata?.contentType || 'image/jpeg',
    }
  }

  if (env.CARD_STORE) {
    const buffer = await env.CARD_STORE.get(kvThumbKey(cardId), 'arrayBuffer')
    if (!buffer) {
      return null
    }
    return { bytes: new Uint8Array(buffer), contentType: 'image/jpeg' }
  }

  return null
}

const parseDataImage = (imageUrl) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')
  if (!match) {
    return null
  }

  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return { mimeType: match[1], bytes }
}

const loadImageBytes = async (imageUrl) => {
  const parsed = parseDataImage(imageUrl)
  if (parsed) {
    return parsed.bytes
  }

  if (/^https?:\/\//.test(imageUrl || '')) {
    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new Error(`Unable to fetch cover image (${response.status}).`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  throw new Error('Cover image format is not supported for thumbnails.')
}

export const createCoverThumbJpeg = async (imageUrl) => {
  const inputBytes = await loadImageBytes(imageUrl)
  const { PhotonImage, SamplingFilter, resize } = await import('@cf-wasm/photon/workerd')
  const inputImage = PhotonImage.new_from_byteslice(inputBytes)

  try {
    const width = inputImage.get_width()
    const height = inputImage.get_height()
    const scale = Math.min(1, COVER_THUMB_MAX_EDGE / Math.max(width, height))
    const nextWidth = Math.max(1, Math.round(width * scale))
    const nextHeight = Math.max(1, Math.round(height * scale))
    const outputImage =
      scale < 1
        ? resize(inputImage, nextWidth, nextHeight, SamplingFilter.Lanczos3)
        : inputImage

    try {
      return outputImage.get_bytes_jpeg(COVER_THUMB_JPEG_QUALITY)
    } finally {
      if (outputImage !== inputImage) {
        outputImage.free()
      }
    }
  } finally {
    inputImage.free()
  }
}

export const ensureCoverThumbForRecord = async (env, record) => {
  const cardId = record?.id
  const imageUrl = record?.card?.imageUrl
  if (!cardId || !imageUrl) {
    return { ok: false, reason: 'missing_card' }
  }

  if (await hasCoverThumb(env, cardId)) {
    return { ok: true, skipped: true }
  }

  try {
    const jpegBytes = await createCoverThumbJpeg(imageUrl)
    const saved = await putCoverThumbBytes(env, cardId, jpegBytes)
    return saved ? { ok: true, created: true } : { ok: false, reason: 'storage_unavailable' }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'thumb_failed',
    }
  }
}

export const putCoverThumbFromDataUrl = async (env, cardId, thumbDataUrl) => {
  const parsed = parseDataImage(thumbDataUrl)
  if (!parsed) {
    return false
  }

  return putCoverThumbBytes(env, cardId, parsed.bytes, parsed.mimeType || 'image/jpeg')
}
