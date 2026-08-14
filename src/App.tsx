import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'

type CardDetails = {
  recipientName: string
  recipientType: string
  senderName: string
  occasion: string
  tone: string
  length: string
  imageStyle: string
  keyDetails: string
}

type GeneratedCard = {
  imageUrl: string
  message: string
  closing?: string
}

type SharedCard = {
  id: string
  shareUrl: string
  details: Partial<CardDetails>
  card: GeneratedCard
  greeting?: string
  signature?: string
}

type ExperienceStep = 'envelope' | 'envelopeFlip' | 'envelopeBack' | 'opening' | 'front' | 'cardOpening' | 'inside'
type EditorTab = 'front' | 'inside'
type CoverRefinementMode = 'revise' | 'new'
type DeliveryMethod = 'email' | 'text'
type DeliveryLog = {
  id: string
  method: DeliveryMethod
  destination: string
  status: 'Sent' | 'Failed'
  message: string
  createdAt: string
}

type ReferencePhoto = {
  id: string
  name: string
  dataUrl: string
}

const initialDetails: CardDetails = {
  recipientName: '',
  recipientType: '',
  senderName: '',
  occasion: '',
  tone: 'Heartfelt',
  length: 'Medium, 20-40 words',
  imageStyle: 'AI chooses the best style for this card',
  keyDetails: '',
}

const toneOptions = ['Heartfelt', 'Playful', 'Elegant', 'Funny', 'Romantic', 'Encouraging', 'Business']
const lengthOptions = ['Short, 5-20 words', 'Medium, 20-40 words', 'Long, 40-70 words']
const styleOptions = [
  'AI chooses the best style for this card',
  'Photorealistic warm portrait photography',
  'Premium editorial illustration',
  'Watercolor greeting card illustration',
  'Comic book art',
  'Whimsical storybook illustration',
  'Animated 3D family-film style',
  'Minimal modern flat vector art',
  'Elegant botanical paper-cut style',
  'Cozy hand-drawn colored pencil',
  'Retro travel poster style',
  'Claymation-inspired 3D scene',
  'Luxury foil and paper collage',
  'Soft pastel nursery-book illustration',
  'Bold graphic poster art',
  'Vintage greeting card illustration',
]
const initialCreditBalance = 50
const creditPackAmount = 50
const cardGenerationCost = 10
const revisionCost = 2
const maxReferencePhotos = 3
const referencePhotoMaxEdge = 1280
const referencePhotoMinEdge = 240
const referencePhotoJpegQuality = 0.8
const maxReferencePhotoDataUrlLength = 480000

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const apiUrl = (path: string) => `${apiBaseUrl}${path}`
const hostedApiMessage =
  'This online demo needs a deployed API server before Card Genie can generate cards. Run it locally with the Express server, or connect VITE_API_BASE_URL to a hosted backend.'
const getSharedCardId = () => {
  const queryId = new URLSearchParams(window.location.search).get('card')

  if (queryId) {
    return queryId
  }

  const pathMatch = window.location.pathname.match(/^\/c\/([^/]+)\/?$/)
  return pathMatch ? decodeURIComponent(pathMatch[1]) : null
}
const staticPageRedirects: Record<string, string> = {
  '/privacy': '/privacy/index.html',
  '/privacy/': '/privacy/index.html',
  '/sms-opt-in': '/sms-opt-in/index.html',
  '/sms-opt-in/': '/sms-opt-in/index.html',
  '/styles': '/styles/index.html',
  '/styles/': '/styles/index.html',
  '/terms': '/terms/index.html',
  '/terms/': '/terms/index.html',
}

const staticPageRedirect = staticPageRedirects[window.location.pathname]

if (staticPageRedirect) {
  window.location.replace(staticPageRedirect)
}

const getApiJson = async (response: Response, fallbackMessage: string) => {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  if (!response.ok) {
    throw new Error(window.location.hostname.endsWith('github.io') && !apiBaseUrl ? hostedApiMessage : fallbackMessage)
  }

  throw new Error(fallbackMessage)
}

const getFriendlyErrorMessage = (error: unknown, fallbackMessage: string) => {
  const message = error instanceof Error ? error.message.trim() : ''
  const name = error instanceof Error ? error.name : ''

  if (name === 'AbortError') {
    return 'The request was interrupted. If you left Card Genie, come back to this page and we will check for your card.'
  }

  if (
    name === 'TypeError' ||
    /^(load failed|failed to fetch|networkerror when attempting to fetch resource|network request failed)$/i.test(
      message,
    )
  ) {
    return 'The card request did not go through. Check your connection and try again. If you added a photo, try a smaller picture or generate without it.'
  }

  if (/timeout|timed out|504|524/i.test(message)) {
    return 'That wish took too long. Please try again in a moment. Your wish is still in the lamp.'
  }

  return message || fallbackMessage
}

const generationJobStorageKey = 'cardgenie.generationJob'
const generateJobPollMs = 2000
const generateJobClientTimeoutMs = 12 * 60 * 1000
const generateJobMaxPollFailures = 15
const generationLostConnectionMessage =
  'We lost the connection while checking on your card. Come back to this page — if it finished, it will appear. No wishes are used until the card is ready.'

const readStoredGenerationJob = () => {
  try {
    const raw =
      window.localStorage.getItem(generationJobStorageKey) ||
      window.sessionStorage.getItem(generationJobStorageKey)
    const parsed = raw
      ? (JSON.parse(raw) as { jobId?: string; startedAt?: number; details?: CardDetails })
      : null

    if (parsed?.jobId) {
      return {
        jobId: parsed.jobId,
        startedAt: parsed.startedAt || Date.now(),
        details: parsed.details,
      }
    }
  } catch {
    // Ignore unreadable storage.
  }

  return null
}

const writeStoredGenerationJob = (jobId: string, cardDetails?: CardDetails) => {
  const payload = JSON.stringify({
    jobId,
    startedAt: Date.now(),
    details: cardDetails || null,
  })

  try {
    window.localStorage.setItem(generationJobStorageKey, payload)
  } catch {
    // Private browsing or full storage should not stop this session's poll.
  }

  try {
    window.sessionStorage.setItem(generationJobStorageKey, payload)
  } catch {
    // Ignore session storage failures; localStorage or in-memory polling can still work.
  }
}

