/** Durable cover thumbnails for account history hover previews. */

import { getAsset, hasAsset, putAsset } from './assets.js'

export const COVER_THUMB_MAX_EDGE = 320
export const COVER_THUMB_JPEG_QUALITY = 72

const thumbAsset = (cardId) => ({ r2Key: `thumbs/${cardId}.jpg`, kvKey: `thumb:${cardId}` })

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

export const hasCoverThumb = async (env, cardId) => (cardId ? hasAsset(env, thumbAsset(cardId)) : false)

export const putCoverThumbBytes = async (env, cardId, bytes, contentType = 'image/jpeg') => {
  if (!cardId || !bytes?.byteLength) {
    return false
  }

  // No expiry — thumbs are kept for account history after shared cards expire.
  return putAsset(env, thumbAsset(cardId), bytes, contentType)
}

export const getCoverThumbBytes = async (env, cardId) => {
  if (!cardId) {
    return null
  }

  const found = await getAsset(env, thumbAsset(cardId))
  return found ? { bytes: new Uint8Array(found.value), contentType: found.contentType || 'image/jpeg' } : null
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

export const ensureCoverThumbForRecord = async (env, record, { replace = false } = {}) => {
  const cardId = record?.id
  const imageUrl = record?.card?.imageUrl
  if (!cardId || !imageUrl) {
    return { ok: false, reason: 'missing_card' }
  }

  if (!replace && (await hasCoverThumb(env, cardId))) {
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
