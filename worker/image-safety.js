// Uploaded images are only accepted, stored and served as JPEG, PNG or WebP, judged by their actual bytes.

export const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export const MAX_COVER_IMAGE_BYTES = 12 * 1024 * 1024
export const MAX_PHOTO_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_THUMB_IMAGE_BYTES = 1024 * 1024
export const MAX_PRINT_IMAGE_BYTES = 15 * 1024 * 1024

const OWN_HOSTS = /(^|\.)card-genie\.com$/i

export const sniffImageType = (bytes) => {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return ''
}

const headBytes = (base64) => {
  try {
    const binary = atob(base64.slice(0, 24))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

/** Returns { type, base64 } for a base64 data URL holding a real JPEG/PNG/WebP within maxBytes, else null. */
export const checkDataImage = (value, maxBytes) => {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(typeof value === 'string' ? value : '')
  if (!match) return null
  const base64 = match[2]
  if (Math.floor((base64.length * 3) / 4) > maxBytes) return null
  const type = sniffImageType(headBytes(base64))
  return SAFE_IMAGE_TYPES.has(type) ? { type, base64 } : null
}

/** Content type to serve stored image bytes with; anything unexpected is sent as a plain download. */
export const safeImageContentType = (bytes) => sniffImageType(bytes) || 'application/octet-stream'

/** True for https URLs on card-genie.com or its subdomains, the only hosts the server fetches or redirects to. */
export const isOwnAssetUrl = (value) => {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && OWN_HOSTS.test(url.hostname)
  } catch {
    return false
  }
}