const clearStoredGenerationJob = () => {
  try {
    window.localStorage.removeItem(generationJobStorageKey)
  } catch {
    // Ignore storage failures while clearing a finished or failed job.
  }

  try {
    window.sessionStorage.removeItem(generationJobStorageKey)
  } catch {
    // Ignore storage failures while clearing a finished or failed job.
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

type RetryableError = Error & { retryable?: boolean }

const waitForGenerationJob = async (jobId: string, isCurrent: () => boolean) => {
  const startedAt = Date.now()
  let failures = 0

  while (isCurrent()) {
    if (Date.now() - startedAt > generateJobClientTimeoutMs) {
      throw new Error(
        'That wish took too long. Please try generating again. Your wish is still in the lamp.',
      )
    }

    try {
      const response = await fetch(apiUrl(`/api/generate-jobs/${encodeURIComponent(jobId)}`))
      const data = await getApiJson(response, 'Unable to check on your card.')

      if (!data || typeof data !== 'object') {
        const error = new Error('Unable to check on your card.') as RetryableError
        error.retryable = true
        throw error
      }

      if (response.status === 404) {
        throw new Error(
          data.error && data.error !== 'Not found'
            ? data.error
            : 'We could not find that card job. It may have expired. Please generate again.',
        )
      }

      if (!response.ok) {
        const error = new Error(data.error || 'Unable to check on your card.') as RetryableError
        error.retryable = true
        throw error
      }

      failures = 0

      if (data.status === 'failed') {
        throw new Error(data.error || 'Unable to generate the card. Please try again.')
      }

      if (data.status === 'complete') {
        if (!data.imageUrl || !data.message) {
          throw new Error(
            'The card finished, but the cover or inside message was missing. Please try generating again.',
          )
        }

        return data as { message: string; closing?: string; imageUrl: string }
      }
    } catch (error) {
      const retryable =
        Boolean((error as RetryableError).retryable) ||
        error instanceof TypeError ||
        (error instanceof Error &&
          /^(load failed|failed to fetch|networkerror when attempting to fetch resource|network request failed|unable to check on your card)/i.test(
            error.message,
          ))

      if (!retryable) {
        throw error
      }

      failures += 1

      if (failures >= generateJobMaxPollFailures) {
        throw new Error(generationLostConnectionMessage)
      }
    }

    await sleep(generateJobPollMs)
  }

  throw new Error('The card request was interrupted. Please try generating the card again.')
}

const stripCodeFence = (value: string) =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

const cleanGeneratedMessage = (message: string) => {
  const unfenced = stripCodeFence(message)
  const jsonStart = unfenced.indexOf('{')
  const jsonEnd = unfenced.lastIndexOf('}')

  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(unfenced.slice(jsonStart, jsonEnd + 1))

      if (typeof parsed.message === 'string') {
        return parsed.message.trim()
      }
    } catch {
      // Fall through to display-safe cleanup below.
    }
  }

  return unfenced.replace(/^["'`]+|["'`]+$/g, '').trim()
}

const splitMessageParts = (message: string, senderName: string) => {
  const senderPattern = senderName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let cleanMessage = cleanGeneratedMessage(message)
    .replace(/\[your name\]/gi, '')
    .replace(/^\s*dear\s+[^,\n]+,?\s*/i, '')
    .trim()

  if (senderPattern) {
    cleanMessage = cleanMessage.replace(new RegExp(`\\s*,?\\s*${senderPattern}\\s*$`, 'i'), '').trim()
  }

  const closingMatch = cleanMessage.match(
    /\s*(with all my love|with love|love|sincerely|warmly|best|cheers|thinking of you),?\s*$/i,
  )

  if (!closingMatch) {
    return {
      body: cleanMessage,
      closing: 'With love,',
    }
  }

  return {
    body: cleanMessage.slice(0, closingMatch.index).trim(),
    closing: `${closingMatch[1]},`,
  }
}

const splitIntoParagraphs = (message: string) => {
  const explicitParagraphs = message
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  if (explicitParagraphs.length > 1) {
    return explicitParagraphs
  }

  const sentences = message
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  if (sentences.length <= 2) {
    return [message.trim()].filter(Boolean)
  }

  const paragraphs: string[] = []
  for (let index = 0; index < sentences.length; index += 2) {
    paragraphs.push(sentences.slice(index, index + 2).join(' '))
  }

  return paragraphs
}

const normalizeCardCopy = (message: string, closing: string | undefined, senderName: string) => {
  const parts = splitMessageParts(message, senderName)
  return {
    message: parts.body,
    closing: (closing || '').trim() || parts.closing,
  }
}

const sanitizeFilePart = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'card'

const getImageExtension = (imageUrl: string) => {
  const match = imageUrl.match(/^data:image\/([a-z0-9+.-]+);/i)
  const extension = match?.[1]?.toLowerCase()

  if (extension === 'jpeg') {
    return 'jpg'
  }

  return extension || 'png'
}

const getImageMimeType = (imageUrl: string) => {
  const match = imageUrl.match(/^data:(image\/[a-z0-9+.-]+);/i)
  return match?.[1] || 'image/png'
}

const imageUrlToFile = async (imageUrl: string, fileName: string) => {
  const response = await fetch(imageUrl)
  const blob = await response.blob()
  return new File([blob], fileName, { type: blob.type || getImageMimeType(imageUrl) })
}

const assertUsableReferencePhoto = (width: number, height: number) => {
  if (width < referencePhotoMinEdge || height < referencePhotoMinEdge) {
    throw new Error('This photo is too small. Please use a closer, clearer photo of the person.')
  }
}

const bitmapToJpegDataUrl = (
  source: CanvasImageSource,
  width: number,
  height: number,
  maxEdge = referencePhotoMaxEdge,
  quality = referencePhotoJpegQuality,
) => {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('Unable to prepare that photo.')
  }

  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

const compressReferencePhoto = (
  source: CanvasImageSource,
  width: number,
  height: number,
) => {
  let maxEdge = referencePhotoMaxEdge
  let quality = referencePhotoJpegQuality
  let dataUrl = bitmapToJpegDataUrl(source, width, height, maxEdge, quality)

  while (dataUrl.length > maxReferencePhotoDataUrlLength && (maxEdge > 640 || quality > 0.5)) {
    if (dataUrl.length > maxReferencePhotoDataUrlLength * 1.6 && maxEdge > 640) {
      maxEdge = Math.max(640, Math.round(maxEdge * 0.8))
    } else {
      quality = Math.max(0.5, quality - 0.08)
    }

    dataUrl = bitmapToJpegDataUrl(source, width, height, maxEdge, quality)
  }

  return dataUrl
}

const resizeReferencePhoto = async (file: File) => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      assertUsableReferencePhoto(bitmap.width, bitmap.height)
      const dataUrl = compressReferencePhoto(bitmap, bitmap.width, bitmap.height)
      const prepared = { dataUrl, width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return prepared
    } catch (error) {
      if (error instanceof Error && /too small|Unable to prepare/i.test(error.message)) {
        throw error
      }
    }
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Unable to read that photo.'))
    reader.readAsDataURL(file)
  })

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('Please choose a photo file, such as a JPG or PNG.'))
    element.src = dataUrl
  })

  assertUsableReferencePhoto(image.naturalWidth, image.naturalHeight)
  return {
    dataUrl: compressReferencePhoto(image, image.naturalWidth, image.naturalHeight),
    width: image.naturalWidth,
    height: image.naturalHeight,
  }
}

const downloadImageFallback = (imageUrl: string, fileName: string) => {
  const link = document.createElement('a')
  link.href = imageUrl
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
}

const isMobileDevice = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

type ScreenWakeLock = {
  released: boolean
  release: () => Promise<void>
}

const requestScreenWakeLock = async () => {
  const nav = navigator as Navigator & {
    wakeLock?: {
      request: (type: 'screen') => Promise<ScreenWakeLock>
    }
  }

  if (!nav.wakeLock) {
    return null
  }

  return nav.wakeLock.request('screen')
}

const formatEmailAddress = (email: string) => email.trim().toLowerCase()

const validateEmailAddress = (email: string) => {
  const formatted = formatEmailAddress(email)

  if (!formatted) {
    return { ok: false as const, message: 'Enter the recipient email address.' }
  }

  if (/\s/.test(formatted)) {
    return { ok: false as const, message: 'Remove spaces from the email address.' }
  }

  if (!formatted.includes('@')) {
    return { ok: false as const, message: 'Email is missing the @ symbol. Example: jamie@example.com' }
  }

  const [localPart, domainPart, ...extraParts] = formatted.split('@')

  if (!localPart || !domainPart || extraParts.length > 0) {
    return { ok: false as const, message: 'Enter a complete email address. Example: jamie@example.com' }
  }

  if (!domainPart.includes('.')) {
    return {
      ok: false as const,
      message: 'Email domain is missing a period. Did you mean something like example.com?',
    }
  }

  if (domainPart.startsWith('.') || domainPart.endsWith('.') || domainPart.includes('..')) {
    return { ok: false as const, message: 'Check the email domain. Example: jamie@example.com' }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formatted)) {
    return { ok: false as const, message: 'Enter a valid email address. Example: jamie@example.com' }
  }

  const topLevelDomain = domainPart.split('.').at(-1) || ''

  if (topLevelDomain.length < 2) {
    return {
      ok: false as const,
      message: 'Email ending looks incomplete. Did you mean .com, .net, or .org?',
    }
  }

  return { ok: true as const, value: formatted }
}

const getPhoneDigits = (phoneNumber: string) => phoneNumber.replace(/\D/g, '')

const formatPhoneNumberDisplay = (phoneNumber: string) => {
  const digits = getPhoneDigits(phoneNumber)
  const national =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.length === 10
        ? digits
        : ''

  if (!national) {
    return phoneNumber.trim()
  }

  return `+1 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`
}

const formatPhoneNumberE164 = (phoneNumber: string) => {
  const digits = getPhoneDigits(phoneNumber)

  if (digits.length === 10) {
    return `+1${digits}`
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }

  if (/^\+[1-9]\d{7,14}$/.test(phoneNumber.trim())) {
    return phoneNumber.trim()
  }

  return ''
}

const validatePhoneNumber = (phoneNumber: string) => {
  const trimmed = phoneNumber.trim()

  if (!trimmed) {
    return { ok: false as const, message: 'Enter the recipient cellphone number.' }
  }

  const digits = getPhoneDigits(trimmed)

  if (digits.length < 10) {
    return {
      ok: false as const,
      message: 'Cellphone number looks incomplete. Use 10 digits, like (925) 555-1234.',
    }
  }

  if (digits.length === 11 && !digits.startsWith('1')) {
    return {
      ok: false as const,
      message: 'US cellphone numbers should start with 1 or use 10 digits. Example: (925) 555-1234.',
    }
  }

  if (digits.length > 11) {
    return {
      ok: false as const,
      message: 'Cellphone number has too many digits. Use a US number like (925) 555-1234.',
    }
  }

  const e164 = formatPhoneNumberE164(trimmed)

  if (!e164) {
    return {
      ok: false as const,
      message: 'Enter a valid US cellphone number. Example: (925) 555-1234.',
    }
  }

  return {
    ok: true as const,
    value: e164,
    display: formatPhoneNumberDisplay(e164),
  }
}

const wrapCanvasText = (context: CanvasRenderingContext2D, text: string, maxWidth: number) => {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word

    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }

  if (line) {
    lines.push(line)
  }

  return lines
}

const drawCenteredLines = (
  context: CanvasRenderingContext2D,
  lines: string[],
  centerX: number,
  startY: number,
  lineHeight: number,
) => {
  lines.forEach((line, index) => {
    context.fillText(line, centerX, startY + index * lineHeight)
  })
}

const createInsideImageUrl = ({
  greeting,
  paragraphs,
  closing,
  signature,
}: {
  greeting: string
  paragraphs: string[]
  closing: string
  signature: string
}) => {
  if (typeof document === 'undefined') {
    return ''
  }

  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 1500
  const context = canvas.getContext('2d')

  if (!context) {
    return ''
  }

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height)
  gradient.addColorStop(0, '#fffdf6')
  gradient.addColorStop(0.52, '#fdf7ef')
  gradient.addColorStop(1, '#eefaf7')
  context.fillStyle = gradient
  context.fillRect(0, 0, canvas.width, canvas.height)

  const cornerGlow = context.createRadialGradient(930, 190, 40, 930, 190, 520)
  cornerGlow.addColorStop(0, 'rgba(245, 158, 51, 0.18)')
  cornerGlow.addColorStop(1, 'rgba(245, 158, 51, 0)')
  context.fillStyle = cornerGlow
  context.fillRect(0, 0, canvas.width, canvas.height)

  context.strokeStyle = 'rgba(63, 155, 145, 0.3)'
  context.lineWidth = 4
  context.strokeRect(70, 70, canvas.width - 140, canvas.height - 140)

  context.fillStyle = '#2d6762'
  context.textAlign = 'center'
  context.textBaseline = 'top'

  let y = 190
  const maxTextWidth = 840

  if (greeting.trim()) {
    context.font = '44px Georgia, serif'
    const greetingLines = wrapCanvasText(context, greeting.trim(), maxTextWidth)
    drawCenteredLines(context, greetingLines, canvas.width / 2, y, 58)
    y += greetingLines.length * 58 + 36
  }

  context.font = '42px Georgia, serif'
  for (const paragraph of paragraphs) {
    const lines = wrapCanvasText(context, paragraph, maxTextWidth)
    drawCenteredLines(context, lines, canvas.width / 2, y, 58)
    y += lines.length * 58 + 34
  }

  context.font = '40px Georgia, serif'
  const closingLines = wrapCanvasText(context, closing, maxTextWidth)
  drawCenteredLines(context, closingLines, canvas.width / 2, Math.max(y + 22, 1110), 52)

  context.fillStyle = '#d88a31'
  context.font = '70px cursive'
  const signatureLines = wrapCanvasText(context, signature, maxTextWidth)
  drawCenteredLines(context, signatureLines, canvas.width / 2, 1220, 82)

  return canvas.toDataURL('image/png')
}

function App() {
  const sharedCardId = useMemo(() => getSharedCardId(), [])
  const isRecipientView = Boolean(sharedCardId)
  const [details, setDetails] = useState<CardDetails>(initialDetails)
  const [card, setCard] = useState<GeneratedCard | null>(null)
  const [step, setStep] = useState<ExperienceStep>('envelope')
  const [hasViewedInside, setHasViewedInside] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showCompletionNote, setShowCompletionNote] = useState(false)
  const [activeGenerationStep, setActiveGenerationStep] = useState(0)
  const [imageRefinement, setImageRefinement] = useState('')
  const [coverRefinementMode, setCoverRefinementMode] = useState<CoverRefinementMode>('revise')
  const [copyRefinement, setCopyRefinement] = useState('')
  const [isRefiningImage, setIsRefiningImage] = useState(false)
  const [isRefiningCopy, setIsRefiningCopy] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [editorTab, setEditorTab] = useState<EditorTab>('front')
  const [showPolishDialog, setShowPolishDialog] = useState(false)
  const [cardGreeting, setCardGreeting] = useState<string | null>(null)
  const [cardSignature, setCardSignature] = useState<string | null>(null)
  const [credits, setCredits] = useState(initialCreditBalance)
  const [creditNotice, setCreditNotice] = useState('You have 50 starter wishes for this demo.')
  const [error, setError] = useState('')
  const [sharedCard, setSharedCard] = useState<SharedCard | null>(null)
  const [isLoadingSharedCard, setIsLoadingSharedCard] = useState(false)
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('email')
  const [deliveryDestination, setDeliveryDestination] = useState('')
  const [smsConsentConfirmed, setSmsConsentConfirmed] = useState(false)
  const [isDelivering, setIsDelivering] = useState(false)
  const [deliveryNotice, setDeliveryNotice] = useState('')
  const [deliveryLogs, setDeliveryLogs] = useState<DeliveryLog[]>([])
  const [saveNotice, setSaveNotice] = useState('')
  const [referencePhotos, setReferencePhotos] = useState<ReferencePhoto[]>([])
  const [referencePhotoNotice, setReferencePhotoNotice] = useState('')
  const [isAddingPhotos, setIsAddingPhotos] = useState(false)
  const [photoAddElapsed, setPhotoAddElapsed] = useState(0)
  const screenWakeLockRef = useRef<ScreenWakeLock | null>(null)
  const generationPollIdRef = useRef(0)
  const previewPanelRef = useRef<HTMLElement | null>(null)
  const followGenerationJobRef = useRef<(jobId: string, signatureName: string) => Promise<void>>(
    async () => undefined,
  )

  const recipientLabel = useMemo(
    () => details.recipientName.trim() || details.recipientType.trim() || 'Someone special',
    [details.recipientName, details.recipientType],
  )
  const envelopeLabel = useMemo(
    () => details.recipientName.trim() || details.recipientType.trim() || 'Someone special',
    [details.recipientName, details.recipientType],
  )
  const senderLabel = useMemo(() => details.senderName.trim() || 'Your Name', [details.senderName])
  const stampSrc = `${import.meta.env.BASE_URL}stamp.webp`
  const defaultGreeting = ''
  const insideGreeting = cardGreeting ?? defaultGreeting
  const cardSignatureLabel = cardSignature ?? senderLabel
  const cardMessage = card?.message ?? ''
  const cardClosing = card?.closing ?? 'With love,'
  const messageParagraphs = useMemo(() => splitIntoParagraphs(cardMessage), [cardMessage])
  const messageDensity = cardMessage.length > 620 ? 'is-long' : cardMessage.length > 420 ? 'is-medium' : 'is-short'
  const fileNameBase = useMemo(
    () => sanitizeFilePart(`${recipientLabel}-${details.occasion || 'card'}`),
    [details.occasion, recipientLabel],
  )
  const coverDownloadName = card ? `${fileNameBase}-cover.${getImageExtension(card.imageUrl)}` : 'card-cover.png'
  const insideDownloadName = `${fileNameBase}-inside.png`
  const prefersPhotoSave = useMemo(() => isMobileDevice(), [])
  const coverSaveLabel = prefersPhotoSave ? 'Save cover to photos' : 'Save cover image'
  const insideSaveLabel = prefersPhotoSave ? 'Save inside to photos' : 'Save inside image'
  const insideDownloadUrl = useMemo(
    () =>
      card && isRecipientView
        ? createInsideImageUrl({
            greeting: insideGreeting,
            paragraphs: messageParagraphs,
            closing: cardClosing,
            signature: cardSignatureLabel,
          })
        : '',
    [card, cardSignatureLabel, cardClosing, insideGreeting, isRecipientView, messageParagraphs],
  )
  const generationLines = useMemo(
    () => [
      `Crafting a ${details.occasion || 'card'} cover for ${envelopeLabel}.`,
      `Writing a ${details.tone.toLowerCase()} note that sounds personal, not canned.`,
      `Blending the ${details.imageStyle.toLowerCase()} look with the story you shared.`,
      'Sealing it into an envelope.',
    ],
    [details.imageStyle, details.occasion, details.tone, envelopeLabel],
  )
  const hasEnoughCreditsForCard = credits >= cardGenerationCost
  const hasEnoughCreditsForRevision = credits >= revisionCost
  const showProofPanel = isRecipientView || isGenerating || isLoadingSharedCard || Boolean(card)
  const showSendActions = (step === 'front' || step === 'inside') && hasViewedInside
  const keepScreenAwake = isGenerating || isRefiningImage || isRefiningCopy || isDelivering

  useEffect(() => {
    if (step === 'inside') {
      setHasViewedInside(true)
    }
  }, [step])

  useEffect(() => {
    if (!keepScreenAwake) {
      return
    }

    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') {
        return
      }

      try {
        if (screenWakeLockRef.current && !screenWakeLockRef.current.released) {
          return
        }

        const wakeLock = await requestScreenWakeLock()

        if (cancelled) {
          await wakeLock?.release()
          return
        }

        screenWakeLockRef.current = wakeLock
      } catch {
        // Unsupported, denied, or battery saver — card generation can still continue.
      }
    }

    const release = async () => {
      try {
        await screenWakeLockRef.current?.release()
      } catch {
        // Already released by the browser.
      }

      screenWakeLockRef.current = null
    }

    void acquire()

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void acquire()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      void release()
    }
  }, [keepScreenAwake])

  useEffect(() => {
    if (!isGenerating) {
      return
    }

    const timer = window.setInterval(() => {
      setActiveGenerationStep((current) => (current + 1) % generationLines.length)
    }, 4400)

    return () => window.clearInterval(timer)
  }, [generationLines.length, isGenerating])

  useEffect(() => {
    if (!isGenerating || !window.matchMedia('(max-width: 980px)').matches) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      previewPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [isGenerating])

  useEffect(() => {
    if (!isAddingPhotos) {
      setPhotoAddElapsed(0)
      return
    }

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setPhotoAddElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)

    return () => window.clearInterval(timer)
  }, [isAddingPhotos])

  useEffect(() => {
    if (!sharedCardId) {
      return
    }

    const loadSharedCard = async () => {
      setIsLoadingSharedCard(true)
      setError('')

      try {
        const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(sharedCardId)}`))
        const data = await getApiJson(response, 'Unable to load the shared card.')

        if (!response.ok) {
          throw new Error(data.error || 'Unable to load the shared card.')
        }

        const shared = data as SharedCard
        setSharedCard(shared)
        setDetails((current) => ({
          ...current,
          recipientName: shared.details.recipientName || current.recipientName,
          recipientType: shared.details.recipientType || current.recipientType,
          senderName: shared.details.senderName || current.senderName,
          occasion: shared.details.occasion || current.occasion,
        }))
        const copy = normalizeCardCopy(
          shared.card.message,
          shared.card.closing,
          shared.details.senderName || senderLabel,
        )
        setCard({
          ...shared.card,
          message: copy.message,
          closing: copy.closing,
        })
        setCardGreeting(shared.greeting || null)
        setCardSignature(shared.signature || null)
        setShowEditor(false)
        setShowCompletionNote(false)
        setStep('envelope')
      } catch (caughtError) {
        setError(getFriendlyErrorMessage(caughtError, 'Unable to load the shared card.'))
      } finally {
        setIsLoadingSharedCard(false)
      }
    }

    void loadSharedCard()
  }, [sharedCardId])

  useEffect(() => {
    if (isRecipientView) {
      return
    }

    const stored = readStoredGenerationJob()
    if (!stored?.jobId) {
      return
    }

    if (Date.now() - stored.startedAt > generateJobClientTimeoutMs) {
      clearStoredGenerationJob()
      setError('A previous card took too long to finish. Please try again. Your wish is still in the lamp.')
      return
    }

    if (stored.details) {
      setDetails((current) => ({
        ...current,
        ...stored.details,
      }))
    }

    const signatureName = stored.details?.senderName?.trim() || 'Your Name'
    void followGenerationJobRef.current(stored.jobId, signatureName)
  }, [isRecipientView])

  const updateDetails = (field: keyof CardDetails, value: string) => {
    setDetails((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const referenceImagePayload = referencePhotos.map((photo) => photo.dataUrl)

  const addReferencePhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''

    if (files.length === 0) {
      return
    }

    const remainingSlots = maxReferencePhotos - referencePhotos.length

    if (remainingSlots <= 0) {
      setReferencePhotoNotice('You can add up to 3 photos.')
      return
    }

    const acceptedFiles = files.slice(0, remainingSlots)
    const limitNotice = files.length > remainingSlots ? 'You can add up to 3 photos.' : ''
    setReferencePhotoNotice(limitNotice)
    const startedAt = Date.now()
    setIsAddingPhotos(true)

    try {
      const preparedPhotos = await Promise.all(
        acceptedFiles.map(async (file) => {
          if (file.type && !file.type.startsWith('image/')) {
            throw new Error('Please choose a photo file, such as a JPG or PNG.')
          }

          const prepared = await resizeReferencePhoto(file)

          return {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: file.name || 'Photo',
            dataUrl: prepared.dataUrl,
            isWide: prepared.width > prepared.height * 1.2,
          }
        }),
      )
      const nextPhotos = preparedPhotos.map(({ id, name, dataUrl }) => ({ id, name, dataUrl }))

      setReferencePhotos((current) => [...current, ...nextPhotos].slice(0, maxReferencePhotos))

      if (preparedPhotos.some((photo) => photo.isWide) && !limitNotice) {
        setReferencePhotoNotice(
          'Wide or group photos are harder to match. For a closer likeness, add a well-lit close-up of each person\'s face.',
        )
      }
    } catch (caughtError) {
      setReferencePhotoNotice(
        caughtError instanceof Error ? caughtError.message : 'Unable to add that photo.',
      )
    } finally {
      const remainingVisibleMs = 1200 - (Date.now() - startedAt)
      if (remainingVisibleMs > 0) {
        await sleep(remainingVisibleMs)
      }
      setIsAddingPhotos(false)
    }
  }

  const removeReferencePhoto = (photoId: string) => {
    setReferencePhotos((current) => current.filter((photo) => photo.id !== photoId))
    setReferencePhotoNotice('')
  }

  const addCreditPack = () => {
    setCredits((current) => current + creditPackAmount)
    setCreditNotice(`Added ${creditPackAmount} demo wishes. In production this would happen after checkout.`)
  }

  const finishGeneratedCard = (data: { message: string; closing?: string; imageUrl: string }, signatureName: string) => {
    const copy = normalizeCardCopy(data.message, data.closing, signatureName)
    setCard({
      imageUrl: data.imageUrl,
      message: copy.message,
      closing: copy.closing,
    })
    setCardGreeting('')
    setCardSignature(signatureName)
    setStep('envelope')
    setShowCompletionNote(true)
    setCredits((current) => current - cardGenerationCost)
    setCreditNotice(`${cardGenerationCost} wishes used to create this card.`)
    window.setTimeout(() => setShowCompletionNote(false), 6000)
    clearStoredGenerationJob()
  }

  const followGenerationJob = async (jobId: string, signatureName: string) => {
    const pollId = generationPollIdRef.current + 1
    generationPollIdRef.current = pollId
    const isCurrent = () => generationPollIdRef.current === pollId

    setIsGenerating(true)
    setError('')
    setShowEditor(false)
    setShowPolishDialog(false)
    setHasViewedInside(false)
    setStep('envelope')

    try {
      const data = await waitForGenerationJob(jobId, isCurrent)
      if (!isCurrent()) {
        return
      }
      finishGeneratedCard(data, signatureName)
    } catch (caughtError) {
      if (!isCurrent()) {
        return
      }

      const message = getFriendlyErrorMessage(caughtError, 'Unable to generate the card.')
      const keepStoredJob =
        message === generationLostConnectionMessage ||
        (caughtError instanceof Error && caughtError.name === 'AbortError')

      if (!keepStoredJob) {
        clearStoredGenerationJob()
      }

      setError(message)
      setCreditNotice('Your wish is still in the lamp.')
    } finally {
      if (isCurrent()) {
        setIsGenerating(false)
      }
    }
  }

  followGenerationJobRef.current = followGenerationJob

  const generateCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    if (!hasEnoughCreditsForCard) {
      setCreditNotice(`You need ${cardGenerationCost} wishes to create a card. Buy more wishes to keep going.`)
      return
    }

    setIsGenerating(true)
    setShowCompletionNote(false)
    setActiveGenerationStep(0)
    setShowEditor(false)
    setShowPolishDialog(false)
    setSharedCard(null)
    setDeliveryNotice('')
    setHasViewedInside(false)
    setStep('envelope')
    void requestScreenWakeLock()
      .then((wakeLock) => {
        if (wakeLock) {
          screenWakeLockRef.current = wakeLock
        }
      })
      .catch(() => {
        // Unsupported, denied, or battery saver — card generation can still continue.
      })

    let startedBackgroundJob = false

    try {
      const response = await fetch(apiUrl('/api/generate-card'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...details,
          referenceImages: referenceImagePayload,
        }),
      })

      const data = await getApiJson(response, 'Unable to start creating the card.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to start creating the card. Please try again.')
      }

      if (data.jobId) {
        startedBackgroundJob = true
        writeStoredGenerationJob(data.jobId, details)
        await followGenerationJob(data.jobId, senderLabel)
        return
      }

      if (!data.imageUrl || !data.message) {
        throw new Error('Unable to start creating the card. Please try again.')
      }

      finishGeneratedCard(data, senderLabel)
    } catch (caughtError) {
      if (startedBackgroundJob) {
        return
      }

      setError(getFriendlyErrorMessage(caughtError, 'Unable to generate the card.'))
      setCreditNotice('Your wish is still in the lamp.')
    } finally {
      if (!startedBackgroundJob) {
        setIsGenerating(false)
      }
    }
  }

  const openEnvelope = () => {
    setStep('opening')
    window.setTimeout(() => setStep('front'), 6200)
  }

  const playEnvelopeBack = () => {
    setStep('envelopeBack')
    window.setTimeout(openEnvelope, 350)
  }

  const flipEnvelope = () => {
    setStep('envelopeFlip')
    window.setTimeout(playEnvelopeBack, 2400)
  }

  const replayAnimation = () => {
    setShowEditor(false)
    setShowPolishDialog(false)
    setHasViewedInside(false)
    setStep('envelope')
  }

  const openEditor = () => {
    setShowEditor(true)
    setEditorTab(step === 'inside' ? 'inside' : 'front')
  }

  const updateCardMessage = (message: string) => {
    setCard((current) => (current ? { ...current, message } : current))
  }

  const updateCardClosing = (closing: string) => {
    setCard((current) => (current ? { ...current, closing } : current))
  }

  const saveImageToDevice = async (imageUrl: string, fileName: string, label: string) => {
    if (!imageUrl) {
      return
    }

    setSaveNotice('')

    if (prefersPhotoSave) {
      try {
        const imageFile = await imageUrlToFile(imageUrl, fileName)

        if (
          typeof navigator.share === 'function' &&
          typeof navigator.canShare === 'function' &&
          navigator.canShare({ files: [imageFile] })
        ) {
          await navigator.share({
            files: [imageFile],
            title: `Card Genie ${label}`,
            text: `Save this ${label.toLowerCase()} from Card Genie.`,
          })
          setSaveNotice('Choose Save Image or Save to Photos from your phone share sheet.')
          return
        }
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
          return
        }
      }

      downloadImageFallback(imageUrl, fileName)
      setSaveNotice('If your phone downloads the image, open it and use the share menu to save it to Photos.')
      return
    }

    downloadImageFallback(imageUrl, fileName)
    setSaveNotice('The image was saved to your downloads folder.')
  }

  const refineImage = async () => {
    if (!card) {
      return
    }

    setError('')

    if (!hasEnoughCreditsForRevision) {
      setCreditNotice(`You need ${revisionCost} wishes to revise the cover. Buy more wishes to keep going.`)
      return
    }

    setIsRefiningImage(true)

    try {
      const response = await fetch(apiUrl('/api/refine-image'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          details,
          refinement: imageRefinement,
          imageMode: coverRefinementMode,
          currentImageUrl: coverRefinementMode === 'revise' ? card.imageUrl : undefined,
          referenceImages: referenceImagePayload,
        }),
      })

      const data = await getApiJson(response, 'Unable to refine the cover image.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to refine the cover image.')
      }

      if (!data.imageUrl) {
        throw new Error('Unable to refine the cover image.')
      }

      setCard((current) => (current ? { ...current, imageUrl: data.imageUrl } : current))
      setImageRefinement('')
      setStep('front')
      setCredits((current) => current - revisionCost)
      setCreditNotice(`${revisionCost} wishes used to revise the cover.`)
    } catch (caughtError) {
      setError(getFriendlyErrorMessage(caughtError, 'Unable to refine the cover image.'))
      setCreditNotice('Your wish is still in the lamp.')
    } finally {
      setIsRefiningImage(false)
    }
  }

  const refineCopy = async () => {
    if (!card) {
      return
    }

    setError('')

    if (!hasEnoughCreditsForRevision) {
      setCreditNotice(`You need ${revisionCost} wishes to polish the message. Buy more wishes to keep going.`)
      return
    }

    setIsRefiningCopy(true)

    try {
      const response = await fetch(apiUrl('/api/refine-copy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          details,
          refinement: copyRefinement,
          currentMessage: cardMessage,
          currentClosing: cardClosing,
          referenceImages: referenceImagePayload,
        }),
      })

      const data = await getApiJson(response, 'Unable to refine the inside message.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to refine the inside message.')
      }

      if (!data.message) {
        throw new Error('Unable to refine the inside message.')
      }

      const copy = normalizeCardCopy(data.message, data.closing, senderLabel)
      setCard((current) =>
        current
          ? {
              ...current,
              message: copy.message,
              closing: copy.closing,
            }
          : current,
      )
      setCopyRefinement('')
      setShowPolishDialog(false)
      setStep('inside')
      setCredits((current) => current - revisionCost)
      setCreditNotice(`${revisionCost} wishes used to polish the inside message.`)
    } catch (caughtError) {
      setError(getFriendlyErrorMessage(caughtError, 'Unable to refine the inside message.'))
      setCreditNotice('Your wish is still in the lamp.')
    } finally {
      setIsRefiningCopy(false)
    }
  }

  const buildCurrentCardPayload = () => {
    if (!card) {
      throw new Error('Create a card before delivering it.')
    }

    return {
      details,
      card: {
        imageUrl: card.imageUrl,
        message: cardMessage,
        closing: cardClosing,
      },
      greeting: insideGreeting,
      signature: cardSignatureLabel,
    }
  }

  const saveCurrentCard = async () => {
    const response = await fetch(apiUrl('/api/cards'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildCurrentCardPayload()),
    })
    const data = await getApiJson(response, 'Unable to save the card for delivery.')

    if (!response.ok) {
      throw new Error(data.error || 'Unable to save the card for delivery.')
    }

    const shared = data as SharedCard
    setSharedCard(shared)
    return shared
  }

  const addDeliveryLog = (entry: Omit<DeliveryLog, 'id' | 'createdAt'>) => {
    setDeliveryLogs((current) => [
      {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: new Date().toLocaleString(),
      },
      ...current,
    ])
  }

  const deliverCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setDeliveryNotice('')

    let destinationValue = ''
    let destinationDisplay = ''

    if (deliveryMethod === 'email') {
      const validated = validateEmailAddress(deliveryDestination)

      if (!validated.ok) {
        setDeliveryNotice(validated.message)
        return
      }

      destinationValue = validated.value
      destinationDisplay = validated.value
    } else {
      const validated = validatePhoneNumber(deliveryDestination)

      if (!validated.ok) {
        setDeliveryNotice(validated.message)
        return
      }

      destinationValue = validated.value
      destinationDisplay = validated.display
    }

    setDeliveryDestination(destinationDisplay)

    if (deliveryMethod === 'text' && !smsConsentConfirmed) {
      setDeliveryNotice('Confirm the recipient agreed to receive this one-time card delivery text.')
      return
    }

    setIsDelivering(true)

    try {
      const shared = await saveCurrentCard()
      const response = await fetch(apiUrl('/api/deliver-card'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cardId: shared.id,
          method: deliveryMethod,
          destination: destinationValue,
          recipientConsentConfirmed: deliveryMethod === 'text' ? smsConsentConfirmed : undefined,
        }),
      })
      const data = await getApiJson(response, 'Unable to deliver the card.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to deliver the card.')
      }

      const deliveredDisplay =
        deliveryMethod === 'email'
          ? formatEmailAddress(String(data.deliveredTo || destinationValue))
          : formatPhoneNumberDisplay(String(data.deliveredTo || destinationValue))

      setDeliveryNotice(data.message || 'Card sent.')
      addDeliveryLog({
        method: deliveryMethod,
        destination: deliveredDisplay,
        status: 'Sent',
        message: data.message || 'Card sent.',
      })
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Unable to deliver the card.'
      setDeliveryNotice(message)
      addDeliveryLog({
        method: deliveryMethod,
        destination: destinationDisplay,
        status: 'Failed',
        message,
      })
    } finally {
      setIsDelivering(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-section">
        <a className="brand" href="/" aria-label="Card Genie home">
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}logo.png`} alt="" />
          <span className="brand-wordmark">Card Genie</span>
        </a>
        <h1>
          {isRecipientView ? 'You received a card' : 'Any Card Imaginable'}
          {!isRecipientView && <span className="trademark-mark">™</span>}
        </h1>
        <p>
          {isRecipientView
            ? 'Open the envelope to see your personalized greeting card.'
            : 'Powered by GreetingCardUniverse.com'}
        </p>
        {!isRecipientView && <div className="credit-wallet" aria-label="Wish balance">
          <div>
            <span className="wallet-kicker">Welcome back, {senderLabel}. Ready for another wish?</span>
            <strong>{credits} wishes in your lamp</strong>
            <small>
              Cards use {cardGenerationCost} wishes. Revisions use {revisionCost} wishes.
            </small>
          </div>
          <button className="secondary-button" type="button" onClick={addCreditPack}>
            Buy more wishes - $10
          </button>
        </div>}
      </section>

      <section className={`workspace ${isRecipientView ? 'recipient-workspace' : ''} ${showProofPanel ? '' : 'is-form-only'}`.trim()}>
        {!isRecipientView && <form className="card-panel form-panel" onSubmit={generateCard}>
          <div className="panel-heading">
            <span>01</span>
            <div>
              <h2>Tell us about the card</h2>
              <p>One set of details powers both the image and the message.</p>
            </div>
          </div>

          <div className="credit-callout">
            <span>{creditNotice}</span>
            <strong>{credits} wishes</strong>
          </div>

          <div className="field-grid">
            <label>
              From
              <input
                required
                value={details.senderName}
                onChange={(event) => updateDetails('senderName', event.target.value)}
                placeholder="Example: your name"
              />
            </label>

            <label>
              To
              <input
                value={details.recipientName}
                onChange={(event) => updateDetails('recipientName', event.target.value)}
                placeholder="Example: Jamie"
              />
            </label>
          </div>

          <div className="field-grid">
            <label>
              Occasion
              <input
                required
                value={details.occasion}
                onChange={(event) => updateDetails('occasion', event.target.value)}
                placeholder="Example: birthday, thank you, anniversary"
              />
            </label>

            <label>
              Relation
              <input
                required
                value={details.recipientType}
                onChange={(event) => updateDetails('recipientType', event.target.value)}
                placeholder="Example: mom, spouse, friend, coworker"
              />
            </label>
          </div>

          <div className="field-grid">
            <label>
              Tone
              <select value={details.tone} onChange={(event) => updateDetails('tone', event.target.value)}>
                {toneOptions.map((tone) => (
                  <option key={tone}>{tone}</option>
                ))}
              </select>
            </label>

            <label>
              Message length
              <select
                value={details.length}
                onChange={(event) => updateDetails('length', event.target.value)}
              >
                {lengthOptions.map((length) => (
                  <option key={length}>{length}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="style-field">
            <div className="style-field-header">
              <label htmlFor="image-style">Image style</label>
              <a className="style-lookbook-link" href="/styles/" target="_blank" rel="noreferrer">
                See what's possible
              </a>
            </div>
            <select
              id="image-style"
              value={details.imageStyle}
              onChange={(event) => updateDetails('imageStyle', event.target.value)}
            >
              {styleOptions.map((style) => (
                <option key={style}>{style}</option>
              ))}
            </select>
          </div>

          <label>
            Personal details
            <textarea
              required
              rows={6}
              value={details.keyDetails}
              onChange={(event) => updateDetails('keyDetails', event.target.value)}
              placeholder={
                'Add memories, interests, relationship details, places, colors, or anything the card should include.\nIf you’re asking for people to be included in the image, please provide physical attributes like: grandma is tall with short blonde hair with green eyes.'
              }
            />
          </label>

          <div className="reference-photos-field">
            <span className="field-title">Reference photos (optional)</span>
            <p className="field-help" id="reference-photos-help">
              Use a clear, well-lit close-up of each person you want on the card. Group shots can inspire the
              scene, but faces match more closely from close-up photos.
            </p>
            {referencePhotos.length > 0 && (
              <ul className="reference-photo-list">
                {referencePhotos.map((photo) => (
                  <li key={photo.id}>
                    <img src={photo.dataUrl} alt="" />
                    <button
                      type="button"
                      onClick={() => removeReferencePhoto(photo.id)}
                      aria-label={`Remove ${photo.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {referencePhotos.length < maxReferencePhotos && (
              <div className="reference-photo-actions">
                <input
                  id="reference-photos"
                  className="reference-photo-file"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  aria-describedby="reference-photos-help"
                  onChange={(event) => void addReferencePhotos(event)}
                />
                <label
                  className={`reference-photo-add${isAddingPhotos ? ' is-busy' : ''}`}
                  htmlFor="reference-photos"
                  aria-busy={isAddingPhotos}
                >
                  {isAddingPhotos ? 'Adding photo...' : 'Add a photo'}
                </label>
                {isAddingPhotos && (
                  <span className="photo-add-timer" role="status" aria-live="polite">
                    <span className="photo-add-clock" aria-hidden="true" />
                    {`${Math.floor(photoAddElapsed / 60)}:${String(photoAddElapsed % 60).padStart(2, '0')}`}
                  </span>
                )}
              </div>
            )}
            {referencePhotoNotice && <div className="field-notice">{referencePhotoNotice}</div>}
          </div>

          {error && <div className="error-message">{error}</div>}

          <button className="primary-button" disabled={isGenerating} aria-busy={isGenerating}>
            {isGenerating
              ? 'Creating a little magic...'
              : card
                ? `Create another card - ${cardGenerationCost} wishes`
                : `Create this card - ${cardGenerationCost} wishes`}
          </button>
          {isGenerating && (
            <p className="generate-scroll-hint">Your card is taking shape below.</p>
          )}
        </form>}

        {showProofPanel && <section ref={previewPanelRef} className={`card-panel preview-panel ${isRecipientView ? 'recipient-preview-panel' : ''}`}>
          <div className="panel-heading proof-heading">
            {!isRecipientView && <span>02</span>}
            <div>
              <h2>
                {isRecipientView ? `Your card from ${senderLabel}` : showEditor ? 'Revise your card' : 'Your card'}
              </h2>
            </div>
            {!isRecipientView &&
              !isGenerating &&
              card &&
              (showEditor ? (
                <button
                  className="secondary-button revise-top-button"
                  type="button"
                  onClick={() => {
                    setShowEditor(false)
                    setShowPolishDialog(false)
                  }}
                >
                  Close Editor
                </button>
              ) : (
                <button className="primary-button revise-top-button" type="button" onClick={openEditor}>
                  Revise card
                </button>
              ))}
          </div>

          {isGenerating && (
            <div className="creative-loader" role="status" aria-live="polite">
              <div className="writing-loader" aria-hidden="true">
                <div className="writing-paper">
                  <span className="writing-line writing-line-one" />
                  <span className="writing-line writing-line-two" />
                  <span className="writing-line writing-line-three" />
                </div>
                <div className="writing-pen" />
              </div>
              <span className="loader-kicker">Creating a little magic</span>
              <h3 key={generationLines[activeGenerationStep]}>{generationLines[activeGenerationStep]}</h3>
              <p className="loader-note">You can switch apps. We will keep working, and the card will be waiting when you come back.</p>
            </div>
          )}

          {isLoadingSharedCard && (
            <div className="empty-state" role="status" aria-live="polite">
              <div className="sparkle">
                <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" />
              </div>
              <h3>Loading your card</h3>
              <p>Opening the shared greeting card.</p>
            </div>
          )}

          {error && !isGenerating && !isLoadingSharedCard && <div className="error-message">{error}</div>}

          {!isGenerating && !isLoadingSharedCard && !card && (
            <div className="empty-state">
              <div className="sparkle">
                <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" />
              </div>
              <h3>No card yet</h3>
              <p>Fill in the form, then create your card.</p>
            </div>
          )}

          {!isGenerating && card && (
            <>
              {!showEditor && (
                <>
              {showCompletionNote && (
                <div className="completion-note">
                  Your card is ready. Take a look.
                </div>
              )}

              {step === 'envelope' && (
                <button className="proof-stage envelope-scene" type="button" onClick={flipEnvelope}>
                  <div className="envelope">
                    <div className="envelope-front-face">
                      <img className="envelope-stamp" src={stampSrc} alt="" aria-hidden="true" />
                      <span className="envelope-front-address">To {envelopeLabel}</span>
                    </div>
                  </div>
                  <span className="envelope-prompt">Reveal your card</span>
                </button>
              )}

              {step === 'envelopeFlip' && (
                <div className="proof-stage envelope-scene" aria-live="polite">
                  <div className="envelope is-flipping">
                    <div className="envelope-front-face">
                      <img className="envelope-stamp" src={stampSrc} alt="" aria-hidden="true" />
                      <span className="envelope-front-address">To {envelopeLabel}</span>
                    </div>
                    <div className="envelope-back-face">
                      <div className="envelope-back" />
                      <div className="envelope-liner" />
                      <div className="envelope-flap envelope-flap-static" />
                      <div className="envelope-body" />
                    </div>
                  </div>
                  <span className="envelope-prompt envelope-prompt-placeholder" aria-hidden="true">
                    Reveal your card
                  </span>
                </div>
              )}

              {(step === 'envelopeBack' || step === 'opening') && (
                <div
                  className={`proof-stage envelope-scene${step === 'opening' ? ' opening-scene' : ''}`}
                  aria-live="polite"
                >
                  <div className={`envelope envelope-static${step === 'opening' ? ' is-opening' : ''}`}>
                    <div className="envelope-back-face is-static">
                      <div className="envelope-back" />
                      <div className="envelope-body">
                        {step === 'opening' ? <small aria-hidden="true"></small> : null}
                      </div>
                    </div>
                    <div className="envelope-liner" />
                    <div className={`envelope-flap${step === 'opening' ? '' : ' envelope-flap-static'}`} />
                    {step === 'opening' && (
                      <div className="envelope-card-rise">
                        <img src={card.imageUrl} alt={`Front of card for ${recipientLabel}`} />
                      </div>
                    )}
                  </div>
                  <span className="envelope-prompt envelope-prompt-placeholder" aria-hidden="true">
                    Reveal your card
                  </span>
                </div>
              )}

              {step === 'front' && (
                <button
                  className="proof-stage card-reveal front-reveal"
                  type="button"
                  onClick={() => setStep('inside')}
                  aria-label={`Show inside of card for ${recipientLabel}`}
                >
                  <div className="card-cover-frame">
                    <img src={card.imageUrl} alt={`Front of card for ${recipientLabel}`} />
                  </div>
                </button>
              )}

              {step === 'cardOpening' && (
                <div className="proof-stage card-open-scene" aria-live="polite">
                  <div className="card-open-stage">
                    <div className={`open-card-message ${messageDensity}`}>
                      {insideGreeting && <span>{insideGreeting}</span>}
                      <div className="message-paragraphs">
                        {messageParagraphs.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                      {cardClosing ? <div className="card-closing">{cardClosing}</div> : null}
                      <div className="card-signature">{cardSignatureLabel}</div>
                    </div>
                    <div className="card-opening-cover">
                      <img src={card.imageUrl} alt={`Opening card cover for ${recipientLabel}`} />
                    </div>
                  </div>
                </div>
              )}

              {step === 'inside' && (
                <button
                  className="proof-stage card-open-scene is-static-inside"
                  type="button"
                  onClick={() => setStep('front')}
                  aria-label={`Show cover of card for ${recipientLabel}`}
                >
                  <div className="open-card">
                    <div className={`open-card-message ${messageDensity}`}>
                      {insideGreeting && <span>{insideGreeting}</span>}
                      <div className="message-paragraphs">
                        {messageParagraphs.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                      {cardClosing ? <div className="card-closing">{cardClosing}</div> : null}
                      <div className="card-signature">{cardSignatureLabel}</div>
                    </div>
                  </div>
                </button>
              )}

              {(step === 'front' || step === 'inside') && (
                <nav className="card-view-toggle" aria-label="Card view">
                  <button
                    className={step === 'front' ? 'is-selected' : ''}
                    type="button"
                    onClick={() => setStep('front')}
                  >
                    Cover
                  </button>
                  <span aria-hidden="true">|</span>
                  <button
                    className={step === 'inside' ? 'is-selected' : ''}
                    type="button"
                    onClick={() => setStep('inside')}
                  >
                    Inside
                  </button>
                </nav>
              )}
              {isRecipientView && card && (step === 'front' || step === 'inside') && (
                <>
                  <div className="recipient-save-links" aria-label="Save card images">
                    <button
                      type="button"
                      onClick={() => void saveImageToDevice(card.imageUrl, coverDownloadName, 'Cover image')}
                    >
                      {coverSaveLabel}
                    </button>
                    <span aria-hidden="true">|</span>
                    <button
                      type="button"
                      onClick={() => void saveImageToDevice(insideDownloadUrl, insideDownloadName, 'Inside image')}
                    >
                      {insideSaveLabel}
                    </button>
                  </div>
                  {saveNotice && <p className="recipient-save-note">{saveNotice}</p>}
                </>
              )}

              {showSendActions && (
                <div className="proof-actions">
                  <button className="secondary-button" type="button" onClick={replayAnimation}>
                    Watch the reveal again
                  </button>
                </div>
              )}
              {isRecipientView && (step === 'front' || step === 'inside') && (
                <aside className="recipient-invite" aria-label="Make a card of your own">
                  <h3>Loved this card?</h3>
                  <p>Create one just as personal for someone you care about.</p>
                  <a className="primary-button" href="/">
                    Create your own card
                  </a>
                </aside>
              )}
              {showSendActions && !isRecipientView && <form className="delivery-panel" onSubmit={deliverCard}>
                <div>
                  <span className="delivery-kicker">Ready to send?</span>
                  <h3>Send this wish</h3>
                  <p>Send a secure card link by email or text after you approve the card.</p>
                </div>
                <div className="mode-toggle delivery-methods" aria-label="Delivery method">
                  <button
                    className={deliveryMethod === 'email' ? 'is-selected' : ''}
                    type="button"
                    onClick={() => {
                      setDeliveryMethod('email')
                      setDeliveryDestination('')
                      setSmsConsentConfirmed(false)
                      setDeliveryNotice('')
                    }}
                  >
                    Email
                  </button>
                  <button
                    className={deliveryMethod === 'text' ? 'is-selected' : ''}
                    type="button"
                    onClick={() => {
                      setDeliveryMethod('text')
                      setDeliveryDestination('')
                      setSmsConsentConfirmed(false)
                      setDeliveryNotice('')
                    }}
                  >
                    Cellphone
                  </button>
                </div>
                <label>
                  {deliveryMethod === 'email' ? 'Recipient email' : 'Recipient cellphone'}
                  <input
                    type={deliveryMethod === 'email' ? 'email' : 'tel'}
                    inputMode={deliveryMethod === 'email' ? 'email' : 'tel'}
                    autoComplete={deliveryMethod === 'email' ? 'email' : 'tel'}
                    value={deliveryDestination}
                    onChange={(event) => {
                      setDeliveryDestination(event.target.value)
                      setDeliveryNotice('')
                    }}
                    onBlur={() => {
                      if (!deliveryDestination.trim()) {
                        return
                      }

                      if (deliveryMethod === 'email') {
                        const validated = validateEmailAddress(deliveryDestination)

                        if (validated.ok) {
                          setDeliveryDestination(validated.value)
                          setDeliveryNotice('')
                        } else {
                          setDeliveryNotice(validated.message)
                        }

                        return
                      }

                      const validated = validatePhoneNumber(deliveryDestination)

                      if (validated.ok) {
                        setDeliveryDestination(validated.display)
                        setDeliveryNotice('')
                      } else {
                        setDeliveryNotice(validated.message)
                      }
                    }}
                    placeholder={deliveryMethod === 'email' ? 'jamie@example.com' : '(925) 555-1234'}
                  />
                </label>
                {deliveryMethod === 'text' && (
                  <label className="sms-consent">
                    <input
                      type="checkbox"
                      checked={smsConsentConfirmed}
                      onChange={(event) => setSmsConsentConfirmed(event.target.checked)}
                    />
                    <span>
                      Optional SMS delivery: I confirm this recipient agreed to receive a one-time SMS/text message from
                      Card Genie with a link to this card. Message frequency is one message per card delivery request.
                      Msg & data rates may apply. Reply STOP to cancel, HELP for help. SMS consent is optional and is
                      not required to create a card or use email delivery. See our{' '}
                      <a href="/privacy/index.html" target="_blank" rel="noreferrer">
                        Privacy Policy
                      </a>{' '}
                      and{' '}
                      <a href="/terms/index.html" target="_blank" rel="noreferrer">
                        Terms
                      </a>
                      .
                    </span>
                  </label>
                )}
                <button
                  className="primary-button"
                  type="submit"
                  disabled={isDelivering || (deliveryMethod === 'text' && !smsConsentConfirmed)}
                  aria-busy={isDelivering}
                >
                  {isDelivering ? 'Sending your wish...' : `Send by ${deliveryMethod === 'email' ? 'email' : 'text'}`}
                </button>
                {sharedCard && (
                  <a className="share-link" href={sharedCard.shareUrl} target="_blank" rel="noreferrer">
                    Open shareable card link
                  </a>
                )}
                {deliveryNotice && <div className="delivery-notice">{deliveryNotice}</div>}
                {deliveryLogs.length > 0 && (
                  <div className="delivery-log-panel">
                    <h4>Delivery activity</h4>
                    <div className="delivery-log-table" role="table" aria-label="Delivery activity">
                      <div className="delivery-log-row delivery-log-header" role="row">
                        <span role="columnheader">Status</span>
                        <span role="columnheader">Method</span>
                        <span role="columnheader">Destination</span>
                        <span role="columnheader">Time</span>
                      </div>
                      {deliveryLogs.map((log) => (
                        <div className="delivery-log-row" role="row" key={log.id}>
                          <span className={log.status === 'Sent' ? 'is-sent' : 'is-failed'} role="cell">
                            {log.status}
                          </span>
                          <span role="cell">{log.method === 'email' ? 'Email' : 'Text'}</span>
                          <span role="cell">{log.destination}</span>
                          <span role="cell">{log.createdAt}</span>
                          <small role="cell">{log.message}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </form>}
                </>
              )}

              {!isRecipientView && showEditor && (
                <div className="card-editor">
                  <nav className="card-thumbnails editor-thumbnails" aria-label="Card editor pages">
                    <button
                      className={editorTab === 'front' ? 'is-selected' : ''}
                      type="button"
                      onClick={() => setEditorTab('front')}
                    >
                      <img src={card.imageUrl} alt="" />
                      <span>Cover</span>
                    </button>
                    <button
                      className={editorTab === 'inside' ? 'is-selected' : ''}
                      type="button"
                      onClick={() => setEditorTab('inside')}
                    >
                      <span className="inside-thumb">Aa</span>
                      <span>Inside</span>
                    </button>
                  </nav>

                  <div className="editor-layout">
                    <div className="editor-preview">
                      {editorTab === 'front' ? (
                        <>
                          <div className="image-zoom">
                            <div className="card-cover-frame editor-cover-frame">
                              <img src={card.imageUrl} alt={`Cover preview for ${recipientLabel}`} />
                            </div>
                            <div className="image-zoom-popover" aria-hidden="true">
                              <img src={card.imageUrl} alt="" />
                            </div>
                          </div>
                          <span className="zoom-hint">Hover over the cover to enlarge</span>
                        </>
                      ) : (
                        <>
                          <div className="open-card editor-inside-preview" aria-label={`Inside preview for ${recipientLabel}`}>
                            <div className={`open-card-message ${messageDensity}`}>
                              {insideGreeting && <span>{insideGreeting}</span>}
                              <div className="message-paragraphs">
                                {messageParagraphs.map((paragraph, index) => (
                                  <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
                                ))}
                              </div>
                              {cardClosing ? <div className="card-closing">{cardClosing}</div> : null}
                              <div className="card-signature">{cardSignatureLabel}</div>
                            </div>
                          </div>
                          <span className="zoom-hint">Your edits appear on the inside as you type</span>
                        </>
                      )}
                    </div>

                    <div className="refinement-panel">
                      {editorTab === 'front' ? (
                        <div className="refinement-card">
                          <h3>Refine the cover</h3>
                          <p>
                            Describe what should change. By default, Card Genie keeps the same concept and only revises the cover.
                          </p>
                          <div className="mode-toggle" aria-label="Cover refinement mode">
                            <button
                              className={coverRefinementMode === 'revise' ? 'is-selected' : ''}
                              type="button"
                              onClick={() => setCoverRefinementMode('revise')}
                            >
                              Revise current concept
                            </button>
                            <button
                              className={coverRefinementMode === 'new' ? 'is-selected' : ''}
                              type="button"
                              onClick={() => setCoverRefinementMode('new')}
                            >
                              Whole new concept
                            </button>
                          </div>
                          <textarea
                            rows={5}
                            value={imageRefinement}
                            onChange={(event) => setImageRefinement(event.target.value)}
                            placeholder={
                              coverRefinementMode === 'revise'
                                ? 'Example: keep the same scene, but make it more joyful, add flowers, and keep text farther from the edges.'
                                : 'Example: create a completely different cover concept with a sunny garden party and elegant birthday text.'
                            }
                          />
                          <button
                            className="primary-button cost-button"
                            type="button"
                            disabled={isRefiningImage || !imageRefinement.trim() || !hasEnoughCreditsForRevision}
                            aria-busy={isRefiningImage}
                            onClick={refineImage}
                          >
                            {isRefiningImage ? (
                              'Updating cover...'
                            ) : (
                              <>
                                <span>
                                  {coverRefinementMode === 'revise' ? 'Revise Card Image' : 'Create New Card Image'}
                                </span>
                                <span className="button-points">{revisionCost} points</span>
                              </>
                            )}
                          </button>
                        </div>
                      ) : (
                        <div className="refinement-card inside-refinement-card">
                          <div className="inside-editor-header">
                            <div>
                              <h3>Edit the inside</h3>
                              <p>Change the wording directly. The card on the left updates as you type.</p>
                            </div>
                          </div>
                          <label>
                            Greeting
                            <input value={insideGreeting} onChange={(event) => setCardGreeting(event.target.value)} />
                          </label>
                          <label>
                            Inside message
                            <textarea
                              rows={10}
                              value={cardMessage}
                              onChange={(event) => updateCardMessage(event.target.value)}
                            />
                          </label>
                          <label>
                            Closing
                            <input
                              value={cardClosing}
                              onChange={(event) => updateCardClosing(event.target.value)}
                              placeholder="With love,"
                            />
                          </label>
                          <label>
                            Signature name
                            <input
                              value={cardSignatureLabel}
                              onChange={(event) => setCardSignature(event.target.value)}
                            />
                          </label>
                          <button
                            className="ai-copy-link"
                            type="button"
                            onClick={() => setShowPolishDialog((current) => !current)}
                          >
                            {showPolishDialog
                              ? 'Hide AI rewrite'
                              : 'Want AI to create or modify this text?'}
                          </button>
                          {showPolishDialog && (
                            <div className="ai-copy-panel">
                              <label>
                                Tell Card Genie what to change
                                <textarea
                                  rows={4}
                                  value={copyRefinement}
                                  onChange={(event) => setCopyRefinement(event.target.value)}
                                  placeholder="Example: make it shorter, warmer, and mention pickleball."
                                />
                              </label>
                              <button
                                className="primary-button cost-button"
                                type="button"
                                disabled={isRefiningCopy || !copyRefinement.trim() || !hasEnoughCreditsForRevision}
                                aria-busy={isRefiningCopy}
                                onClick={refineCopy}
                              >
                                {isRefiningCopy ? (
                                  'Rewriting inside...'
                                ) : (
                                  <>
                                    <span>Rewrite with AI</span>
                                    <span className="button-points">{revisionCost} wishes</span>
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>}
      </section>
    </main>
  )
}

export default App
