import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
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

type MessageLengthId = 'short' | 'medium' | 'long'

type MessageVariants = {
  short: string
  medium: string
  long: string
}

type GeneratedCard = {
  imageUrl: string
  message: string
  closing?: string
  messageVariants?: MessageVariants
  selectedLength?: MessageLengthId
}

type SharedCard = {
  id: string
  shareUrl: string
  details: Partial<CardDetails>
  card: GeneratedCard
  greeting?: string
  signature?: string
}

const CARD_COVER_WIDTH = 1056
const CARD_COVER_HEIGHT = 1472
const PRINT_CARD_WIDTH = 1504
const PRINT_CARD_HEIGHT = 2096

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

type InterviewMessage = {
  role: 'assistant' | 'user'
  content: string
}

type InterviewSpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives?: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: InterviewSpeechRecognitionEvent) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

type InterviewSpeechRecognitionEvent = {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
}

const interviewQuickGreeting =
  'Tell me about the card you want to create — who it’s for, who it’s from, the occasion, and any details or memories.'

const interviewChatGreeting =
  'Hi! Tell me about the card you want — who it’s for, who it’s from, the occasion, and any details or memories to include.'

type InterviewMode = 'quick' | 'chat'

const greetingForInterviewMode = (mode: InterviewMode) =>
  mode === 'chat' ? interviewChatGreeting : interviewQuickGreeting

const interviewVoicePauseMs = 3200
/** After interim speech with no final result, treat the turn as finished. */
const interviewInterimFinalizeMs = 2800

let genieSpeechAudio: HTMLAudioElement | null = null
/** Kept across plays so iOS can reuse an unlocked audio element mid-conversation. */
let genieSpeechPlayer: HTMLAudioElement | null = null
/** ~10% faster than default Genie TTS playback. */
const genieSpeechPlaybackRate = 1.1
/** Session cache so we don’t re-call getUserMedia (Chrome’s “Microphone access allowed” toast). */
let microphoneAccessKnown: 'granted' | 'denied' | null = null
/** One long MediaStream for Chrome Lamp Genie — never stop/restart mid-chat. */
let interviewMicStream: MediaStream | null = null

const releaseInterviewMicStream = () => {
  if (!interviewMicStream) {
    return
  }
  for (const track of interviewMicStream.getTracks()) {
    try {
      track.stop()
    } catch {
      // Ignore.
    }
  }
  interviewMicStream = null
}

const interviewMicStreamIsLive = () =>
  Boolean(interviewMicStream?.getTracks().some((track) => track.readyState === 'live'))

const queryMicrophonePermission = async (): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> => {
  try {
    const permissions = navigator.permissions
    if (!permissions?.query) {
      return 'unknown'
    }
    const status = await permissions.query({ name: 'microphone' as PermissionName })
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state
    }
  } catch {
    // Safari and some browsers reject microphone permission queries.
  }
  return 'unknown'
}

/**
 * Chrome Lamp Genie uses holdStream:true (one MediaStream for the whole chat).
 * Safari SpeechRecognition path still grants then releases so SR can own the mic.
 */
const ensureMicrophoneAccess = async (
  options?: { holdStream?: boolean },
): Promise<'granted' | 'denied' | 'unsupported'> => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unsupported'
  }

  if (options?.holdStream && interviewMicStreamIsLive()) {
    microphoneAccessKnown = 'granted'
    return 'granted'
  }

  if (!options?.holdStream && microphoneAccessKnown === 'granted') {
    return 'granted'
  }
  if (microphoneAccessKnown === 'denied') {
    return 'denied'
  }

  const permission = await queryMicrophonePermission()
  if (permission === 'denied') {
    microphoneAccessKnown = 'denied'
    return 'denied'
  }

  if (!options?.holdStream && permission === 'granted') {
    microphoneAccessKnown = 'granted'
    return 'granted'
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    })
    if (options?.holdStream) {
      releaseInterviewMicStream()
      interviewMicStream = stream
    } else {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore.
        }
      }
    }
    microphoneAccessKnown = 'granted'
    return 'granted'
  } catch {
    microphoneAccessKnown = 'denied'
    if (options?.holdStream) {
      releaseInterviewMicStream()
    }
    return 'denied'
  }
}

const pickInterviewRecorderMimeType = () => {
  if (typeof MediaRecorder === 'undefined') {
    return ''
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
    'audio/ogg;codecs=opus',
  ]
  return candidates.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type)
    } catch {
      return false
    }
  }) || ''
}

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Unable to read audio chunk.'))
    reader.readAsDataURL(blob)
  })

const isJunkInterviewTranscript = (text: string) => {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length < 2) {
    return true
  }
  const lower = trimmed.toLowerCase()
  return /^(thanks for watching[.!]?|thank you[.!]?|thanks[.!]?|please subscribe[.!]?|bye[.!]?|you|the end[.!]?|music|applause)$/i.test(
    lower,
  )
}

const transcribeInterviewAudioChunk = async (blob: Blob, prompt = '') => {
  if (blob.size < 1200) {
    return ''
  }
  const audioBase64 = await blobToBase64(blob)
  const response = await fetch(apiUrl('/api/card-interview-transcribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || 'audio/webm',
      prompt: prompt.slice(0, 240),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(String((data as { error?: string }).error || 'Unable to transcribe that audio.'))
  }
  return String((data as { text?: string }).text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

const getInterviewSpeechRecognition = () => {
  const speechWindow = window as Window & {
    SpeechRecognition?: new () => InterviewSpeechRecognition
    webkitSpeechRecognition?: new () => InterviewSpeechRecognition
  }
  const SpeechRecognitionCtor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition
  return SpeechRecognitionCtor ? new SpeechRecognitionCtor() : null
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
const messageLengthChoices: Array<{ id: MessageLengthId; label: string }> = [
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'long', label: 'Long' },
]
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
const initialCreditBalance = 2
const creditStorageKey = 'cardGenieCredits'
const formDraftStorageKey = 'cardGenieFormDraft'
const formDraftMaxAgeMs = 30 * 24 * 60 * 60 * 1000
const formDraftVersion = 1 as const
const interviewSessionStorageKey = 'cardGenieInterviewSession'
const interviewSessionMaxAgeMs = 24 * 60 * 60 * 1000
const interviewSessionVersion = 1 as const
const sendCreditCostSingle = 3
const sendCreditCostPerRecipient = 2
const maxDeliveryRecipients = 10
const coverRevisionCost = 1
const aiCopyCost = 1
const printCardCreditCost = 10
const usStateOptions = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const
const defaultPrintMailFrom = {
  name: 'Card Genie',
  line1: '154 East Prospect Ave',
  line2: '',
  city: 'Danville',
  state: 'CA',
  zip: '94526',
  country: 'US' as const,
}
const samplePrintShipTo = {
  name: 'Alex Rivera',
  line1: '482 Maple Street',
  line2: 'Apt 3B',
  city: 'Oakland',
  state: 'CA',
  zip: '94610',
  country: 'US' as const,
}
type MailingAddress = {
  name: string
  line1: string
  line2: string
  city: string
  state: string
  zip: string
  country: 'US'
}
type PrintOrderStep = 'closed' | 'ship-to' | 'mail-from' | 'review'

const emptyMailingAddress = (): MailingAddress => ({
  name: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  zip: '',
  country: 'US',
})

const isMailingAddressBlank = (address?: MailingAddress | null) => {
  if (!address) {
    return true
  }
  return ![address.name, address.line1, address.line2, address.city, address.state, address.zip]
    .map((part) => String(part || '').trim())
    .some(Boolean)
}

const normalizeAddressCompareKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

const isDefaultPrintMailFromAddress = (address?: MailingAddress | null) => {
  if (!address || isMailingAddressBlank(address)) {
    return true
  }
  return (
    normalizeAddressCompareKey(address.name) === normalizeAddressCompareKey(defaultPrintMailFrom.name) &&
    normalizeAddressCompareKey(address.line1) === normalizeAddressCompareKey(defaultPrintMailFrom.line1) &&
    normalizeAddressCompareKey(address.line2) === normalizeAddressCompareKey(defaultPrintMailFrom.line2) &&
    normalizeAddressCompareKey(address.city) === normalizeAddressCompareKey(defaultPrintMailFrom.city) &&
    normalizeAddressCompareKey(address.state) === normalizeAddressCompareKey(defaultPrintMailFrom.state) &&
    String(address.zip || '').trim().replace(/\s+/g, '') === defaultPrintMailFrom.zip
  )
}

const formatMailingAddressLines = (address: MailingAddress) =>
  [
    address.name,
    address.line1,
    address.line2.trim() || null,
    `${address.city}, ${address.state} ${address.zip}`,
  ]
    .filter(Boolean)
    .join('\n')

const formatAccountMailingAddress = (address?: Record<string, unknown> | MailingAddress | null) => {
  if (!address || typeof address !== 'object') {
    return ''
  }
  const name = String(address.name || '').trim()
  const line1 = String(address.line1 || '').trim()
  const line2 = String(address.line2 || '').trim()
  const city = String(address.city || '').trim()
  const state = String(address.state || '').trim()
  const zip = String(address.zip || '').trim()
  const cityLine = [city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '')
  return [name, line1, line2 || null, cityLine.trim() || null].filter(Boolean).join('\n')
}

const validateMailingAddress = (address: MailingAddress, label: string) => {
  const name = address.name.trim()
  const line1 = address.line1.trim()
  const line2 = address.line2.trim()
  const city = address.city.trim()
  const state = address.state.trim().toUpperCase()
  const zip = address.zip.trim().replace(/\s+/g, '')

  if (!name) {
    return { ok: false as const, message: `Enter the ${label} name.` }
  }
  if (!line1) {
    return { ok: false as const, message: `Enter the ${label} street address.` }
  }
  if (!city) {
    return { ok: false as const, message: `Enter the ${label} city.` }
  }
  if (!(usStateOptions as readonly string[]).includes(state)) {
    return { ok: false as const, message: `Choose a valid ${label} US state.` }
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    return { ok: false as const, message: `Enter a valid ${label} ZIP code.` }
  }

  return {
    ok: true as const,
    value: {
      name,
      line1,
      line2,
      city,
      state,
      zip,
      country: 'US' as const,
    },
  }
}

const getSendCreditCost = (recipientCount: number) => {
  const count = Math.max(0, Math.floor(recipientCount))
  if (count <= 0) {
    return sendCreditCostSingle
  }

  return Math.max(sendCreditCostSingle, sendCreditCostPerRecipient * count)
}
const adminPhoneNumbers = new Set(['+19259637453'])
const creditPacks = [
  { id: '10', credits: 10, price: 5, priceId: 'price_1UFlLJ1GfvmAXQBhxxvROUc7' },
  { id: '25', credits: 25, price: 10, priceId: 'price_1UFlL11GfvmAXQBhBGbdzji0' },
  { id: '60', credits: 60, price: 20, priceId: 'price_1UFlKl1GfvmAXQBho0xWW6JO' },
] as const

const parseCreditBalance = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const balance = Number(value)
  return Number.isFinite(balance) ? balance : null
}
const maxReferencePhotos = 3
const referencePhotoMaxEdge = 1280
const referencePhotoMinEdge = 240
const referencePhotoJpegQuality = 0.8
const maxReferencePhotoDataUrlLength = 480000

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const apiUrl = (path: string) => `${apiBaseUrl}${path}`

const stopGenieSpeech = () => {
  if (typeof window === 'undefined') {
    return
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
  if (genieSpeechAudio) {
    genieSpeechAudio.pause()
    try {
      genieSpeechAudio.currentTime = 0
    } catch {
      // Ignore.
    }
    // Never removeAttribute/load on the shared unlocked player — that re-locks autoplay
    // after a delayed mic Allow and forces the Hear Genie fallback.
    if (genieSpeechAudio !== genieSpeechPlayer) {
      try {
        genieSpeechAudio.removeAttribute('src')
        genieSpeechAudio.load()
      } catch {
        // Ignore.
      }
    }
    genieSpeechAudio = null
  }
}

const lampGenieVoiceStorageKey = 'cardGenieLampVoice'

/** OpenAI gpt-4o-mini-tts voices Lamp Genie can use. */
const lampGenieVoiceOptions = [
  { id: 'echo', label: 'Echo', blurb: 'Smooth mid-tone (default)' },
  { id: 'coral', label: 'Coral', blurb: 'Warm & friendly' },
  { id: 'nova', label: 'Nova', blurb: 'Bright & clear' },
  { id: 'shimmer', label: 'Shimmer', blurb: 'Soft & expressive' },
  { id: 'sage', label: 'Sage', blurb: 'Calm & steady' },
  { id: 'alloy', label: 'Alloy', blurb: 'Neutral & even' },
  { id: 'fable', label: 'Fable', blurb: 'Storyteller feel' },
  { id: 'onyx', label: 'Onyx', blurb: 'Deeper & grounded' },
  { id: 'ash', label: 'Ash', blurb: 'Soft-spoken' },
  { id: 'ballad', label: 'Ballad', blurb: 'Warm narrative' },
  { id: 'verse', label: 'Verse', blurb: 'Light & lively' },
] as const

type LampGenieVoiceId = (typeof lampGenieVoiceOptions)[number]['id']

const defaultLampGenieVoice: LampGenieVoiceId = 'echo'

const isLampGenieVoiceId = (value: unknown): value is LampGenieVoiceId =>
  typeof value === 'string' && lampGenieVoiceOptions.some((entry) => entry.id === value)

const readStoredLampGenieVoice = (): LampGenieVoiceId => {
  if (typeof window === 'undefined') {
    return defaultLampGenieVoice
  }
  try {
    const stored = window.localStorage.getItem(lampGenieVoiceStorageKey)
    if (isLampGenieVoiceId(stored)) {
      return stored
    }
  } catch {
    // Ignore storage failures.
  }
  return defaultLampGenieVoice
}

const persistLampGenieVoice = (voice: LampGenieVoiceId) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(lampGenieVoiceStorageKey, voice)
  } catch {
    // Ignore storage failures.
  }
}

const lampGenieVoiceLabel = (voice: LampGenieVoiceId) =>
  lampGenieVoiceOptions.find((entry) => entry.id === voice)?.label || voice

const hasFreshUserActivation = () => {
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation
  if (activation && typeof activation.isActive === 'boolean') {
    return activation.isActive
  }
  // Older browsers: assume the current gesture is still usable.
  return true
}

const speakGenieBrowserFallback = (spoken: string, onSpeakingStart?: () => void) =>
  new Promise<boolean>((resolve) => {
    if (!window.speechSynthesis) {
      resolve(false)
      return
    }

    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(spoken)
    utterance.lang = 'en-US'
    utterance.rate = 1.02 * genieSpeechPlaybackRate
    utterance.pitch = 1.05
    const voices = window.speechSynthesis.getVoices()
    const voice =
      voices.find(
        (entry) =>
          entry.lang.toLowerCase().startsWith('en') &&
          /samantha|google us english|natural|premium|enhanced/i.test(entry.name),
      ) || voices.find((entry) => entry.lang.toLowerCase().startsWith('en'))
    if (voice) {
      utterance.voice = voice
    }

    let settled = false
    let started = false
    let keepAlive = 0
    let safety = 0
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      window.clearInterval(keepAlive)
      window.clearTimeout(safety)
      resolve(started)
    }
    utterance.onstart = () => {
      started = true
      onSpeakingStart?.()
    }
    utterance.onend = finish
    utterance.onerror = finish
    keepAlive = window.setInterval(() => {
      if (settled || !window.speechSynthesis.speaking) {
        window.clearInterval(keepAlive)
        return
      }
      window.speechSynthesis.resume()
    }, 4000)
    safety = window.setTimeout(finish, Math.min(30000, 2500 + spoken.length * 70))
    try {
      window.speechSynthesis.speak(utterance)
    } catch {
      finish()
    }
  })

const speakGenieAloud = async (
  text: string,
  voiceOverride?: LampGenieVoiceId,
  onSpeakingStart?: () => void,
  prefetchedBlob?: Blob | null,
): Promise<boolean> => {
  const spoken = text.replace(/\s+/g, ' ').trim()
  if (!spoken || typeof window === 'undefined') {
    return false
  }

  stopGenieSpeech()
  const voice = voiceOverride && isLampGenieVoiceId(voiceOverride) ? voiceOverride : readStoredLampGenieVoice()

  const playBlob = (blob: Blob) =>
    new Promise<boolean>((resolve) => {
      const objectUrl = URL.createObjectURL(blob)
      const audio = ensureGenieSpeechPlayer() || new Audio()
      genieSpeechAudio = audio
      let started = false
      let settled = false
      const markStarted = () => {
        if (started) {
          return
        }
        started = true
        onSpeakingStart?.()
      }
      const finish = (played: boolean) => {
        if (settled) {
          return
        }
        settled = true
        if (genieSpeechAudio === audio) {
          genieSpeechAudio = null
        }
        URL.revokeObjectURL(objectUrl)
        resolve(played)
      }
      audio.onplay = markStarted
      audio.onplaying = markStarted
      audio.onended = () => finish(true)
      audio.onerror = () => finish(started)
      try {
        audio.playbackRate = genieSpeechPlaybackRate
      } catch {
        // Ignore browsers that reject playbackRate before load.
      }
      audio.src = objectUrl
      void audio
        .play()
        .then(() => {
          try {
            audio.playbackRate = genieSpeechPlaybackRate
          } catch {
            // Ignore.
          }
          markStarted()
        })
        .catch(async () => {
          const fallbackPlayed = await speakGenieBrowserFallback(spoken, onSpeakingStart)
          finish(fallbackPlayed)
        })
    })

  if (prefetchedBlob && prefetchedBlob.size > 0) {
    return playBlob(prefetchedBlob)
  }

  try {
    const response = await fetch(apiUrl('/api/card-interview-speak'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken, voice }),
    })
    if (response.ok) {
      const blob = await response.blob()
      const contentType = response.headers.get('content-type') || blob.type || ''
      if (blob.size > 0 && (/audio\//i.test(contentType) || !contentType.includes('json'))) {
        return playBlob(blob)
      }
    }
  } catch {
    // Fall back to browser speech below.
  }

  return speakGenieBrowserFallback(spoken, onSpeakingStart)
}

/** Start TTS fetch during the mic prompt so Genie can talk as soon as Allow lands. */
const prefetchGenieSpeechBlob = async (
  text: string,
  voiceOverride?: LampGenieVoiceId,
): Promise<Blob | null> => {
  const spoken = text.replace(/\s+/g, ' ').trim()
  if (!spoken || typeof window === 'undefined') {
    return null
  }
  const voice = voiceOverride && isLampGenieVoiceId(voiceOverride) ? voiceOverride : readStoredLampGenieVoice()
  try {
    const response = await fetch(apiUrl('/api/card-interview-speak'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken, voice }),
    })
    if (!response.ok) {
      return null
    }
    const blob = await response.blob()
    const contentType = response.headers.get('content-type') || blob.type || ''
    if (blob.size > 0 && (/audio\//i.test(contentType) || !contentType.includes('json'))) {
      return blob
    }
  } catch {
    // Prefetch is best-effort.
  }
  return null
}

const isLocalApiDev = import.meta.env.DEV && !apiBaseUrl

const localShareUrl = (cardId: string) =>
  `${window.location.origin}/?card=${encodeURIComponent(cardId)}`
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
  '/faq': '/faq/index.html',
  '/faq/': '/faq/index.html',
  '/terms': '/terms/index.html',
  '/terms/': '/terms/index.html',
}

const supportEmail = 'support@card-genie.com'
const supportMailto = `mailto:${supportEmail}`
const accountSessionStorageKey = 'cardGenieAccountSession'
const preferredNamePromptStorageKey = (phoneE164: string) =>
  `cardGeniePreferredNamePrompt:${String(phoneE164 || '').trim()}`
const feedbackDismissStorageKey = 'cardGenieFeedbackDismissed'
const feedbackCommentMaxLength = 280
const thankYouPresets = [
  { id: 'thank_you', label: 'Thank you for the beautiful card!' },
  { id: 'made_my_day', label: 'This made my day.' },
  { id: 'custom', label: 'Write your own', allowsCustom: true },
] as const
const thankYouCustomMaxLength = 180

const getThankYouCardPrefill = () => {
  const params = new URLSearchParams(window.location.search)
  if (params.get('thankYou') !== '1') {
    return null
  }

  return {
    senderName: params.get('from')?.trim() || '',
    recipientName: params.get('to')?.trim() || '',
    occasion: params.get('occasion')?.trim() || 'thank you',
  }
}

const staticPageRedirect = staticPageRedirects[window.location.pathname]

if (staticPageRedirect) {
  window.location.replace(staticPageRedirect)
}

const getApiJson = async (response: Response, fallbackMessage: string) => {
  const contentType = response.headers.get('content-type') || ''
  const bodyText = await response.text()

  if (contentType.includes('application/json') || /^\s*[{[]/.test(bodyText)) {
    try {
      return bodyText ? JSON.parse(bodyText) : {}
    } catch {
      throw new Error(fallbackMessage)
    }
  }

  if (!response.ok) {
    if (isLocalApiDev && /Cannot (GET|POST) \/api\//i.test(bodyText)) {
      throw new Error(
        'Local API server is missing this route. Stop dev, then run npm run dev again (or restart node server/index.js on port 8787).',
      )
    }
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
    return 'That card took too long. Please try again in a moment. Your credits are still in your account.'
  }

  return message || fallbackMessage
}

const generationJobStorageKey = 'cardgenie.generationJob'
const checkoutResumeStorageKey = 'cardGenieCheckoutResume'
const generateJobPollMs = 2000
const generateJobClientTimeoutMs = 12 * 60 * 1000
const generateJobMaxPollFailures = 15
const generationLostConnectionMessage =
  'We lost the connection while checking on your card. Come back to this page — if it finished, it will appear. No credits are used until the card is ready.'

type CheckoutResumeState = {
  version: 1
  savedAt: number
  cardId?: string
  shareUrl?: string
  details: CardDetails
  card?: GeneratedCard
  greeting?: string | null
  signature?: string | null
  step: ExperienceStep
  hasViewedFront: boolean
  hasViewedInside: boolean
  hasSentCurrentCard: boolean
  deliveryMethod: DeliveryMethod
  deliveryDestinations: string[]
  showSenderCopyField: boolean
  senderCopyEmail: string
  smsConsentConfirmed: boolean
  printOrderStep?: PrintOrderStep
  printShipTo?: MailingAddress
  printMailFrom?: MailingAddress
  printShopperEmail?: string
}

const normalizeResumeMailingAddress = (
  value: unknown,
  fallback: MailingAddress,
): MailingAddress => {
  if (!value || typeof value !== 'object') {
    return { ...fallback }
  }

  const raw = value as Record<string, unknown>
  return {
    name: typeof raw.name === 'string' ? raw.name : fallback.name,
    line1: typeof raw.line1 === 'string' ? raw.line1 : fallback.line1,
    line2: typeof raw.line2 === 'string' ? raw.line2 : fallback.line2,
    city: typeof raw.city === 'string' ? raw.city : fallback.city,
    state: typeof raw.state === 'string' ? raw.state : fallback.state,
    zip: typeof raw.zip === 'string' ? raw.zip : fallback.zip,
    country: 'US',
  }
}

const isPrintOrderStep = (value: unknown): value is PrintOrderStep =>
  value === 'closed' || value === 'ship-to' || value === 'mail-from' || value === 'review'

const isCheckoutResumeCardId = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())

/** Drop huge data-URL covers — they exceed storage quotas and are recoverable via cardId. */
const slimCheckoutResumeCard = (card?: GeneratedCard | null): GeneratedCard | undefined => {
  if (!card?.message) {
    return undefined
  }

  const imageUrl = card.imageUrl?.startsWith('data:') ? '' : card.imageUrl || ''
  return {
    imageUrl,
    message: card.message,
    closing: card.closing,
    messageVariants: card.messageVariants,
    selectedLength: card.selectedLength,
  }
}

const parseCheckoutResume = (raw: string | null): CheckoutResumeState | null => {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as CheckoutResumeState
    if (parsed?.version !== 1 || !parsed.details) {
      return null
    }

    // Ignore stale snapshots older than 6 hours.
    if (parsed.savedAt && Date.now() - parsed.savedAt > 6 * 60 * 60 * 1000) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

const readCheckoutResume = (): CheckoutResumeState | null => {
  try {
    // Prefer localStorage — Stripe redirects often wipe sessionStorage on mobile browsers.
    const localRaw = window.localStorage.getItem(checkoutResumeStorageKey)
    const localResume = parseCheckoutResume(localRaw)
    if (localRaw && !localResume) {
      window.localStorage.removeItem(checkoutResumeStorageKey)
    }
    if (localResume) {
      return localResume
    }

    const sessionRaw = window.sessionStorage.getItem(checkoutResumeStorageKey)
    const sessionResume = parseCheckoutResume(sessionRaw)
    if (sessionRaw && !sessionResume) {
      window.sessionStorage.removeItem(checkoutResumeStorageKey)
    }
    return sessionResume
  } catch {
    return null
  }
}

const writeCheckoutResume = (state: CheckoutResumeState) => {
  const slimCard = slimCheckoutResumeCard(state.card)
  const payload = JSON.stringify({
    ...state,
    ...(slimCard ? { card: slimCard } : { card: undefined }),
  })
  let wrote = false

  try {
    window.localStorage.setItem(checkoutResumeStorageKey, payload)
    wrote = true
  } catch {
    // Private browsing or full storage — try sessionStorage next.
  }

  try {
    window.sessionStorage.setItem(checkoutResumeStorageKey, payload)
    wrote = true
  } catch {
    // Ignore session storage failures; localStorage may still hold the resume.
  }

  if (!wrote) {
    throw new Error('Unable to stash checkout resume state.')
  }
}

const clearCheckoutResume = () => {
  try {
    window.localStorage.removeItem(checkoutResumeStorageKey)
  } catch {
    // Ignore storage failures.
  }

  try {
    window.sessionStorage.removeItem(checkoutResumeStorageKey)
  } catch {
    // Ignore storage failures.
  }
}

const clearCheckoutResumeQueryParam = () => {
  try {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('resume')) {
      return
    }
    params.delete('resume')
    const nextQuery = params.toString()
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`
    window.history.replaceState({}, '', nextUrl)
  } catch {
    // Ignore history failures.
  }
}

type FormDraftState = {
  version: typeof formDraftVersion
  savedAt: number
  details: CardDetails
  referencePhotos: ReferencePhoto[]
  deliveryMethod: DeliveryMethod
  deliveryDestinations: string[]
  showSenderCopyField: boolean
  senderCopyEmail: string
  smsConsentConfirmed: boolean
  printOrderStep: PrintOrderStep
  printShipTo: MailingAddress
  printMailFrom: MailingAddress
  printShopperEmail: string
  cardId?: string
  shareUrl?: string
  card?: GeneratedCard
  cardGreeting?: string | null
  cardSignature?: string | null
  step?: ExperienceStep
  hasViewedFront?: boolean
  hasViewedInside?: boolean
  hasSentCurrentCard?: boolean
}

const isCardDetailsShape = (value: unknown): value is CardDetails => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const raw = value as Record<string, unknown>
  return typeof raw.recipientName === 'string' && typeof raw.senderName === 'string'
}

const parseFormDraft = (raw: string | null): FormDraftState | null => {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as FormDraftState
    if (parsed?.version !== formDraftVersion || !isCardDetailsShape(parsed.details)) {
      return null
    }
    if (parsed.savedAt && Date.now() - parsed.savedAt > formDraftMaxAgeMs) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const readFormDraft = (): FormDraftState | null => {
  try {
    const draft = parseFormDraft(window.localStorage.getItem(formDraftStorageKey))
    if (!draft) {
      const stale = window.localStorage.getItem(formDraftStorageKey)
      if (stale) {
        window.localStorage.removeItem(formDraftStorageKey)
      }
    }
    return draft
  } catch {
    return null
  }
}

const writeFormDraft = (draft: FormDraftState) => {
  const base = {
    ...draft,
    version: formDraftVersion,
    savedAt: Date.now(),
    card: slimCheckoutResumeCard(draft.card),
  }

  const tryWrite = (payload: string) => {
    window.localStorage.setItem(formDraftStorageKey, payload)
  }

  try {
    tryWrite(JSON.stringify(base))
    return
  } catch {
    // Quota — retry without reference photos.
  }

  try {
    tryWrite(
      JSON.stringify({
        ...base,
        referencePhotos: [],
      }),
    )
  } catch {
    // Ignore storage failures; in-session state still works.
  }
}

type InterviewSessionState = {
  version: typeof interviewSessionVersion
  savedAt: number
  showCardInterview: boolean
  interviewMode: InterviewMode
  interviewMessages: InterviewMessage[]
  interviewDraft: string
  interviewVoiceLoop: boolean
  interviewComplete: boolean
}

const isInterviewMessageShape = (value: unknown): value is InterviewMessage => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const raw = value as Record<string, unknown>
  return (
    (raw.role === 'assistant' || raw.role === 'user') &&
    typeof raw.content === 'string' &&
    raw.content.trim().length > 0
  )
}

const parseInterviewSession = (raw: string | null): InterviewSessionState | null => {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as InterviewSessionState
    if (parsed?.version !== interviewSessionVersion || !parsed.showCardInterview) {
      return null
    }
    if (parsed.savedAt && Date.now() - parsed.savedAt > interviewSessionMaxAgeMs) {
      return null
    }
    if (parsed.interviewMode !== 'chat' && parsed.interviewMode !== 'quick') {
      return null
    }
    if (!Array.isArray(parsed.interviewMessages) || !parsed.interviewMessages.every(isInterviewMessageShape)) {
      return null
    }
    return {
      version: interviewSessionVersion,
      savedAt: parsed.savedAt || Date.now(),
      showCardInterview: true,
      interviewMode: parsed.interviewMode,
      interviewMessages: parsed.interviewMessages.slice(-24),
      interviewDraft: String(parsed.interviewDraft || '').slice(0, 8000),
      interviewVoiceLoop: Boolean(parsed.interviewVoiceLoop),
      interviewComplete: Boolean(parsed.interviewComplete),
    }
  } catch {
    return null
  }
}

const readInterviewSession = (): InterviewSessionState | null => {
  try {
    const session = parseInterviewSession(window.localStorage.getItem(interviewSessionStorageKey))
    if (!session) {
      window.localStorage.removeItem(interviewSessionStorageKey)
    }
    return session
  } catch {
    return null
  }
}

const writeInterviewSession = (session: Omit<InterviewSessionState, 'version' | 'savedAt'>) => {
  if (!session.showCardInterview) {
    try {
      window.localStorage.removeItem(interviewSessionStorageKey)
    } catch {
      // Ignore storage failures.
    }
    return
  }

  const payload: InterviewSessionState = {
    version: interviewSessionVersion,
    savedAt: Date.now(),
    showCardInterview: true,
    interviewMode: session.interviewMode,
    interviewMessages: session.interviewMessages.slice(-24),
    interviewDraft: String(session.interviewDraft || '').slice(0, 8000),
    interviewVoiceLoop: Boolean(session.interviewVoiceLoop),
    interviewComplete: Boolean(session.interviewComplete),
  }

  try {
    window.localStorage.setItem(interviewSessionStorageKey, JSON.stringify(payload))
  } catch {
    // Ignore storage failures.
  }
}

const clearInterviewSession = () => {
  try {
    window.localStorage.removeItem(interviewSessionStorageKey)
  } catch {
    // Ignore storage failures.
  }
}

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
        'That card took too long. Please try generating again. Your credits are still in your account.',
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

        return data as {
          message: string
          closing?: string
          imageUrl: string
          selectedLength?: MessageLengthId
          messageVariants?: MessageVariants
        }
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

const getCreateCardValidationMessage = (field: Element | null) => {
  if (!(field instanceof HTMLElement)) {
    return 'Please complete the required fields, then try again.'
  }

  const label = field.closest('label')
  let labelText = ''
  if (label) {
    for (const node of Array.from(label.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim()
        if (text) {
          labelText = text
          break
        }
      }
    }
  }

  if (labelText === 'Personal details') {
    return 'Please add a few personal details so we can create the card.'
  }
  if (labelText === 'From') {
    return 'Please add who the card is from.'
  }
  if (labelText === 'Occasion') {
    return 'Please add an occasion for the card.'
  }
  if (labelText === 'Relation') {
    return 'Please add the relation (mom, friend, coworker, etc.).'
  }
  if (labelText) {
    return `Please fill in ${labelText}.`
  }

  return 'Please complete the required fields, then try again.'
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
  // Prefer blob decode so Safari can share/save large covers reliably.
  try {
    const response = await fetch(imageUrl, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!response.ok) {
      throw new Error(`Unable to fetch image (${response.status}).`)
    }
    const blob = await response.blob()
    if (!blob || blob.size < 32) {
      throw new Error('Image response was empty.')
    }
    return new File([blob], fileName, { type: blob.type || getImageMimeType(imageUrl) })
  } catch {
    // Fall through for cases fetch cannot handle.
  }

  if (imageUrl.startsWith('data:')) {
    const response = await fetch(imageUrl)
    const blob = await response.blob()
    return new File([blob], fileName, { type: blob.type || getImageMimeType(imageUrl) })
  }

  throw new Error('Unable to prepare that image for saving.')
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

const loadImageFromSrc = (imageUrl: string, useCors: boolean) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    if (useCors && !imageUrl.startsWith('data:') && !imageUrl.startsWith('blob:')) {
      image.crossOrigin = 'anonymous'
    }
    image.onload = () => {
      if (image.naturalWidth < 1 || image.naturalHeight < 1) {
        reject(new Error('Unable to load the cover image for print export.'))
        return
      }
      resolve(image)
    }
    image.onerror = () => reject(new Error('Unable to load the cover image for print export.'))
    image.src = imageUrl
  })

type PrintImageSource = {
  source: CanvasImageSource
  width: number
  height: number
  dispose?: () => void
}

const canExportImageSource = (source: CanvasImageSource) => {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')
    if (!context) {
      return false
    }
    context.drawImage(source, 0, 0, 8, 8)
    context.getImageData(0, 0, 1, 1)
    return Boolean(canvas.toDataURL('image/jpeg', 0.5))
  } catch {
    return false
  }
}

const getShareCoverImageUrl = (cardId: string) => apiUrl(`/c/${encodeURIComponent(cardId)}/cover`)

const findDisplayedCoverImage = (imageUrl?: string): HTMLImageElement | null => {
  const selectors = [
    '.card-cover-frame img',
    '.envelope-card-rise img',
    '.card-opening-cover img',
    '.editor-cover-frame img',
    '.editor-cover-thumb img',
    'img[alt*="Front of card"]',
    'img[alt*="Cover preview"]',
  ]

  for (const selector of selectors) {
    const image = document.querySelector<HTMLImageElement>(selector)
    if (image?.complete && image.naturalWidth > 1 && canExportImageSource(image)) {
      return image
    }
  }

  if (!imageUrl) {
    return null
  }

  const matches = Array.from(document.querySelectorAll<HTMLImageElement>('img')).filter(
    (image) =>
      image.complete &&
      image.naturalWidth > 1 &&
      (image.currentSrc === imageUrl || image.src === imageUrl),
  )

  return matches.find((image) => canExportImageSource(image)) || null
}

const loadImageViaBlobFetch = async (imageUrl: string): Promise<PrintImageSource> => {
  const response = await fetch(imageUrl, {
    mode: 'cors',
    credentials: 'omit',
    cache: 'force-cache',
  })
  if (!response.ok) {
    throw new Error(`Unable to fetch cover image (${response.status}).`)
  }

  const blob = await response.blob()
  if (!blob || blob.size < 32) {
    throw new Error('Cover image response was empty.')
  }

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      }
    } catch {
      // Fall through to object-URL Image decode.
    }
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await loadImageFromSrc(objectUrl, false)
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(objectUrl),
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

const loadImageElement = async (imageUrl: string) => {
  if (!imageUrl) {
    throw new Error('Unable to load the cover image for print export.')
  }

  // Prefer fetch→blob→object URL. Safari is much more reliable with this than huge data: URLs.
  try {
    const response = await fetch(imageUrl, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!response.ok) {
      throw new Error(`Unable to fetch image (${response.status}).`)
    }
    const blob = await response.blob()
    if (!blob || blob.size < 32) {
      throw new Error('Image response was empty.')
    }
    const objectUrl = URL.createObjectURL(blob)
    try {
      const image = await loadImageFromSrc(objectUrl, false)
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)
      return image
    } catch (error) {
      URL.revokeObjectURL(objectUrl)
      throw error
    }
  } catch {
    // Fall through to direct Image decode.
  }

  try {
    return await loadImageFromSrc(imageUrl, true)
  } catch {
    return loadImageFromSrc(imageUrl, false)
  }
}

const loadCoverImageForPrint = async ({
  imageUrl,
  cardId,
}: {
  imageUrl?: string
  cardId?: string
}): Promise<PrintImageSource> => {
  // Prefer the live in-memory cover (including revised data URLs) over /c/{id}/cover.
  // The share endpoint can lag behind revises and was previously preferred, which caused
  // print orders to ship an older cover while the UI still showed the revision.
  const candidates = [
    imageUrl || '',
    // Cache-bust share fallback in case a prior cover response is still cached.
    cardId ? `${getShareCoverImageUrl(cardId)}?v=${Date.now()}` : '',
  ].filter(Boolean)

  const tryCandidates = async () => {
    const displayed = findDisplayedCoverImage(imageUrl)
    if (displayed) {
      return {
        source: displayed,
        width: displayed.naturalWidth,
        height: displayed.naturalHeight,
      }
    }

    for (const candidate of candidates) {
      try {
        return await loadImageViaBlobFetch(candidate)
      } catch {
        // Try the next strategy.
      }

      for (const useCors of [true, false]) {
        try {
          const image = await loadImageFromSrc(candidate, useCors)
          if (!canExportImageSource(image)) {
            throw new Error('Cover image is not exportable (canvas security).')
          }
          return {
            source: image,
            width: image.naturalWidth,
            height: image.naturalHeight,
          }
        } catch {
          // Try the next strategy.
        }
      }
    }

    const anyDisplayed = findDisplayedCoverImage()
    if (anyDisplayed) {
      return {
        source: anyDisplayed,
        width: anyDisplayed.naturalWidth,
        height: anyDisplayed.naturalHeight,
      }
    }

    throw new Error(
      'Unable to prepare the cover for printing. Please keep this page open and try again.',
    )
  }

  try {
    return await tryCandidates()
  } catch (firstError) {
    // Brief pause then retry — helps right after save when the cover URL becomes available.
    await new Promise((resolve) => window.setTimeout(resolve, 450))
    try {
      return await tryCandidates()
    } catch {
      throw firstError instanceof Error
        ? firstError
        : new Error('Unable to prepare the cover for printing. Please keep this page open and try again.')
    }
  }
}

const upscaleImageToDataUrl = (
  image: CanvasImageSource,
  width: number,
  height: number,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.92,
) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    return ''
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  try {
    context.drawImage(image, 0, 0, width, height)
    return mimeType === 'image/jpeg' ? canvas.toDataURL('image/jpeg', quality) : canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

const COVER_THUMB_MAX_EDGE = 320

const createCoverThumbDataUrl = async (imageUrl: string, cardId?: string) => {
  const loaded = await loadCoverImageForPrint({ imageUrl, cardId })
  try {
    const scale = Math.min(1, COVER_THUMB_MAX_EDGE / Math.max(loaded.width, loaded.height))
    const width = Math.max(1, Math.round(loaded.width * scale))
    const height = Math.max(1, Math.round(loaded.height * scale))
    return upscaleImageToDataUrl(loaded.source, width, height, 'image/jpeg', 0.72)
  } finally {
    loaded.dispose?.()
  }
}

/** Compact JPEG cover for API revise/save — avoids shipping multi‑MB PNG data URLs on mobile. */
const COVER_API_MAX_EDGE = 1280

const prepareCoverJpegForApi = async (imageUrl?: string, cardId?: string) => {
  const loaded = await loadCoverImageForPrint({ imageUrl, cardId })
  try {
    const scale = Math.min(1, COVER_API_MAX_EDGE / Math.max(loaded.width, loaded.height))
    const width = Math.max(1, Math.round(loaded.width * scale))
    const height = Math.max(1, Math.round(loaded.height * scale))
    const jpeg = upscaleImageToDataUrl(loaded.source, width, height, 'image/jpeg', 0.88)
    if (!jpeg) {
      throw new Error('Unable to prepare the current cover for editing.')
    }
    return jpeg
  } finally {
    loaded.dispose?.()
  }
}

const isMobileDevice = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Safari (not Chrome/Firefox/Edge) on iPhone/iPad. */
const isMobileSafariBrowser = () => {
  const ua = navigator.userAgent
  if (!/iPhone|iPad|iPod/i.test(ua) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return false
  }
  return /WebKit/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/i.test(ua)
}

/**
 * Chrome iOS shows “Microphone access allowed” on every recognition.start().
 * Prefer one long continuous session there. Mobile Safari is happier with
 * continuous:false + quiet onend restarts.
 */
const preferContinuousInterviewListen = () => !isMobileDevice() || !isMobileSafariBrowser()

/** Chrome/Android: durable MediaRecorder+Whisper session. Safari keeps SpeechRecognition. */
const preferStreamInterviewListen = () =>
  typeof MediaRecorder !== 'undefined' && preferContinuousInterviewListen()

type ScreenWakeLock = {
  released: boolean
  release: () => Promise<void>
  addEventListener?: (type: 'release', listener: () => void, options?: { once?: boolean }) => void
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

/** iOS Low Power Mode often blocks Wake Lock; a near-silent loop can help keep the page active. */
const silentStayAwakeAudioSrc =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'

const startSilentStayAwakeAudio = async (audio: HTMLAudioElement | null, setAudio: (next: HTMLAudioElement) => void) => {
  try {
    let element = audio
    if (!element) {
      element = new Audio(silentStayAwakeAudioSrc)
      element.loop = true
      element.volume = 0.01
      element.setAttribute('playsinline', 'true')
      setAudio(element)
    }
    if (element.paused) {
      await element.play()
    }
    return true
  } catch {
    return false
  }
}

const stopSilentStayAwakeAudio = (audio: HTMLAudioElement | null) => {
  if (!audio) {
    return
  }
  audio.pause()
  audio.currentTime = 0
}

const ensureGenieSpeechPlayer = () => {
  if (typeof window === 'undefined') {
    return null
  }
  if (!genieSpeechPlayer) {
    genieSpeechPlayer = new Audio()
    genieSpeechPlayer.setAttribute('playsinline', 'true')
    genieSpeechPlayer.preload = 'auto'
  }
  return genieSpeechPlayer
}

/** Call from a user gesture so later Genie replies can play without another tap. */
const unlockGenieSpeechAudio = async () => {
  const player = ensureGenieSpeechPlayer()
  if (!player) {
    return false
  }
  try {
    player.muted = true
    player.src = silentStayAwakeAudioSrc
    await player.play()
    player.pause()
    player.currentTime = 0
    player.muted = false
    // Keep the silent clip loaded — clearing src/load() re-locks autoplay on iOS/Chrome.
    return true
  } catch {
    try {
      player.muted = false
    } catch {
      // Ignore.
    }
    return false
  }
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

type InsideMessageDensity = 'is-short' | 'is-medium' | 'is-long'

const rootRemSize = () => {
  if (typeof document === 'undefined') {
    return 16
  }
  const size = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(size) && size > 0 ? size : 16
}

const cssClampSize = (minRem: number, preferredCqi: number, maxRem: number, cqi: number) => {
  const rem = rootRemSize()
  return Math.min(maxRem * rem, Math.max(minRem * rem, preferredCqi * cqi))
}

const getVisibleInsideCardWidth = () => {
  if (typeof document === 'undefined') {
    return 450
  }

  const reference = document.querySelector(
    '.open-card, .card-open-stage, .card-cover-frame',
  ) as HTMLElement | null
  const measured = Math.round(reference?.getBoundingClientRect().width || 0)
  if (measured >= 200) {
    return measured
  }

  return Math.round(Math.min(450, Math.max(280, window.innerWidth - 48)))
}

/** Match on-screen `.open-card-message` layout (cqi + CSS clamp) so print wraps match the preview. */
const createInsideImageUrl = ({
  greeting,
  paragraphs,
  closing,
  signature,
  width = CARD_COVER_WIDTH,
  height = CARD_COVER_HEIGHT,
  showFrame = true,
  density = 'is-short',
  printSafe = false,
  /** When set, fonts/wraps use this width then the canvas is scaled up to `width` (sharp print). */
  layoutBasisWidth,
}: {
  greeting: string
  paragraphs: string[]
  closing: string
  signature: string
  width?: number
  height?: number
  showFrame?: boolean
  density?: InsideMessageDensity
  printSafe?: boolean
  layoutBasisWidth?: number
}) => {
  if (typeof document === 'undefined') {
    return ''
  }

  const basisWidth = Math.max(1, Math.round(layoutBasisWidth || width))
  const basisHeight = Math.round(basisWidth * (height / width))
  const scale = width / basisWidth

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')

  if (!context) {
    return ''
  }

  // Draw in basis-space coordinates, scaled to full print pixels so glyphs stay sharp.
  context.setTransform(scale, 0, 0, scale, 0, 0)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const cqi = basisWidth / 100
  const padX = 16 * cqi
  const padY = 12 * cqi
  const maxTextWidth = Math.max(1, basisWidth - padX * 2)

  const bodyFontSize =
    density === 'is-long'
      ? cssClampSize(0.72, 3.03, 1.01, cqi)
      : density === 'is-medium'
        ? cssClampSize(0.79, 3.41, 1.14, cqi)
        : cssClampSize(0.86, 3.85, 1.3, cqi)
  const bodyLineHeightMult = density === 'is-long' ? 1.24 : density === 'is-medium' ? 1.3 : 1.35
  const bodyLineHeight = bodyFontSize * bodyLineHeightMult
  const greetingFontSize = cssClampSize(0.83, 3.74, 1.3, cqi)
  const greetingLineHeight = greetingFontSize * 1.35
  const closingFontSize = cssClampSize(0.83, 3.52, 1.23, cqi)
  const closingLineHeight = closingFontSize * 1.2
  const signatureFontSize = cssClampSize(1.32, 9.35, 3.08, cqi)
  const signatureLineHeight = signatureFontSize * 0.9
  const afterGreetingGap = 2.4 * cqi
  const afterParagraphGap = (density === 'is-long' ? 2.2 : 3.1) * cqi
  const beforeClosingGap = 7 * cqi
  const beforeSignatureGap = 6.5 * cqi

  const serifFont = '"Playfair Display", Georgia, serif'
  const scriptFont = '"Dancing Script", cursive'

  if (printSafe) {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, basisWidth, basisHeight)
  } else {
    context.fillStyle = '#fffdf6'
    context.fillRect(0, 0, basisWidth, basisHeight)
    const topGlow = context.createRadialGradient(
      basisWidth * 0.82,
      basisHeight * 0.08,
      0,
      basisWidth * 0.82,
      basisHeight * 0.08,
      basisWidth * 0.55,
    )
    topGlow.addColorStop(0, 'rgba(245, 158, 51, 0.14)')
    topGlow.addColorStop(1, 'rgba(245, 158, 51, 0)')
    context.fillStyle = topGlow
    context.fillRect(0, 0, basisWidth, basisHeight)
  }

  if (showFrame) {
    context.strokeStyle = 'rgba(63, 155, 145, 0.3)'
    context.lineWidth = Math.max(1, 0.35 * cqi)
    context.strokeRect(padX * 0.35, padY * 0.35, basisWidth - padX * 0.7, basisHeight - padY * 0.7)
  }

  context.textAlign = 'center'
  context.textBaseline = 'top'

  context.font = `700 ${greetingFontSize}px ${serifFont}`
  const greetingLines = greeting.trim() ? wrapCanvasText(context, greeting.trim(), maxTextWidth) : []
  context.font = `700 ${bodyFontSize}px ${serifFont}`
  const paragraphLineGroups = paragraphs.map((paragraph) => wrapCanvasText(context, paragraph, maxTextWidth))
  context.font = `700 ${closingFontSize}px ${serifFont}`
  const closingLines = closing.trim() ? wrapCanvasText(context, closing.trim(), maxTextWidth) : []
  context.font = `700 ${signatureFontSize}px ${scriptFont}`
  const signatureLines = signature.trim() ? wrapCanvasText(context, signature.trim(), maxTextWidth) : []

  let contentHeight = 0
  if (greetingLines.length) {
    contentHeight += greetingLines.length * greetingLineHeight + afterGreetingGap
  }
  paragraphLineGroups.forEach((lines, index) => {
    contentHeight += lines.length * bodyLineHeight
    if (index < paragraphLineGroups.length - 1) {
      contentHeight += afterParagraphGap
    }
  })
  if (closingLines.length) {
    contentHeight += beforeClosingGap + closingLines.length * closingLineHeight
  }
  if (signatureLines.length) {
    contentHeight += beforeSignatureGap + signatureLines.length * signatureLineHeight
  }

  const contentTop = padY
  const contentBottom = basisHeight - padY
  const available = Math.max(0, contentBottom - contentTop)
  let y = contentTop + Math.max(0, (available - contentHeight) / 2)
  const centerX = basisWidth / 2

  if (greetingLines.length) {
    context.fillStyle = '#315f5b'
    context.font = `700 ${greetingFontSize}px ${serifFont}`
    drawCenteredLines(context, greetingLines, centerX, y, greetingLineHeight)
    y += greetingLines.length * greetingLineHeight + afterGreetingGap
  }

  context.fillStyle = '#315f5b'
  context.font = `700 ${bodyFontSize}px ${serifFont}`
  paragraphLineGroups.forEach((lines, index) => {
    drawCenteredLines(context, lines, centerX, y, bodyLineHeight)
    y += lines.length * bodyLineHeight
    if (index < paragraphLineGroups.length - 1) {
      y += afterParagraphGap
    }
  })

  if (closingLines.length) {
    y += beforeClosingGap
    context.fillStyle = '#315f5b'
    context.font = `700 ${closingFontSize}px ${serifFont}`
    drawCenteredLines(context, closingLines, centerX, y, closingLineHeight)
    y += closingLines.length * closingLineHeight
  }

  if (signatureLines.length) {
    y += beforeSignatureGap
    context.save()
    context.fillStyle = '#d88a31'
    context.font = `700 ${signatureFontSize}px ${scriptFont}`
    context.translate(centerX, y + (signatureLines.length * signatureLineHeight) / 2)
    context.rotate((-2 * Math.PI) / 180)
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    signatureLines.forEach((line, index) => {
      const lineY = (index - (signatureLines.length - 1) / 2) * signatureLineHeight
      context.fillText(line, 0, lineY)
    })
    context.restore()
  }

  return canvas.toDataURL('image/png')
}

/** Render the inside at full print pixels using on-screen wrap proportions (no soft bitmap upscale). */
const buildPrintInsideImageUrl = async ({
  greeting,
  paragraphs,
  closing,
  signature,
  density,
}: {
  greeting: string
  paragraphs: string[]
  closing: string
  signature: string
  density: InsideMessageDensity
}) => {
  if (typeof document === 'undefined') {
    return ''
  }

  if (document.fonts?.ready) {
    try {
      await document.fonts.ready
    } catch {
      // Continue with fallback fonts if loading stalls.
    }
  }

  try {
    await Promise.all([
      document.fonts.load('700 64px "Playfair Display"'),
      document.fonts.load('700 96px "Dancing Script"'),
    ])
  } catch {
    // Fall through — system serif/script substitutes still print.
  }

  const layoutWidth = Math.max(getVisibleInsideCardWidth(), 320)

  return (
    createInsideImageUrl({
      greeting,
      paragraphs,
      closing,
      signature,
      width: PRINT_CARD_WIDTH,
      height: PRINT_CARD_HEIGHT,
      layoutBasisWidth: layoutWidth,
      showFrame: false,
      density,
      printSafe: true,
    }) || ''
  )
}


function App() {
  const sharedCardId = useMemo(() => getSharedCardId(), [])
  const isRecipientView = Boolean(sharedCardId)
  const initialFormDraft = useMemo(() => (isRecipientView ? null : readFormDraft()), [isRecipientView])
  const [details, setDetails] = useState<CardDetails>(() => initialFormDraft?.details || initialDetails)
  const [card, setCard] = useState<GeneratedCard | null>(null)
  const [step, setStep] = useState<ExperienceStep>('envelope')
  const [hasViewedFront, setHasViewedFront] = useState(false)
  const [hasViewedInside, setHasViewedInside] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showCompletionNote, setShowCompletionNote] = useState(false)
  const [activeGenerationStep, setActiveGenerationStep] = useState(0)
  const [imageRefinement, setImageRefinement] = useState('')
  const [coverRefinementMode, setCoverRefinementMode] = useState<CoverRefinementMode>('revise')
  const [copyRefinement, setCopyRefinement] = useState('')
  const [isRefiningImage, setIsRefiningImage] = useState(false)
  const [isRefiningCopy, setIsRefiningCopy] = useState(false)
  const [refinementNotice, setRefinementNotice] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [editorHasChanges, setEditorHasChanges] = useState(false)
  const [hasAcceptedRevision, setHasAcceptedRevision] = useState(false)
  const [editorTab, setEditorTab] = useState<EditorTab>('front')
  const [showPolishDialog, setShowPolishDialog] = useState(false)
  const [cardGreeting, setCardGreeting] = useState<string | null>(() => initialFormDraft?.cardGreeting ?? null)
  const [cardSignature, setCardSignature] = useState<string | null>(() => initialFormDraft?.cardSignature ?? null)
  const [credits, setCredits] = useState(() => {
    const stored = window.localStorage.getItem(creditStorageKey)
    if (stored === null) {
      return initialCreditBalance
    }

    const parsed = Number(stored)
    return Number.isFinite(parsed) ? parsed : initialCreditBalance
  })
  const [showCreditMenu, setShowCreditMenu] = useState(false)
  const [showCreditDetails, setShowCreditDetails] = useState(false)
  const [showAccountPage, setShowAccountPage] = useState(false)
  const [adminView, setAdminView] = useState<'analytics' | 'reviews' | null>(null)
  const [accountHistory, setAccountHistory] = useState<{
    phoneE164?: string
    account?: {
      creditBalance?: number
      creditsGranted?: number
      creditsPurchased?: number
      creditsSpent?: number
      createdAt?: string
      email?: string
      preferredName?: string
      mailingAddress?: MailingAddress | null
    } | null
    creditEvents?: Array<{
      createdAt: string
      label: string
      creditsDelta: number
      balanceAfter: number
      note?: string
    }>
    cards?: Array<{
      id: string
      createdAt: string
      recipientName: string
      occasion: string
      status: string
      coverThumbUrl?: string
    }>
    deliveries?: Array<{
      id: string
      cardId?: string
      createdAt: string
      method: string
      destination: string
      isSenderCopy: boolean
      status: string
      coverThumbUrl?: string
    }>
    thankYous?: Array<{
      id: string
      cardId: string
      createdAt: string
      message: string
      recipientName: string
      status: string
    }>
    printOrders?: Array<{
      orderNumber?: number
      orderCode: string
      cardId?: string
      createdAt: string
      shipToName?: string
      shipTo?: MailingAddress | Record<string, string>
      mailFrom?: MailingAddress | Record<string, string>
      shopperEmail?: string
      status: string
      creditCost?: number
      coverThumbUrl?: string
    }>
  } | null>(null)
  const [isLoadingAccountHistory, setIsLoadingAccountHistory] = useState(false)
  const [accountHistoryError, setAccountHistoryError] = useState('')
  const [showAllCreditEvents, setShowAllCreditEvents] = useState(false)
  const [showAllCardActivity, setShowAllCardActivity] = useState(false)
  const [showAllPrintOrders, setShowAllPrintOrders] = useState(false)
  const [accountProfileEmail, setAccountProfileEmail] = useState('')
  const [accountPreferredName, setAccountPreferredName] = useState('')
  const [preferredNamePromptDraft, setPreferredNamePromptDraft] = useState('')
  const [showPreferredNamePrompt, setShowPreferredNamePrompt] = useState(false)
  const [isSavingPreferredNamePrompt, setIsSavingPreferredNamePrompt] = useState(false)
  const [accountProfileMailing, setAccountProfileMailing] = useState<MailingAddress>(() => emptyMailingAddress())
  const [accountProfileNotice, setAccountProfileNotice] = useState('')
  const [isSavingAccountProfile, setIsSavingAccountProfile] = useState(false)
  const [activeCoverThumbId, setActiveCoverThumbId] = useState<string | null>(null)
  const [thankYouAvailable, setThankYouAvailable] = useState(false)
  const [thankYouAlreadySent, setThankYouAlreadySent] = useState(false)
  const [thankYouPresetsState, setThankYouPresetsState] = useState<
    Array<{ id: string; label: string; allowsCustom?: boolean }>
  >([...thankYouPresets])
  const [selectedThankYouPreset, setSelectedThankYouPreset] = useState<string>(thankYouPresets[0].id)
  const [customThankYouMessage, setCustomThankYouMessage] = useState('')
  const [isSendingThankYou, setIsSendingThankYou] = useState(false)
  const [thankYouNotice, setThankYouNotice] = useState('')
  const [creditNotice, setCreditNotice] = useState('')
  const [adminPrintFiles, setAdminPrintFiles] = useState<{ coverUrl: string; insideUrl: string } | null>(null)
  const [isPreparingAdminPrintFiles, setIsPreparingAdminPrintFiles] = useState(false)
  const [adminPrintNotice, setAdminPrintNotice] = useState('')
  const [error, setError] = useState('')
  const [showCardInterview, setShowCardInterview] = useState(false)
  const [interviewMode, setInterviewMode] = useState<InterviewMode>('quick')
  const [interviewVoiceLoop, setInterviewVoiceLoop] = useState(false)
  const [isInterviewSpeaking, setIsInterviewSpeaking] = useState(false)
  const [interviewMessages, setInterviewMessages] = useState<InterviewMessage[]>([
    { role: 'assistant', content: interviewQuickGreeting },
  ])
  const [interviewDraft, setInterviewDraft] = useState('')
  const [interviewNotice, setInterviewNotice] = useState('')
  const [isInterviewing, setIsInterviewing] = useState(false)
  const [isInterviewListening, setIsInterviewListening] = useState(false)
  const [interviewComplete, setInterviewComplete] = useState(false)
  const [pendingHearGenieText, setPendingHearGenieText] = useState<string | null>(null)
  const [showLampVoicePicker, setShowLampVoicePicker] = useState(false)
  const [lampGenieVoice, setLampGenieVoice] = useState<LampGenieVoiceId>(() => readStoredLampGenieVoice())
  const [previewingLampVoice, setPreviewingLampVoice] = useState<LampGenieVoiceId | null>(null)
  const [interviewSpeechSupported] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }
    const speechWindow = window as Window & {
      SpeechRecognition?: unknown
      webkitSpeechRecognition?: unknown
    }
    return Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition)
  })
  const [interviewStreamListenSupported] = useState(() => preferStreamInterviewListen())
  const interviewMicSupported = interviewSpeechSupported || interviewStreamListenSupported
  const interviewRecognitionRef = useRef<InterviewSpeechRecognition | null>(null)
  const interviewListenDesiredRef = useRef(false)
  const interviewBaseDraftRef = useRef('')
  const interviewLatestDraftRef = useRef('')
  const interviewThreadRef = useRef<HTMLDivElement | null>(null)
  const isInterviewingRef = useRef(false)
  const showCardInterviewRef = useRef(false)
  const interviewVoiceLoopRef = useRef(false)
  const interviewSpeakingRef = useRef(false)
  const interviewAutoSendTimerRef = useRef(0)
  const interviewInterimFinalizeTimerRef = useRef(0)
  const interviewListenWatchdogRef = useRef(0)
  const interviewLastSpeechResultAtRef = useRef(0)
  const interviewListenRestartCountRef = useRef(0)
  const interviewListenStartAtRef = useRef(0)
  const interviewListenRecoverAtRef = useRef(0)
  /** True only while SpeechRecognition is actually running (start succeeded, onend not yet fired). */
  const interviewListenActiveRef = useRef(false)
  /** Ignore mic transcripts while Genie speaks (and briefly after) so we can keep the session alive. */
  const interviewMicIgnoreUntilRef = useRef(0)
  const interviewStreamDesiredRef = useRef(false)
  const interviewStreamPausedRef = useRef(false)
  const interviewMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const interviewStreamLoopIdRef = useRef(0)
  const interviewStreamChunkTimerRef = useRef(0)
  const interviewStreamTranscribingRef = useRef(false)
  const sendCardInterviewRef = useRef<() => Promise<void>>(async () => {})
  const [highlightInvalidFields, setHighlightInvalidFields] = useState(false)
  const [sharedCard, setSharedCard] = useState<SharedCard | null>(null)
  const [isLoadingSharedCard, setIsLoadingSharedCard] = useState(false)
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>(
    () => (initialFormDraft?.deliveryMethod === 'text' ? 'text' : 'email'),
  )
  const [deliveryDestinations, setDeliveryDestinations] = useState<string[]>(() =>
    Array.isArray(initialFormDraft?.deliveryDestinations) && initialFormDraft.deliveryDestinations.length > 0
      ? initialFormDraft.deliveryDestinations
      : [''],
  )
  const [printOrderStep, setPrintOrderStep] = useState<PrintOrderStep>(() =>
    isPrintOrderStep(initialFormDraft?.printOrderStep) ? initialFormDraft.printOrderStep : 'closed',
  )
  const [printShipTo, setPrintShipTo] = useState<MailingAddress>(() =>
    normalizeResumeMailingAddress(initialFormDraft?.printShipTo, emptyMailingAddress()),
  )
  const [printMailFrom, setPrintMailFrom] = useState<MailingAddress>(() =>
    normalizeResumeMailingAddress(initialFormDraft?.printMailFrom, { ...defaultPrintMailFrom }),
  )
  const [printShopperEmail, setPrintShopperEmail] = useState(() => initialFormDraft?.printShopperEmail || '')
  const [printOrderNotice, setPrintOrderNotice] = useState<ReactNode>('')
  const [isOrderingPrint, setIsOrderingPrint] = useState(false)
  const [showSenderCopyField, setShowSenderCopyField] = useState(
    () => Boolean(initialFormDraft?.showSenderCopyField),
  )
  const [senderCopyEmail, setSenderCopyEmail] = useState(() => initialFormDraft?.senderCopyEmail || '')
  const [smsConsentConfirmed, setSmsConsentConfirmed] = useState(
    () => Boolean(initialFormDraft?.smsConsentConfirmed),
  )
  const [isDelivering, setIsDelivering] = useState(false)
  const [deliveryNotice, setDeliveryNotice] = useState('')
  const [showAccountConfirm, setShowAccountConfirm] = useState(false)
  const [accountPhone, setAccountPhone] = useState('')
  const [accountCode, setAccountCode] = useState('')
  const [accountSession, setAccountSession] = useState<{
    token: string
    phoneE164: string
    copyEmail?: string
    preferredName?: string
    mailingAddress?: MailingAddress | null
  } | null>(null)
  const [isSendingAccountCode, setIsSendingAccountCode] = useState(false)
  const [isVerifyingAccountCode, setIsVerifyingAccountCode] = useState(false)
  const [deliveryLogs, setDeliveryLogs] = useState<DeliveryLog[]>([])
  const [hasSentCurrentCard, setHasSentCurrentCard] = useState(
    () => Boolean(initialFormDraft?.hasSentCurrentCard),
  )
  const [feedbackDismissed, setFeedbackDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(feedbackDismissStorageKey) === '1'
    } catch {
      return false
    }
  })
  const [showFeedbackForm, setShowFeedbackForm] = useState(false)
  const [feedbackSource, setFeedbackSource] = useState<'post_send' | 'account'>('post_send')
  const [feedbackName, setFeedbackName] = useState('')
  const [feedbackRating, setFeedbackRating] = useState<number | null>(null)
  const [feedbackComment, setFeedbackComment] = useState('')
  const [feedbackNotice, setFeedbackNotice] = useState('')
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false)
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false)
  const [adminMetrics, setAdminMetrics] = useState<{
    today?: string
    period?: string
    rangeStart?: string
    rangeEnd?: string
    days?: number
    timezone?: string
    totals?: Record<string, number>
    todayStats?: Record<string, number>
    periodStats?: Record<string, number>
    daily?: Record<string, Array<{ day: string; count: number }>>
  } | null>(null)
  const [adminMetricsPeriod, setAdminMetricsPeriod] = useState<'today' | '7d' | '30d' | 'ytd'>('7d')
  const [isLoadingAdminMetrics, setIsLoadingAdminMetrics] = useState(false)
  const [adminMetricsError, setAdminMetricsError] = useState('')
  const [isBackfillingThumbs, setIsBackfillingThumbs] = useState(false)
  const [thumbBackfillNotice, setThumbBackfillNotice] = useState('')
  const [pendingReviews, setPendingReviews] = useState<
    Array<{
      id: string
      createdAt: string
      name?: string
      rating?: number | null
      comment: string
      source?: string
      status?: string
    }>
  >([])
  const [adminReviewStatus, setAdminReviewStatus] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [isLoadingPendingReviews, setIsLoadingPendingReviews] = useState(false)
  const [pendingReviewNotice, setPendingReviewNotice] = useState('')
  const [updatingReviewId, setUpdatingReviewId] = useState('')
  const [adminGrantPhone, setAdminGrantPhone] = useState('')
  const [adminGrantCredits, setAdminGrantCredits] = useState('20')
  const [adminGrantNotice, setAdminGrantNotice] = useState('')
  const [isGrantingCredits, setIsGrantingCredits] = useState(false)
  const [showAdminGrantCredits, setShowAdminGrantCredits] = useState(false)
  const [saveNotice, setSaveNotice] = useState('')
  const [referencePhotos, setReferencePhotos] = useState<ReferencePhoto[]>(() => {
    const photos = initialFormDraft?.referencePhotos
    if (!Array.isArray(photos)) {
      return []
    }
    return photos
      .filter(
        (photo): photo is ReferencePhoto =>
          Boolean(photo) &&
          typeof photo.id === 'string' &&
          typeof photo.name === 'string' &&
          typeof photo.dataUrl === 'string' &&
          photo.dataUrl.startsWith('data:image/'),
      )
      .slice(0, maxReferencePhotos)
  })
  const [referencePhotoNotice, setReferencePhotoNotice] = useState('')
  const [isAddingPhotos, setIsAddingPhotos] = useState(false)
  const [photoAddElapsed, setPhotoAddElapsed] = useState(0)
  const [actionFeedback, setActionFeedback] = useState('')
  const [isOpeningCheckout, setIsOpeningCheckout] = useState(false)
  const [isSavingImage, setIsSavingImage] = useState(false)
  const [startingInterviewMode, setStartingInterviewMode] = useState<InterviewMode | null>(null)
  const actionFeedbackClearRef = useRef<number | null>(null)
  const screenWakeLockRef = useRef<ScreenWakeLock | null>(null)
  const screenStayAwakeAudioRef = useRef<HTMLAudioElement | null>(null)
  const keepScreenAwakeRef = useRef(false)
  const generationPollIdRef = useRef(0)
  const draftCardRestoreAttemptedRef = useRef(false)
  const previewPanelRef = useRef<HTMLElement | null>(null)
  const createFormRef = useRef<HTMLFormElement | null>(null)
  const restoreSentAfterFailedGenerateRef = useRef(false)
  const followGenerationJobRef = useRef<(jobId: string, signatureName: string) => Promise<void>>(
    async () => undefined,
  )

  const clearActionFeedback = () => {
    if (actionFeedbackClearRef.current !== null) {
      window.clearTimeout(actionFeedbackClearRef.current)
      actionFeedbackClearRef.current = null
    }
    setActionFeedback('')
  }

  const showActionFeedback = (message: string, autoClearMs?: number) => {
    setActionFeedback(message)
    if (actionFeedbackClearRef.current !== null) {
      window.clearTimeout(actionFeedbackClearRef.current)
      actionFeedbackClearRef.current = null
    }
    if (typeof autoClearMs === 'number' && autoClearMs > 0) {
      actionFeedbackClearRef.current = window.setTimeout(() => {
        setActionFeedback('')
        actionFeedbackClearRef.current = null
      }, autoClearMs)
    }
  }

  const recipientLabel = useMemo(
    () => details.recipientName.trim() || details.recipientType.trim() || 'Someone special',
    [details.recipientName, details.recipientType],
  )
  const envelopeLabel = useMemo(
    () => details.recipientName.trim() || details.recipientType.trim() || 'Someone special',
    [details.recipientName, details.recipientType],
  )
  const senderLabel = useMemo(() => details.senderName.trim() || 'Your Name', [details.senderName])
  const thankYouCardHref = useMemo(() => {
    const params = new URLSearchParams({
      thankYou: '1',
      from: recipientLabel,
      to: senderLabel,
      occasion: 'thank you',
    })
    return `/?${params.toString()}`
  }, [recipientLabel, senderLabel])
  const envelopeAddress = `To ${envelopeLabel}`
  const envelopeAddressSize =
    envelopeAddress.length > 34 ? 'is-long' : envelopeAddress.length > 22 ? 'is-medium' : ''
  const recipientHeadline = `You received a card from ${senderLabel}`
  const recipientHeadlineSize =
    recipientHeadline.length > 42 ? 'is-long' : recipientHeadline.length > 32 ? 'is-medium' : ''
  const stampSrc = `${import.meta.env.BASE_URL}stamp.webp`
  const defaultGreeting = ''
  const insideGreeting = cardGreeting ?? defaultGreeting
  const cardSignatureLabel = cardSignature ?? senderLabel
  const cardMessage = card?.message ?? ''
  const cardClosing = card?.closing ?? 'With love,'
  const messageParagraphs = useMemo(() => splitIntoParagraphs(cardMessage), [cardMessage])
  const messageDensity = cardMessage.length > 620 ? 'is-long' : cardMessage.length > 420 ? 'is-medium' : 'is-short'
  const selectedMessageLengthId = (card?.selectedLength || 'medium') as MessageLengthId
  const selectedMessageLengthLabel =
    messageLengthChoices.find((choice) => choice.id === selectedMessageLengthId)?.label || 'Medium'
  const isPrintOrderOpen = printOrderStep !== 'closed'
  const fileNameBase = useMemo(
    () => sanitizeFilePart(`${recipientLabel}-${details.occasion || 'card'}`),
    [details.occasion, recipientLabel],
  )
  const coverDownloadName = card ? `${fileNameBase}-cover.${getImageExtension(card.imageUrl)}` : 'card-cover.png'
  const insideDownloadName = `${fileNameBase}-inside.png`
  const printCoverDownloadName = `${fileNameBase}-print-cover.png`
  const printInsideDownloadName = `${fileNameBase}-print-inside.png`
  const prefersPhotoSave = useMemo(() => isMobileDevice(), [])
  const coverSaveLabel = prefersPhotoSave ? 'Save cover to photos' : 'Save cover image'
  const insideSaveLabel = prefersPhotoSave ? 'Save inside to photos' : 'Save inside image'
  const printCoverSaveLabel = prefersPhotoSave ? 'Save print cover to photos' : 'Save print cover'
  const printInsideSaveLabel = prefersPhotoSave ? 'Save print inside to photos' : 'Save print inside'
  const insideDownloadUrl = useMemo(
    () =>
      card && isRecipientView
        ? createInsideImageUrl({
            greeting: insideGreeting,
            paragraphs: messageParagraphs,
            closing: cardClosing,
            signature: cardSignatureLabel,
            density: messageDensity,
          })
        : '',
    [card, cardSignatureLabel, cardClosing, insideGreeting, isRecipientView, messageDensity, messageParagraphs],
  )
  const generationLines = useMemo(
    () => [
      'Designing the card cover.',
      `Writing a ${details.tone.toLowerCase()} note.`,
      'Blending art with your story.',
      'Sealing the digital envelope.',
    ],
    [details.tone],
  )
  const filledDeliveryDestinations = deliveryDestinations.map((entry) => entry.trim()).filter(Boolean)
  const plannedRecipientCount = Math.max(1, filledDeliveryDestinations.length)
  const currentSendCreditCost = getSendCreditCost(plannedRecipientCount)
  const hasEnoughCreditsForCover = credits >= coverRevisionCost
  const hasEnoughCreditsForAiCopy = credits >= aiCopyCost
  const isAdmin = Boolean(accountSession?.phoneE164 && adminPhoneNumbers.has(accountSession.phoneE164))
  const isSignedIn = Boolean(accountSession?.token)
  const accountFirstName = (
    accountPreferredName.trim() ||
    accountSession?.preferredName?.trim() ||
    accountProfileMailing.name.trim() ||
    accountSession?.mailingAddress?.name?.trim() ||
    details.senderName.trim() ||
    ''
  )
    .split(/\s+/)
    .find(Boolean) || ''
  const creditsSummary = isSignedIn
    ? accountFirstName
      ? `Hi ${accountFirstName}. ${credits} credits in your account`
      : `${credits} credits in your account`
    : `${credits} credits on this device`
  const accountButtonLabel = isSignedIn ? 'My account' : 'Sign in'
  const adminMetricsPeriodLabel =
    adminMetricsPeriod === 'today'
      ? 'today'
      : adminMetricsPeriod === '7d'
        ? '7 days'
        : adminMetricsPeriod === '30d'
          ? '30 days'
          : 'YTD'
  const adminPeriodStats = adminMetrics?.periodStats || adminMetrics?.todayStats || {}
  const formatAdminDollars = (value: unknown) => {
    const amount = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(amount)) {
      return '$0.00'
    }
    return `$${amount.toFixed(2)}`
  }
  const showProofPanel = isRecipientView || isGenerating || isLoadingSharedCard || Boolean(card)
  const showSendActions = (step === 'front' || step === 'inside') && hasViewedInside
  const showReviseButton = hasViewedFront && hasViewedInside
  const showCoverWatermark = !isRecipientView && Boolean(card) && !hasSentCurrentCard
  const coverPreviewClass = (baseClass = '') =>
    [baseClass, 'cover-preview', showCoverWatermark ? 'is-watermarked' : ''].filter(Boolean).join(' ')
  const keepScreenAwake =
    isGenerating ||
    isRefiningImage ||
    isRefiningCopy ||
    isDelivering ||
    (showCardInterview &&
      (isInterviewListening || isInterviewSpeaking || isInterviewing || interviewVoiceLoop))

  keepScreenAwakeRef.current = keepScreenAwake

  const acquireScreenStayAwake = async () => {
    if (document.visibilityState !== 'visible') {
      return
    }

    try {
      if (!screenWakeLockRef.current || screenWakeLockRef.current.released) {
        const wakeLock = await requestScreenWakeLock()
        if (wakeLock) {
          screenWakeLockRef.current = wakeLock
          wakeLock.addEventListener?.(
            'release',
            () => {
              if (keepScreenAwakeRef.current) {
                void acquireScreenStayAwake()
              }
            },
            { once: true },
          )
        }
      }
    } catch {
      // Unsupported, denied, or battery saver.
    }

    if (isMobileDevice()) {
      await startSilentStayAwakeAudio(screenStayAwakeAudioRef.current, (next) => {
        screenStayAwakeAudioRef.current = next
      })
    }
  }

  const releaseScreenStayAwake = async () => {
    try {
      await screenWakeLockRef.current?.release()
    } catch {
      // Already released by the browser.
    }
    screenWakeLockRef.current = null
    stopSilentStayAwakeAudio(screenStayAwakeAudioRef.current)
  }

  useEffect(() => {
    const restoreAccount = async () => {
      try {
        const raw = window.localStorage.getItem(accountSessionStorageKey)
        if (!raw) {
          return
        }

        const parsed = JSON.parse(raw) as { token?: string; phoneE164?: string; copyEmail?: string }
        if (!parsed.token || !parsed.phoneE164) {
          return
        }

        setAccountSession({ token: parsed.token, phoneE164: parsed.phoneE164, copyEmail: parsed.copyEmail })
        setAccountPhone(formatPhoneNumberDisplay(parsed.phoneE164))
        if (parsed.copyEmail) {
          setSenderCopyEmail(parsed.copyEmail)
          setPrintShopperEmail(parsed.copyEmail)
        }

        const response = await fetch(apiUrl('/api/account'), {
          headers: { Authorization: `Bearer ${parsed.token}` },
        })
        if (!response.ok) {
          if (isLocalApiDev) {
            window.localStorage.removeItem(accountSessionStorageKey)
            setAccountSession(null)
          }
          return
        }

        const data = await getApiJson(response, 'Unable to load the saved account.')
        const copyEmail = String(data.email || parsed.copyEmail || '')
        const preferredName = String(data.preferredName || '').trim()
        const mailingAddress = normalizeResumeMailingAddress(
          data.mailingAddress,
          emptyMailingAddress(),
        )
        const hasMailing = !isMailingAddressBlank(mailingAddress)
        const session = {
          token: parsed.token,
          phoneE164: String(data.phoneE164 || parsed.phoneE164),
          copyEmail,
          preferredName,
          mailingAddress: hasMailing ? mailingAddress : null,
        }
        setAccountSession(session)
        window.localStorage.setItem(
          accountSessionStorageKey,
          JSON.stringify({
            token: session.token,
            phoneE164: session.phoneE164,
            copyEmail: session.copyEmail,
          }),
        )
        if (copyEmail) {
          setSenderCopyEmail(copyEmail)
          setPrintShopperEmail(copyEmail)
        }
        if (hasMailing) {
          setPrintMailFrom((current) =>
            isDefaultPrintMailFromAddress(current) ? mailingAddress : current,
          )
        }
        setAccountProfileEmail(copyEmail)
        setAccountPreferredName(preferredName)
        setAccountProfileMailing(hasMailing ? mailingAddress : emptyMailingAddress())
        if (!preferredName) {
          try {
            const dismissed =
              window.localStorage.getItem(preferredNamePromptStorageKey(session.phoneE164)) === '1'
            if (!dismissed) {
              setPreferredNamePromptDraft('')
              setShowPreferredNamePrompt(true)
            }
          } catch {
            setShowPreferredNamePrompt(true)
          }
        } else {
          setShowPreferredNamePrompt(false)
        }
        if (parseCreditBalance(data.creditBalance) !== null) {
          const accountCredits = parseCreditBalance(data.creditBalance) as number
          setCredits(accountCredits)
          window.localStorage.setItem(creditStorageKey, String(accountCredits))
        }
      } catch {
        // Keep the saved phone session if the account lookup cannot be reached.
      }
    }

    void restoreAccount()
  }, [])

  useEffect(() => {
    if (isRecipientView) {
      return
    }

    const timer = window.setTimeout(() => {
      writeFormDraft({
        version: formDraftVersion,
        savedAt: Date.now(),
        details,
        referencePhotos,
        deliveryMethod,
        deliveryDestinations,
        showSenderCopyField,
        senderCopyEmail,
        smsConsentConfirmed,
        printOrderStep,
        printShipTo,
        printMailFrom,
        printShopperEmail,
        cardId: sharedCard?.id,
        shareUrl: sharedCard?.shareUrl,
        card: slimCheckoutResumeCard(card),
        cardGreeting,
        cardSignature,
        step: hasViewedInside ? 'inside' : hasViewedFront ? 'front' : step,
        hasViewedFront: hasViewedFront || Boolean(card),
        hasViewedInside: hasViewedInside || Boolean(card),
        hasSentCurrentCard,
      })
    }, 300)

    return () => window.clearTimeout(timer)
  }, [
    isRecipientView,
    details,
    referencePhotos,
    deliveryMethod,
    deliveryDestinations,
    showSenderCopyField,
    senderCopyEmail,
    smsConsentConfirmed,
    printOrderStep,
    printShipTo,
    printMailFrom,
    printShopperEmail,
    sharedCard?.id,
    sharedCard?.shareUrl,
    card,
    cardGreeting,
    cardSignature,
    step,
    hasViewedFront,
    hasViewedInside,
    hasSentCurrentCard,
  ])

  useEffect(() => {
    if (isRecipientView) {
      return
    }

    const timer = window.setTimeout(() => {
      writeInterviewSession({
        showCardInterview,
        interviewMode,
        interviewMessages,
        interviewDraft,
        interviewVoiceLoop,
        interviewComplete,
      })
    }, 200)

    return () => window.clearTimeout(timer)
  }, [
    isRecipientView,
    showCardInterview,
    interviewMode,
    interviewMessages,
    interviewDraft,
    interviewVoiceLoop,
    interviewComplete,
  ])

  useEffect(() => {
    if (isRecipientView) {
      return
    }

    const flushInterviewSession = () => {
      if (!showCardInterviewRef.current) {
        clearInterviewSession()
        return
      }
      writeInterviewSession({
        showCardInterview: true,
        interviewMode,
        interviewMessages,
        interviewDraft: interviewLatestDraftRef.current || interviewDraft,
        interviewVoiceLoop: interviewVoiceLoopRef.current,
        interviewComplete,
      })
    }

    const resumeListeningIfNeeded = () => {
      if (document.visibilityState !== 'visible') {
        return
      }
      if (!showCardInterviewRef.current || !interviewVoiceLoopRef.current) {
        return
      }
      if (isInterviewingRef.current || interviewSpeakingRef.current || !interviewMicSupported) {
        return
      }
      const savedDraft = (interviewLatestDraftRef.current || interviewBaseDraftRef.current || '').trim()
      setInterviewNotice(
        savedDraft
          ? 'Welcome back — your notes are still here. Listening again…'
          : 'Welcome back — listening again. Pause when you’re finished.',
      )
      interviewListenDesiredRef.current = true
      startInterviewListening({ announce: false })
    }

    const resumeAfterLock = () => {
      if (document.visibilityState !== 'visible') {
        flushInterviewSession()
        return
      }
      resumeListeningIfNeeded()
    }

    /**
     * Chrome’s “Microphone access allowed” toast steals focus, kills SpeechRecognition,
     * then leaves Listening UI on with a dead session. After the toast dismisses, focus
     * returns — quietly revive once (no getUserMedia, no notice spam).
     */
    const recoverAfterMicToast = () => {
      if (document.visibilityState !== 'visible') {
        return
      }
      if (!showCardInterviewRef.current || !interviewListenDesiredRef.current) {
        return
      }
      if (isInterviewingRef.current || interviewSpeakingRef.current || !interviewMicSupported) {
        return
      }
      // Stream mic path keeps one MediaStream — just resume chunking, never restart getUserMedia.
      if (preferStreamInterviewListen()) {
        if (interviewMicStreamIsLive()) {
          resumeInterviewStreamListening({ announce: false })
        }
        return
      }
      const quietForMs = Date.now() - interviewLastSpeechResultAtRef.current
      // Still getting transcripts — don’t touch a healthy session.
      if (quietForMs < 2000) {
        return
      }
      // Session started moments ago — give it time before declaring zombie.
      if (Date.now() - interviewListenStartAtRef.current < 2500) {
        return
      }
      if (Date.now() - interviewListenRecoverAtRef.current < 9000) {
        return
      }
      interviewListenRecoverAtRef.current = Date.now()
      startInterviewListening({ announce: false })
    }

    document.addEventListener('visibilitychange', resumeAfterLock)
    window.addEventListener('focus', recoverAfterMicToast)
    window.addEventListener('pagehide', flushInterviewSession)

    return () => {
      document.removeEventListener('visibilitychange', resumeAfterLock)
      window.removeEventListener('focus', recoverAfterMicToast)
      window.removeEventListener('pagehide', flushInterviewSession)
    }
  }, [
    isRecipientView,
    interviewMode,
    interviewMessages,
    interviewDraft,
    interviewComplete,
    interviewSpeechSupported,
    interviewMicSupported,
  ])

  useEffect(() => {
    if (isRecipientView) {
      return
    }

    const session = readInterviewSession()
    if (!session) {
      return
    }

    showCardInterviewRef.current = true
    setShowCardInterview(true)
    setInterviewMode(session.interviewMode)
    setInterviewMessages(session.interviewMessages)
    setInterviewDraft(session.interviewDraft)
    interviewBaseDraftRef.current = session.interviewDraft
    interviewLatestDraftRef.current = session.interviewDraft
    interviewVoiceLoopRef.current = session.interviewVoiceLoop
    setInterviewVoiceLoop(session.interviewVoiceLoop)
    setInterviewComplete(session.interviewComplete)
    setInterviewNotice(
      session.interviewDraft.trim() || session.interviewMessages.some((entry) => entry.role === 'user')
        ? 'Welcome back — your notes are still here. Tap Talk to continue.'
        : 'Welcome back — tap Talk when you’re ready.',
    )
  }, [isRecipientView])

  useEffect(() => {
    if (isRecipientView || card || draftCardRestoreAttemptedRef.current) {
      return
    }

    draftCardRestoreAttemptedRef.current = true

    const params = new URLSearchParams(window.location.search)
    if (params.get('resume') || readCheckoutResume()) {
      return
    }

    // Read live storage — not the mount snapshot — so "Start a new card" can clear it.
    const draft = readFormDraft()
    const draftCardId =
      (isCheckoutResumeCardId(draft?.cardId) && draft?.cardId?.trim()) || ''
    if (!draftCardId && !draft?.card?.message) {
      return
    }

    let cancelled = false

    const restoreDraftCard = async () => {
      let restoredCard: GeneratedCard | null =
        draft?.card?.imageUrl && !draft.card.imageUrl.startsWith('data:') ? draft.card : null
      let restoredShared: SharedCard | null = null

      if (draftCardId) {
        try {
          const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(draftCardId)}`))
          const data = await getApiJson(response, 'Unable to restore your card.')
          if (response.ok && data?.card?.imageUrl) {
            const shared = data as SharedCard
            restoredShared = isLocalApiDev
              ? { ...shared, shareUrl: localShareUrl(shared.id) }
              : shared
            const copy = normalizeCardCopy(
              shared.card.message,
              shared.card.closing,
              shared.details.senderName || draft?.details.senderName || 'Your Name',
            )
            restoredCard = {
              ...shared.card,
              message: copy.message,
              closing: copy.closing,
              messageVariants: draft?.card?.messageVariants,
              selectedLength: draft?.card?.selectedLength,
            }
            if (shared.greeting) {
              setCardGreeting(shared.greeting)
            }
            if (shared.signature) {
              setCardSignature(shared.signature)
            }
          }
        } catch {
          // Keep any slim draft card below.
        }
      }

      if (cancelled || !restoredCard?.imageUrl) {
        return
      }

      setCard(restoredCard)
      if (restoredShared) {
        setSharedCard(restoredShared)
      } else if (draftCardId) {
        setSharedCard({
          id: draftCardId,
          shareUrl: draft?.shareUrl || localShareUrl(draftCardId),
          details: draft?.details || initialDetails,
          card: restoredCard,
          greeting: draft?.cardGreeting || undefined,
          signature: draft?.cardSignature || undefined,
        })
      }

      if (typeof draft?.cardGreeting === 'string') {
        setCardGreeting(draft.cardGreeting)
      }
      if (typeof draft?.cardSignature === 'string') {
        setCardSignature(draft.cardSignature)
      }
      setHasViewedFront(Boolean(draft?.hasViewedFront))
      setHasViewedInside(Boolean(draft?.hasViewedInside))
      setHasSentCurrentCard(Boolean(draft?.hasSentCurrentCard))
      setStep(
        draft?.hasViewedInside || draft?.step === 'inside'
          ? 'inside'
          : draft?.hasViewedFront || draft?.step === 'front'
            ? 'front'
            : 'envelope',
      )
    }

    void restoreDraftCard()
    return () => {
      cancelled = true
    }
  }, [isRecipientView, card])

  useEffect(() => {
    if (isRecipientView) {
      return
    }

    const params = new URLSearchParams(window.location.search)
    const urlResumeCardId = params.get('resume')
    const storedResume = readCheckoutResume()
    const resumeCardId =
      (isCheckoutResumeCardId(urlResumeCardId) && urlResumeCardId.trim()) ||
      (isCheckoutResumeCardId(storedResume?.cardId) && storedResume?.cardId) ||
      ''

    const resume: CheckoutResumeState | null = storedResume
      ? {
          ...storedResume,
          cardId: resumeCardId || storedResume.cardId,
        }
      : resumeCardId
        ? {
            version: 1,
            savedAt: Date.now(),
            cardId: resumeCardId,
            details: initialDetails,
            step: 'inside',
            hasViewedFront: true,
            hasViewedInside: true,
            hasSentCurrentCard: false,
            deliveryMethod: 'email',
            deliveryDestinations: [''],
            showSenderCopyField: false,
            senderCopyEmail: '',
            smsConsentConfirmed: false,
          }
        : null

    if (!resume || (!resume.cardId && !resume.card?.message)) {
      return
    }

    let cancelled = false

    const restoreAfterCheckout = async () => {
      const hasStoredDetails = Boolean(
        storedResume &&
          (storedResume.details.recipientName ||
            storedResume.details.senderName ||
            storedResume.details.occasion ||
            storedResume.details.keyDetails),
      )
      if (hasStoredDetails && storedResume) {
        setDetails(storedResume.details)
        setCardGreeting(storedResume.greeting ?? null)
        setCardSignature(storedResume.signature ?? null)
        setHasSentCurrentCard(Boolean(storedResume.hasSentCurrentCard))
        setDeliveryMethod(storedResume.deliveryMethod === 'text' ? 'text' : 'email')
        setDeliveryDestinations(
          Array.isArray(storedResume.deliveryDestinations) && storedResume.deliveryDestinations.length > 0
            ? storedResume.deliveryDestinations
            : [''],
        )
        setShowSenderCopyField(Boolean(storedResume.showSenderCopyField))
        setSenderCopyEmail(storedResume.senderCopyEmail || '')
        setSmsConsentConfirmed(Boolean(storedResume.smsConsentConfirmed))
      }
      if (storedResume) {
        if (isPrintOrderStep(storedResume.printOrderStep)) {
          setPrintOrderStep(storedResume.printOrderStep)
        }
        if (storedResume.printShipTo) {
          setPrintShipTo(normalizeResumeMailingAddress(storedResume.printShipTo, emptyMailingAddress()))
        }
        if (storedResume.printMailFrom) {
          setPrintMailFrom(
            normalizeResumeMailingAddress(storedResume.printMailFrom, { ...defaultPrintMailFrom }),
          )
        }
        if (typeof storedResume.printShopperEmail === 'string') {
          setPrintShopperEmail(storedResume.printShopperEmail)
        }
        if (storedResume.printOrderStep && storedResume.printOrderStep !== 'closed') {
          setPrintOrderNotice('')
        }
      }
      setHasViewedFront(true)
      setHasViewedInside(true)
      setShowEditor(false)
      setShowAccountPage(false)

      let restoredCard: GeneratedCard | null =
        resume.card?.imageUrl && !resume.card.imageUrl.startsWith('data:') ? resume.card : null
      let restoredShared: SharedCard | null = null

      if (resume.cardId) {
        try {
          const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(resume.cardId)}`))
          const data = await getApiJson(response, 'Unable to restore your card.')
          if (response.ok && data?.card?.imageUrl) {
            const shared = data as SharedCard
            restoredShared = isLocalApiDev
              ? { ...shared, shareUrl: localShareUrl(shared.id) }
              : shared
            const copy = normalizeCardCopy(
              shared.card.message,
              shared.card.closing,
              shared.details.senderName || resume.details.senderName || 'Your Name',
            )
            restoredCard = {
              ...shared.card,
              message: copy.message,
              closing: copy.closing,
              messageVariants: resume.card?.messageVariants,
              selectedLength: resume.card?.selectedLength,
            }
            if (!hasStoredDetails) {
              setDetails((current) => ({
                ...current,
                recipientName: shared.details.recipientName || current.recipientName,
                recipientType: shared.details.recipientType || current.recipientType,
                senderName: shared.details.senderName || current.senderName,
                occasion: shared.details.occasion || current.occasion,
              }))
            }
            if (shared.greeting) {
              setCardGreeting(shared.greeting)
            }
            if (shared.signature) {
              setCardSignature(shared.signature)
            }
          }
        } catch {
          // Fall back to the snapshot card below.
        }
      }

      if (cancelled) {
        return
      }

      if (!restoredCard?.imageUrl) {
        if (hasStoredDetails) {
          clearCheckoutResume()
          clearCheckoutResumeQueryParam()
          setDeliveryNotice(
            'Welcome back — your recipients were restored, but we could not reload the card cover. Open the card link from your account or generate again.',
          )
        }
        return
      }

      setCard(restoredCard)
      if (restoredShared) {
        setSharedCard(restoredShared)
      } else if (resume.cardId) {
        setSharedCard({
          id: resume.cardId,
          shareUrl: resume.shareUrl || localShareUrl(resume.cardId),
          details: resume.details,
          card: restoredCard,
          greeting: resume.greeting || undefined,
          signature: resume.signature || undefined,
        })
      }

      setStep(resume.hasViewedInside || resume.step === 'inside' ? 'inside' : 'front')
      clearCheckoutResume()
      clearCheckoutResumeQueryParam()
      const restoredPrintStep =
        storedResume && isPrintOrderStep(storedResume.printOrderStep) ? storedResume.printOrderStep : 'closed'
      const restoredPrintOrder = restoredPrintStep !== 'closed'
      setDeliveryNotice(
        restoredPrintOrder
          ? 'Welcome back — your credits are updated and your print order details are ready.'
          : 'Welcome back — your card and recipients are ready to send.',
      )
      window.setTimeout(() => {
        document
          .querySelector(restoredPrintOrder ? '.print-order-panel' : '.delivery-panel')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 250)
    }

    void restoreAfterCheckout()

    return () => {
      cancelled = true
    }
  }, [isRecipientView])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const billing = params.get('billing')
    if (!billing) {
      return
    }

    const clearBillingParam = () => {
      params.delete('billing')
      const nextQuery = params.toString()
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`
      window.history.replaceState({}, '', nextUrl)
    }

    if (billing === 'cancel') {
      setCreditNotice('Checkout canceled. No payment was taken.')
      setShowCreditMenu(false)
      clearBillingParam()
      return
    }

    if (billing !== 'success') {
      clearBillingParam()
      return
    }

    setCreditNotice('Payment received. Updating your credits…')
    setShowCreditMenu(false)
    clearBillingParam()

    const refreshAfterPurchase = async () => {
      const raw = window.localStorage.getItem(accountSessionStorageKey)
      let token = ''
      try {
        token = raw ? String(JSON.parse(raw)?.token || '') : ''
      } catch {
        token = ''
      }
      if (!token) {
        setCreditNotice('Payment received. Confirm your mobile number to see your updated credits.')
        return
      }

      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const response = await fetch(apiUrl('/api/account'), {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (response.ok) {
            const data = await getApiJson(response, 'Unable to refresh credits.')
            const accountCredits = parseCreditBalance(data.creditBalance)
            if (accountCredits !== null) {
              setCredits(accountCredits)
              window.localStorage.setItem(creditStorageKey, String(accountCredits))
              setCreditNotice('Thanks! Your credits are updated.')
              return
            }
          }
        } catch {
          // Retry while the webhook may still be settling.
        }
        await sleep(1200)
      }

      setCreditNotice('Payment received. Refresh the page if your credits are not updated yet.')
    }

    void refreshAfterPurchase()
  }, [])

  useEffect(() => {
    if (step === 'front') {
      setHasViewedFront(true)
    }

    if (step === 'inside') {
      setHasViewedInside(true)
    }
  }, [step])

  useEffect(() => {
    if (!keepScreenAwake) {
      void releaseScreenStayAwake()
      return
    }

    let cancelled = false

    const run = async () => {
      if (cancelled) {
        return
      }
      await acquireScreenStayAwake()
    }

    void run()

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && keepScreenAwakeRef.current) {
        void acquireScreenStayAwake()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      void releaseScreenStayAwake()
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

    const prefill = getThankYouCardPrefill()
    if (!prefill) {
      return
    }

    setDetails((current) => ({
      ...current,
      senderName: prefill.senderName || current.senderName,
      recipientName: prefill.recipientName || current.recipientName,
      occasion: prefill.occasion || current.occasion,
      recipientType: current.recipientType || 'friend',
    }))
    setCreditNotice('Starting a thank-you card for you.')
  }, [isRecipientView])

  useEffect(() => {
    if (!isRecipientView || !sharedCardId || !card) {
      return
    }

    if (!(step === 'front' || step === 'inside')) {
      return
    }

    const loadThankYouStatus = async () => {
      try {
        const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(sharedCardId)}/thank-you`))
        const data = await getApiJson(response, 'Unable to check thank-you options.')
        if (!response.ok) {
          setThankYouAvailable(false)
          return
        }

        setThankYouAvailable(Boolean(data.available))
        setThankYouAlreadySent(Boolean(data.alreadySent))
        if (Array.isArray(data.presets) && data.presets.length > 0) {
          setThankYouPresetsState(
            data.presets.map((preset: { id: string; label: string; allowsCustom?: boolean }) => ({
              id: preset.id,
              label: preset.label,
              allowsCustom: Boolean(preset.allowsCustom),
            })),
          )
          setSelectedThankYouPreset(data.presets[0].id)
        }
        if (data.alreadySent) {
          setThankYouNotice('Your thank-you was already sent to the sender.')
        }
      } catch {
        setThankYouAvailable(false)
      }
    }

    void loadThankYouStatus()
  }, [card, isRecipientView, sharedCardId, step])

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
      setError('A previous card took too long to finish. Please try again. Your credits are still in your account.')
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
    setError('')
    setDetails((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const applyInterviewDetails = (next: Partial<CardDetails>) => {
    setDetails((current) => ({
      ...current,
      senderName: next.senderName?.trim() || current.senderName,
      recipientName: next.recipientName?.trim() || current.recipientName,
      recipientType: next.recipientType?.trim() || current.recipientType,
      occasion: next.occasion?.trim() || current.occasion,
      tone:
        next.tone && toneOptions.includes(next.tone)
          ? next.tone
          : current.tone,
      imageStyle:
        next.imageStyle && styleOptions.includes(next.imageStyle)
          ? next.imageStyle
          : current.imageStyle,
      keyDetails: next.keyDetails?.trim() || current.keyDetails,
    }))
    setHighlightInvalidFields(false)
    setError('')
  }

  const scrollInterviewThreadToBottom = () => {
    const thread = interviewThreadRef.current
    if (!thread) {
      return
    }
    thread.scrollTop = thread.scrollHeight
  }

  const stopInterviewStreamLoop = () => {
    interviewStreamDesiredRef.current = false
    interviewStreamPausedRef.current = false
    interviewStreamLoopIdRef.current += 1
    if (interviewStreamChunkTimerRef.current) {
      window.clearInterval(interviewStreamChunkTimerRef.current)
      interviewStreamChunkTimerRef.current = 0
    }
    const recorder = interviewMediaRecorderRef.current
    interviewMediaRecorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.ondataavailable = null
        recorder.onerror = null
        recorder.onstop = null
        recorder.stop()
      } catch {
        // Ignore.
      }
    }
  }

  const appendStreamTranscript = (chunkText: string) => {
    const cleaned = chunkText.replace(/\s+/g, ' ').trim()
    if (!cleaned || isJunkInterviewTranscript(cleaned)) {
      return
    }
    interviewLastSpeechResultAtRef.current = Date.now()
    const merged = `${interviewBaseDraftRef.current} ${cleaned}`.replace(/\s+/g, ' ').trim()
    interviewBaseDraftRef.current = merged
    interviewLatestDraftRef.current = merged
    setInterviewDraft(merged)
    scheduleVoiceAutoSend(interviewVoicePauseMs)
  }

  const handleInterviewStreamChunk = (blob: Blob) => {
    if (!blob || blob.size < 400) {
      return
    }
    if (
      !interviewStreamDesiredRef.current ||
      interviewStreamPausedRef.current ||
      isInterviewingRef.current ||
      interviewSpeakingRef.current ||
      Date.now() < interviewMicIgnoreUntilRef.current
    ) {
      return
    }
    if (interviewStreamTranscribingRef.current) {
      return
    }
    interviewStreamTranscribingRef.current = true
    interviewLastSpeechResultAtRef.current = Date.now()
    void (async () => {
      try {
        const prompt = (interviewLatestDraftRef.current || interviewBaseDraftRef.current || '')
          .trim()
          .slice(-180)
        const text = await transcribeInterviewAudioChunk(blob, prompt)
        if (
          !interviewStreamDesiredRef.current ||
          interviewStreamPausedRef.current ||
          isInterviewingRef.current ||
          interviewSpeakingRef.current
        ) {
          return
        }
        appendStreamTranscript(text)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to transcribe that audio.'
        if (showCardInterviewRef.current && interviewStreamDesiredRef.current) {
          setInterviewNotice(`${message} Keep talking — or type your reply.`)
        }
      } finally {
        interviewStreamTranscribingRef.current = false
      }
    })()
  }

  /** One MediaRecorder for the whole Chrome chat — start once, never restart mid-session. */
  const ensureInterviewMediaRecorder = () => {
    if (interviewMediaRecorderRef.current) {
      return interviewMediaRecorderRef.current
    }
    if (!interviewMicStreamIsLive() || !interviewMicStream) {
      return null
    }
    const mimeType = pickInterviewRecorderMimeType()
    let recorder: MediaRecorder
    try {
      recorder = mimeType
        ? new MediaRecorder(interviewMicStream, { mimeType })
        : new MediaRecorder(interviewMicStream)
    } catch {
      return null
    }
    recorder.ondataavailable = (event) => {
      const raw = event.data
      if (!raw) {
        return
      }
      const blob =
        raw.type || !mimeType
          ? raw
          : new Blob([raw], { type: mimeType })
      handleInterviewStreamChunk(blob)
    }
    recorder.onerror = () => {
      if (showCardInterviewRef.current) {
        setInterviewNotice('Mic capture hit a snag — tap Talk to continue, or type your reply.')
      }
    }
    interviewMediaRecorderRef.current = recorder
    return recorder
  }

  const armInterviewStreamDataPump = () => {
    if (interviewStreamChunkTimerRef.current) {
      window.clearInterval(interviewStreamChunkTimerRef.current)
      interviewStreamChunkTimerRef.current = 0
    }
    // iOS often ignores start(timeslice). requestData() (or stop/start on the same stream)
    // keeps chunks flowing without a new getUserMedia.
    interviewStreamChunkTimerRef.current = window.setInterval(() => {
      const recorder = interviewMediaRecorderRef.current
      if (!recorder || !interviewStreamDesiredRef.current || interviewStreamPausedRef.current) {
        return
      }
      if (recorder.state !== 'recording') {
        return
      }
      try {
        if (typeof recorder.requestData === 'function') {
          recorder.requestData()
          return
        }
      } catch {
        // Fall through to stop/start on the same stream.
      }
      try {
        recorder.stop()
      } catch {
        return
      }
      window.setTimeout(() => {
        const current = interviewMediaRecorderRef.current
        if (
          !current ||
          current !== recorder ||
          !interviewStreamDesiredRef.current ||
          interviewStreamPausedRef.current ||
          current.state !== 'inactive'
        ) {
          return
        }
        try {
          current.start()
        } catch {
          // Ignore — Talk can revive.
        }
      }, 60)
    }, 2200)
  }

  const pauseInterviewStreamListening = () => {
    interviewStreamPausedRef.current = true
    interviewMicIgnoreUntilRef.current = Number.POSITIVE_INFINITY
    // Keep the recorder running — only ignore chunks — so we never restart mid-chat.
    setIsInterviewListening(false)
  }

  const resumeInterviewStreamListening = (options?: { announce?: boolean }) => {
    if (!preferStreamInterviewListen()) {
      return
    }
    if (!interviewMicStreamIsLive()) {
      void startStreamInterviewListening(options)
      return
    }
    interviewListenDesiredRef.current = true
    interviewStreamDesiredRef.current = true
    interviewStreamPausedRef.current = false
    interviewMicIgnoreUntilRef.current = Date.now() + 600
    const recorder = ensureInterviewMediaRecorder()
    if (!recorder) {
      setInterviewNotice('Voice capture isn’t available in this browser — type your reply instead.')
      return
    }
    try {
      if (recorder.state === 'inactive') {
        recorder.start()
        armInterviewStreamDataPump()
      } else if (recorder.state === 'paused') {
        recorder.resume()
        armInterviewStreamDataPump()
      }
    } catch {
      setInterviewNotice('Couldn’t start the microphone — tap Talk to try again, or type your reply.')
      return
    }
    interviewListenActiveRef.current = true
    setIsInterviewListening(true)
    if (options?.announce !== false) {
      setInterviewNotice(
        interviewVoiceLoopRef.current
          ? 'Listening… just pause when you’re finished.'
          : 'Listening… tell Genie about the card, then tap I’m done.',
      )
    }
  }

  const startStreamInterviewListening = async (options?: { announce?: boolean }) => {
    if (isInterviewingRef.current) {
      return
    }

    // Already recording on the long session — just un-ignore chunks.
    if (
      interviewMediaRecorderRef.current &&
      interviewMediaRecorderRef.current.state !== 'inactive' &&
      interviewMicStreamIsLive()
    ) {
      resumeInterviewStreamListening(options)
      return
    }

    const recognition = interviewRecognitionRef.current
    interviewRecognitionRef.current = null
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        // Ignore.
      }
    }

    const access = await ensureMicrophoneAccess({ holdStream: true })
    if (access !== 'granted' || !interviewMicStreamIsLive()) {
      setInterviewNotice(
        'Microphone permission is needed to talk to Genie. You can still type your reply.',
      )
      return
    }
    if (!showCardInterviewRef.current) {
      return
    }

    interviewListenDesiredRef.current = true
    interviewStreamDesiredRef.current = true
    interviewStreamPausedRef.current = false
    interviewMicIgnoreUntilRef.current = Date.now()
    interviewBaseDraftRef.current = (
      interviewLatestDraftRef.current ||
      interviewBaseDraftRef.current ||
      interviewDraft
    ).trim()
    interviewLastSpeechResultAtRef.current = Date.now()

    const recorder = ensureInterviewMediaRecorder()
    if (!recorder) {
      setInterviewNotice('Voice capture isn’t available in this browser — type your reply instead.')
      return
    }

    try {
      if (recorder.state === 'inactive') {
        recorder.start()
        armInterviewStreamDataPump()
      } else if (recorder.state === 'paused') {
        recorder.resume()
        armInterviewStreamDataPump()
      }
    } catch {
      setInterviewNotice('Couldn’t start the microphone — tap Talk to try again, or type your reply.')
      return
    }

    interviewListenActiveRef.current = true
    setIsInterviewListening(true)
    if (options?.announce !== false) {
      setInterviewNotice(
        interviewVoiceLoopRef.current
          ? 'Listening… just pause when you’re finished.'
          : 'Listening… tell Genie about the card, then tap I’m done.',
      )
    }
  }

  const stopInterviewListening = () => {
    interviewListenDesiredRef.current = false
    interviewListenActiveRef.current = false
    stopInterviewStreamLoop()
    if (interviewAutoSendTimerRef.current) {
      window.clearTimeout(interviewAutoSendTimerRef.current)
      interviewAutoSendTimerRef.current = 0
    }
    if (interviewInterimFinalizeTimerRef.current) {
      window.clearTimeout(interviewInterimFinalizeTimerRef.current)
      interviewInterimFinalizeTimerRef.current = 0
    }
    if (interviewListenWatchdogRef.current) {
      window.clearTimeout(interviewListenWatchdogRef.current)
      interviewListenWatchdogRef.current = 0
    }
    const recognition = interviewRecognitionRef.current
    interviewRecognitionRef.current = null
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.stop()
      } catch {
        try {
          recognition.abort()
        } catch {
          // Ignore browsers that throw when recognition is already stopped.
        }
      }
    }
    setIsInterviewListening(false)
  }

  const pauseInterviewListeningForFinalWords = async () => {
    interviewListenDesiredRef.current = false
    const recognition = interviewRecognitionRef.current
    if (!recognition) {
      setIsInterviewListening(false)
      return
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        interviewRecognitionRef.current = null
        setIsInterviewListening(false)
        resolve()
      }

      const previousOnResult = recognition.onresult
      recognition.onresult = (event) => {
        previousOnResult?.(event)
      }
      recognition.onerror = () => {
        finish()
      }
      recognition.onend = () => {
        finish()
      }

      try {
        recognition.stop()
      } catch {
        finish()
        return
      }

      window.setTimeout(() => {
        if (interviewRecognitionRef.current === recognition) {
          try {
            recognition.abort()
          } catch {
            // Already stopped.
          }
          finish()
        }
      }, 700)
    })
  }

  const clearInterviewAutoSend = () => {
    if (interviewAutoSendTimerRef.current) {
      window.clearTimeout(interviewAutoSendTimerRef.current)
      interviewAutoSendTimerRef.current = 0
    }
    if (interviewInterimFinalizeTimerRef.current) {
      window.clearTimeout(interviewInterimFinalizeTimerRef.current)
      interviewInterimFinalizeTimerRef.current = 0
    }
  }

  const scheduleVoiceAutoSend = (delayMs = interviewVoicePauseMs) => {
    if (!interviewVoiceLoopRef.current || isInterviewingRef.current || interviewSpeakingRef.current) {
      return
    }
    if (interviewAutoSendTimerRef.current) {
      window.clearTimeout(interviewAutoSendTimerRef.current)
      interviewAutoSendTimerRef.current = 0
    }
    interviewAutoSendTimerRef.current = window.setTimeout(() => {
      interviewAutoSendTimerRef.current = 0
      if (!interviewVoiceLoopRef.current || isInterviewingRef.current || interviewSpeakingRef.current) {
        return
      }
      const text = (interviewLatestDraftRef.current || interviewBaseDraftRef.current).trim()
      if (text.length < 2) {
        return
      }
      void sendCardInterviewRef.current()
    }, delayMs)
  }

  const armInterviewListenWatchdog = () => {
    if (interviewListenWatchdogRef.current) {
      window.clearTimeout(interviewListenWatchdogRef.current)
    }
    // Soft safety net only. Mobile recognition ends often (continuous:false); onend restarts it.
    // Aggressive reconnects were flashing “Mic paused” and killing live sessions.
    interviewListenWatchdogRef.current = window.setTimeout(() => {
      interviewListenWatchdogRef.current = 0
      if (
        !interviewListenDesiredRef.current ||
        isInterviewingRef.current ||
        interviewSpeakingRef.current ||
        !showCardInterviewRef.current
      ) {
        return
      }
      // Recognition object gone / inactive but we still want to listen — quiet revive.
      if (!interviewRecognitionRef.current || !interviewListenActiveRef.current) {
        startInterviewListening({ announce: false })
        return
      }
      const quietForMs = Date.now() - interviewLastSpeechResultAtRef.current
      if (quietForMs < 22000) {
        armInterviewListenWatchdog()
        return
      }
      interviewListenRestartCountRef.current += 1
      if (interviewListenRestartCountRef.current <= 1) {
        startInterviewListening({ announce: false })
        return
      }
      // Keep the Listening UI; don’t nag. User can tap Talk if needed.
      armInterviewListenWatchdog()
    }, 12000)
  }

  const startInterviewListening = (options?: { announce?: boolean }) => {
    if (preferStreamInterviewListen()) {
      void startStreamInterviewListening(options)
      return
    }

    if (!interviewSpeechSupported || isInterviewingRef.current) {
      return
    }

    // Prevent rapid stop/start loops (each recognition.start() can flash Chrome’s mic toast).
    if (
      Date.now() - interviewListenStartAtRef.current < 1200 &&
      interviewRecognitionRef.current &&
      interviewListenActiveRef.current
    ) {
      return
    }

    stopInterviewListening()
    const recognition = getInterviewSpeechRecognition()
    if (!recognition) {
      setInterviewNotice('Voice isn’t available in this browser — type your reply instead.')
      return
    }

    const continuousListen = preferContinuousInterviewListen()
    interviewListenDesiredRef.current = true
    interviewListenActiveRef.current = false
    interviewListenStartAtRef.current = Date.now()
    interviewBaseDraftRef.current = (
      interviewLatestDraftRef.current ||
      interviewBaseDraftRef.current ||
      interviewDraft
    ).trim()
    interviewLastSpeechResultAtRef.current = Date.now()
    // Chrome iOS: continuous true = one mic-toast per listen turn, not after every pause.
    // Mobile Safari: continuous false + onend restart is still more reliable.
    recognition.continuous = continuousListen
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      interviewLastSpeechResultAtRef.current = Date.now()
      interviewListenRestartCountRef.current = 0
      armInterviewListenWatchdog()

      // Keep the Chrome mic session alive across Genie turns — ignore echo / self-speech.
      if (
        isInterviewingRef.current ||
        interviewSpeakingRef.current ||
        Date.now() < interviewMicIgnoreUntilRef.current
      ) {
        return
      }

      let finalChunk = ''
      let interimChunk = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = String(result?.[0]?.transcript || '')
        if (result.isFinal) {
          finalChunk += transcript
        } else {
          interimChunk += transcript
        }
      }

      if (finalChunk) {
        if (interviewInterimFinalizeTimerRef.current) {
          window.clearTimeout(interviewInterimFinalizeTimerRef.current)
          interviewInterimFinalizeTimerRef.current = 0
        }
        const merged = `${interviewBaseDraftRef.current} ${finalChunk}`.replace(/\s+/g, ' ').trim()
        interviewBaseDraftRef.current = merged
        interviewLatestDraftRef.current = merged
        setInterviewDraft(merged)
        scheduleVoiceAutoSend(interviewVoicePauseMs)
      } else if (interimChunk) {
        const merged = `${interviewBaseDraftRef.current} ${interimChunk}`.replace(/\s+/g, ' ').trim()
        interviewLatestDraftRef.current = merged
        setInterviewDraft(merged)
        if (interviewAutoSendTimerRef.current) {
          window.clearTimeout(interviewAutoSendTimerRef.current)
          interviewAutoSendTimerRef.current = 0
        }
        if (interviewInterimFinalizeTimerRef.current) {
          window.clearTimeout(interviewInterimFinalizeTimerRef.current)
        }
        interviewInterimFinalizeTimerRef.current = window.setTimeout(() => {
          interviewInterimFinalizeTimerRef.current = 0
          if (!interviewVoiceLoopRef.current || isInterviewingRef.current || interviewSpeakingRef.current) {
            return
          }
          if (Date.now() < interviewMicIgnoreUntilRef.current) {
            return
          }
          const text = (interviewLatestDraftRef.current || '').trim()
          if (text.length < 2) {
            return
          }
          interviewBaseDraftRef.current = text
          scheduleVoiceAutoSend(900)
        }, interviewInterimFinalizeMs)
      }
    }
    recognition.onerror = (event) => {
      const code = String(event?.error || '')
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        interviewListenDesiredRef.current = false
        interviewVoiceLoopRef.current = false
        setInterviewVoiceLoop(false)
        setIsInterviewListening(false)
        setInterviewNotice('Microphone permission is needed to talk to Genie. You can still type your reply.')
        return
      }
      if (code === 'aborted' || code === 'no-speech' || code === 'interrupted') {
        return
      }
      if (isInterviewingRef.current || interviewSpeakingRef.current) {
        return
      }
      if (code === 'network' || code === 'audio-capture') {
        window.setTimeout(() => {
          if (
            interviewListenDesiredRef.current &&
            !isInterviewingRef.current &&
            !interviewSpeakingRef.current &&
            Date.now() - interviewListenStartAtRef.current > 2000
          ) {
            startInterviewListening({ announce: false })
          }
        }, 900)
        return
      }
      setInterviewNotice('Still listening… keep talking, or type your reply.')
    }
    recognition.onend = () => {
      interviewListenActiveRef.current = false
      setIsInterviewListening(false)

      // Session died while Genie was speaking / thinking — drop the dead handle so we
      // restart for real after the follow-up (otherwise UI shows Listening but hears nothing).
      if (isInterviewingRef.current || interviewSpeakingRef.current) {
        if (interviewRecognitionRef.current === recognition) {
          interviewRecognitionRef.current = null
        }
        return
      }

      if (!interviewListenDesiredRef.current) {
        if (interviewRecognitionRef.current === recognition) {
          interviewRecognitionRef.current = null
        }
        return
      }

      const pendingText = (interviewLatestDraftRef.current || interviewBaseDraftRef.current).trim()
      if (pendingText.length >= 2 && interviewVoiceLoopRef.current && !interviewAutoSendTimerRef.current) {
        scheduleVoiceAutoSend(700)
      }
      // continuous:true sessions should rarely end; when they do, wait longer so we don’t
      // immediately re-trigger Chrome’s mic toast mid-sentence.
      const restartDelay = continuousListen ? 650 : 200
      window.setTimeout(() => {
        if (
          !interviewListenDesiredRef.current ||
          isInterviewingRef.current ||
          interviewSpeakingRef.current
        ) {
          return
        }
        if (interviewRecognitionRef.current && interviewRecognitionRef.current !== recognition) {
          return
        }
        try {
          recognition.start()
          interviewListenActiveRef.current = true
          interviewListenStartAtRef.current = Date.now()
          interviewRecognitionRef.current = recognition
          setIsInterviewListening(true)
          armInterviewListenWatchdog()
        } catch {
          interviewRecognitionRef.current = null
          interviewListenActiveRef.current = false
          if (Date.now() - interviewListenStartAtRef.current > 1500) {
            startInterviewListening({ announce: false })
          }
        }
      }, restartDelay)
    }

    interviewRecognitionRef.current = recognition
    try {
      recognition.start()
      interviewListenActiveRef.current = true
      setIsInterviewListening(true)
      armInterviewListenWatchdog()
      if (options?.announce !== false) {
        setInterviewNotice(
          interviewVoiceLoopRef.current
            ? 'Listening… just pause when you’re finished.'
            : 'Listening… tell Genie about the card, then tap I’m done.',
        )
      }
    } catch {
      interviewListenDesiredRef.current = false
      interviewListenActiveRef.current = false
      interviewRecognitionRef.current = null
      setIsInterviewListening(false)
      setInterviewNotice('Couldn’t start the microphone — tap Talk to try again, or type your reply.')
    }
  }

  /**
   * Reuse a live SpeechRecognition session when it’s actually running. If Genie’s TTS killed
   * the session, start fresh so “Listening…” means the mic can hear again.
   */
  const ensureInterviewListening = (options?: { announce?: boolean }) => {
    if (preferStreamInterviewListen()) {
      // Never tear down the MediaStream/recorder — only stop ignoring chunks.
      resumeInterviewStreamListening(options)
      return
    }

    if (!interviewSpeechSupported || isInterviewingRef.current) {
      return
    }
    if (
      interviewRecognitionRef.current &&
      interviewListenDesiredRef.current &&
      interviewListenActiveRef.current
    ) {
      interviewListenDesiredRef.current = true
      setIsInterviewListening(true)
      armInterviewListenWatchdog()
      if (options?.announce !== false) {
        setInterviewNotice(
          interviewVoiceLoopRef.current
            ? 'Listening… just pause when you’re finished.'
            : 'Listening… tell Genie about the card, then tap I’m done.',
        )
      }
      return
    }
    // Dead or missing session — must call start() (may show Chrome’s mic toast once).
    interviewRecognitionRef.current = null
    interviewListenActiveRef.current = false
    startInterviewListening(options)
  }

  const runGenieVoiceTurn = async (
    text: string,
    thenListen: boolean,
    prefetchedBlob?: Blob | null,
  ) => {
    if (!interviewVoiceLoopRef.current) {
      return false
    }
    clearInterviewAutoSend()
    const useStreamMic = preferStreamInterviewListen()
    if (useStreamMic) {
      // One long MediaStream session — pause chunking only; never release/restart the mic.
      pauseInterviewStreamListening()
      interviewListenDesiredRef.current = true
      interviewStreamDesiredRef.current = true
    } else if (preferContinuousInterviewListen()) {
      interviewListenDesiredRef.current = true
      interviewMicIgnoreUntilRef.current = Number.POSITIVE_INFINITY
      setIsInterviewListening(false)
    } else {
      stopInterviewListening()
    }
    interviewSpeakingRef.current = true
    setIsInterviewSpeaking(true)
    setInterviewNotice('Genie is getting ready…')
    let played = false
    try {
      played = await speakGenieAloud(text, undefined, () => {
        if (interviewSpeakingRef.current && showCardInterviewRef.current) {
          setInterviewNotice('Genie is speaking…')
        }
      }, prefetchedBlob)
    } finally {
      interviewSpeakingRef.current = false
      setIsInterviewSpeaking(false)
      interviewMicIgnoreUntilRef.current = Date.now() + 700
    }
    if (!interviewVoiceLoopRef.current || !showCardInterviewRef.current || isInterviewingRef.current) {
      return played
    }
    if (!played) {
      setPendingHearGenieText(text)
      if (thenListen && (interviewSpeechSupported || useStreamMic)) {
        setInterviewNotice('Couldn’t play audio — tap Hear Genie, or just keep talking.')
        ensureInterviewListening({ announce: false })
      } else {
        setInterviewNotice('Couldn’t play audio — tap Hear Genie to hear that aloud.')
      }
      return false
    }
    setPendingHearGenieText(null)
    if (thenListen && (interviewSpeechSupported || useStreamMic)) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, useStreamMic ? 200 : 280)
      })
      if (!interviewVoiceLoopRef.current || !showCardInterviewRef.current || isInterviewingRef.current) {
        return true
      }
      ensureInterviewListening({ announce: true })
    } else if (useStreamMic) {
      stopInterviewListening()
      releaseInterviewMicStream()
    } else if (preferContinuousInterviewListen()) {
      stopInterviewListening()
    }
    return true
  }

  const beginLampGenieAfterMic = (
    greeting: string,
    prefetchedBlob?: Blob | null,
  ) => {
    interviewVoiceLoopRef.current = true
    setInterviewVoiceLoop(true)
    // Audio should already be unlocked from the logo tap. Retry only if gesture is still alive.
    if (hasFreshUserActivation()) {
      void unlockGenieSpeechAudio()
    }
    void acquireScreenStayAwake()
    // Always attempt playback — the unlocked player survives a delayed mic Allow.
    // Only fall back to Hear Genie if play() actually fails.
    void (async () => {
      const played = await runGenieVoiceTurn(greeting, true, prefetchedBlob)
      if (!played && showCardInterviewRef.current && interviewVoiceLoopRef.current) {
        setPendingHearGenieText(greeting)
        setInterviewNotice('Tap Hear Genie to start — then talk when you’re ready.')
        window.setTimeout(() => {
          document.querySelector('.card-interview-actions .primary-button')?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          })
        }, 80)
      }
    })()
  }

  const hearPendingGenie = () => {
    const text = pendingHearGenieText || greetingForInterviewMode(interviewMode)
    setPendingHearGenieText(null)
    interviewVoiceLoopRef.current = true
    setInterviewVoiceLoop(true)
    void unlockGenieSpeechAudio()
    void acquireScreenStayAwake()
    void runGenieVoiceTurn(text, true)
  }

  const previewLampGenieVoice = async (voice: LampGenieVoiceId) => {
    setPreviewingLampVoice(voice)
    setInterviewNotice(`Playing ${lampGenieVoiceLabel(voice)}…`)
    try {
      await speakGenieAloud(
        `Hi, I'm Genie with the ${lampGenieVoiceLabel(voice)} voice. If you like how I sound, tap Use this voice.`,
        voice,
      )
    } finally {
      setPreviewingLampVoice((current) => (current === voice ? null : current))
      setInterviewNotice(`Current voice: ${lampGenieVoiceLabel(lampGenieVoice)}.`)
    }
  }

  const chooseLampGenieVoice = (voice: LampGenieVoiceId) => {
    persistLampGenieVoice(voice)
    setLampGenieVoice(voice)
    setShowLampVoicePicker(false)
    setInterviewNotice(`Lamp Genie will use ${lampGenieVoiceLabel(voice)} from now on.`)
  }

  const openCardInterview = (mode: InterviewMode = 'quick') => {
    if (isRecipientView) {
      return
    }
    setStartingInterviewMode(mode)
    showActionFeedback(mode === 'chat' ? 'Starting Lamp Genie…' : 'Opening Ask Genie…', 2000)
    window.setTimeout(() => setStartingInterviewMode(null), 1600)
    setShowAccountPage(false)
    setAdminView(null)
    showCardInterviewRef.current = true
    setShowCardInterview(true)
    setInterviewMode(mode)
    setInterviewMessages([{ role: 'assistant', content: greetingForInterviewMode(mode) }])
    setInterviewDraft('')
    interviewBaseDraftRef.current = ''
    interviewLatestDraftRef.current = ''
    setInterviewComplete(false)
    stopGenieSpeech()
    setPendingHearGenieText(null)
    window.speechSynthesis?.getVoices()
    window.setTimeout(() => {
      document.querySelector('.card-interview-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)

    if (!interviewMicSupported) {
      interviewVoiceLoopRef.current = false
      setInterviewVoiceLoop(false)
      setIsInterviewSpeaking(false)
      setInterviewNotice('Voice isn’t available in this browser — type your reply instead.')
      return
    }

    // Unlock audio in THIS tap — before awaiting mic — so Genie can speak after a slow Allow.
    void unlockGenieSpeechAudio()
    void acquireScreenStayAwake()

    const greeting = greetingForInterviewMode(mode)
    setInterviewNotice(
      microphoneAccessKnown === 'granted' || interviewMicStreamIsLive()
        ? 'Genie is getting ready…'
        : 'Allow the microphone so Genie can hear you…',
    )
    void (async () => {
      // Prefetch greeting TTS while the mic dialog is open.
      const prefetchPromise =
        mode === 'chat' ? prefetchGenieSpeechBlob(greeting) : Promise.resolve(null)
      const useStreamMic = preferStreamInterviewListen()
      const micAccess = await ensureMicrophoneAccess({
        holdStream: useStreamMic,
      })
      if (!showCardInterviewRef.current) {
        return
      }

      if (micAccess === 'denied') {
        interviewVoiceLoopRef.current = false
        setInterviewVoiceLoop(false)
        setIsInterviewSpeaking(false)
        setIsInterviewListening(false)
        setPendingHearGenieText(null)
        setInterviewNotice(
          'Microphone permission is needed to talk to Genie. You can still type your reply.',
        )
        return
      }

      if (mode === 'chat') {
        // Start the long MediaRecorder immediately after Allow (same gesture window),
        // then ignore chunks while Genie greets — never wait until after TTS to start().
        if (useStreamMic) {
          interviewVoiceLoopRef.current = true
          setInterviewVoiceLoop(true)
          await startStreamInterviewListening({ announce: false })
          pauseInterviewStreamListening()
          interviewStreamDesiredRef.current = true
          interviewListenDesiredRef.current = true
        }
        const prefetched = await prefetchPromise
        if (!showCardInterviewRef.current) {
          return
        }
        beginLampGenieAfterMic(greeting, prefetched)
        return
      }

      interviewVoiceLoopRef.current = false
      setInterviewVoiceLoop(false)
      setIsInterviewSpeaking(false)
      setInterviewNotice('')
      startInterviewListening()
    })()
  }

  const resetCardInterview = () => {
    stopInterviewListening()
    stopGenieSpeech()
    setPendingHearGenieText(null)
    setInterviewMessages([{ role: 'assistant', content: greetingForInterviewMode(interviewMode) }])
    setInterviewDraft('')
    interviewBaseDraftRef.current = ''
    interviewLatestDraftRef.current = ''
    setInterviewComplete(false)
    isInterviewingRef.current = false
    setIsInterviewing(false)
    if (!interviewMicSupported) {
      setIsInterviewSpeaking(false)
      setInterviewNotice('Voice isn’t available in this browser — type your reply instead.')
      return
    }

    setInterviewNotice(
      microphoneAccessKnown === 'granted' || interviewMicStreamIsLive()
        ? 'Genie is getting ready…'
        : 'Allow the microphone so Genie can hear you…',
    )
    void unlockGenieSpeechAudio()
    void acquireScreenStayAwake()
    void (async () => {
      const greeting = greetingForInterviewMode(interviewMode)
      const prefetchPromise =
        interviewVoiceLoopRef.current || interviewMode === 'chat'
          ? prefetchGenieSpeechBlob(greeting)
          : Promise.resolve(null)
      const useStreamMic = preferStreamInterviewListen()
      const micAccess = await ensureMicrophoneAccess({
        holdStream: useStreamMic,
      })
      if (!showCardInterviewRef.current) {
        return
      }
      if (micAccess === 'denied') {
        interviewVoiceLoopRef.current = false
        setInterviewVoiceLoop(false)
        setIsInterviewSpeaking(false)
        setInterviewNotice(
          'Microphone permission is needed to talk to Genie. You can still type your reply.',
        )
        return
      }
      if (interviewVoiceLoopRef.current || interviewMode === 'chat') {
        if (useStreamMic) {
          interviewVoiceLoopRef.current = true
          setInterviewVoiceLoop(true)
          await startStreamInterviewListening({ announce: false })
          pauseInterviewStreamListening()
          interviewStreamDesiredRef.current = true
          interviewListenDesiredRef.current = true
        }
        const prefetched = await prefetchPromise
        if (!showCardInterviewRef.current) {
          return
        }
        beginLampGenieAfterMic(greeting, prefetched)
        return
      }
      setIsInterviewSpeaking(false)
      setInterviewNotice('')
      startInterviewListening()
    })()
  }

  const closeCardInterview = () => {
    stopInterviewListening()
    stopGenieSpeech()
    releaseInterviewMicStream()
    interviewSpeakingRef.current = false
    setIsInterviewSpeaking(false)
    interviewVoiceLoopRef.current = false
    setInterviewVoiceLoop(false)
    showCardInterviewRef.current = false
    setShowCardInterview(false)
    setPendingHearGenieText(null)
    setInterviewNotice('')
    clearInterviewSession()
  }

  const startNewCard = () => {
    if (isRecipientView) {
      return
    }

    stopInterviewListening()
    stopGenieSpeech()
    interviewSpeakingRef.current = false
    setIsInterviewSpeaking(false)
    interviewVoiceLoopRef.current = false
    setInterviewVoiceLoop(false)
    showCardInterviewRef.current = false
    setShowCardInterview(false)
    setInterviewMessages([{ role: 'assistant', content: interviewQuickGreeting }])
    setInterviewDraft('')
    interviewBaseDraftRef.current = ''
    interviewLatestDraftRef.current = ''
    setInterviewComplete(false)
    setInterviewNotice('')
    isInterviewingRef.current = false
    setIsInterviewing(false)
    setInterviewMode('quick')

    setDetails(initialDetails)
    setReferencePhotos([])
    setReferencePhotoNotice('')
    setError('')
    setHighlightInvalidFields(false)
    setShowAccountPage(false)
    setAdminView(null)

    setCard(null)
    setSharedCard(null)
    setCardGreeting(null)
    setCardSignature(null)
    setStep('envelope')
    setHasViewedFront(false)
    setHasViewedInside(false)
    setIsGenerating(false)
    setShowCompletionNote(false)
    setActiveGenerationStep(0)
    setImageRefinement('')
    setCoverRefinementMode('revise')
    setCopyRefinement('')
    setIsRefiningImage(false)
    setIsRefiningCopy(false)
    setRefinementNotice('')
    setShowEditor(false)
    setEditorHasChanges(false)
    setHasAcceptedRevision(false)
    setShowPolishDialog(false)
    setDeliveryNotice('')
    setDeliveryLogs([])
    setHasSentCurrentCard(false)
    setDeliveryMethod('email')
    setDeliveryDestinations([''])
    setShowSenderCopyField(false)
    setSenderCopyEmail('')
    setSmsConsentConfirmed(false)
    setPrintOrderStep('closed')
    setPrintShipTo(emptyMailingAddress())
    setPrintMailFrom({ ...defaultPrintMailFrom })
    setPrintShopperEmail('')
    setAdminPrintFiles(null)
    clearStoredGenerationJob()
    draftCardRestoreAttemptedRef.current = true
    clearCheckoutResume()

    try {
      window.localStorage.removeItem(formDraftStorageKey)
    } catch {
      // Ignore storage failures.
    }
    clearInterviewSession()

    window.setTimeout(() => {
      document.querySelector('.form-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  const clearCreateCardInputs = startNewCard

  const sendCardInterview = async () => {
    if (isInterviewingRef.current || interviewSpeakingRef.current) {
      return
    }
    clearInterviewAutoSend()
    isInterviewingRef.current = true

    // Chrome stream path: pause chunking on the same MediaStream (never restart the mic).
    // Safari SpeechRecognition still pauses to flush final words.
    const useStreamMic = preferStreamInterviewListen() && interviewVoiceLoopRef.current
    if (useStreamMic) {
      pauseInterviewStreamListening()
      interviewListenDesiredRef.current = true
      interviewStreamDesiredRef.current = true
      await new Promise((resolve) => {
        window.setTimeout(resolve, 280)
      })
    } else if (preferContinuousInterviewListen() && interviewVoiceLoopRef.current) {
      interviewListenDesiredRef.current = true
      interviewMicIgnoreUntilRef.current = Number.POSITIVE_INFINITY
      setIsInterviewListening(false)
      await new Promise((resolve) => {
        window.setTimeout(resolve, 320)
      })
    } else if (isInterviewListening || interviewRecognitionRef.current) {
      await pauseInterviewListeningForFinalWords()
    } else {
      stopInterviewListening()
    }

    // Re-read after mic pause so final/interim speech words are included.
    const message = (
      interviewBaseDraftRef.current ||
      interviewLatestDraftRef.current ||
      interviewDraft
    ).trim()
    if (!message) {
      isInterviewingRef.current = false
      interviewMicIgnoreUntilRef.current = Date.now()
      if (interviewVoiceLoopRef.current) {
        setInterviewNotice('Listening… just pause when you’re finished.')
        ensureInterviewListening({ announce: false })
      } else {
        setInterviewNotice('Say or type a bit about the card first, then tap I’m done.')
        ensureInterviewListening({ announce: false })
      }
      return
    }

    const nextMessages: InterviewMessage[] = [...interviewMessages, { role: 'user', content: message }]
    setInterviewMessages(nextMessages)
    setInterviewDraft('')
    interviewBaseDraftRef.current = ''
    interviewLatestDraftRef.current = ''
    setInterviewComplete(false)
    setInterviewNotice('Genie is working on that…')
    isInterviewingRef.current = true
    setIsInterviewing(true)

    try {
      const userTurns = nextMessages.filter((entry) => entry.role === 'user').length
      const response = await fetch(apiUrl('/api/card-interview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages,
          mode: interviewMode,
          shopperFirstName: accountFirstName || undefined,
          // Quick mode finishes after one follow-up; chat mode can ask more.
          forceReady: interviewMode === 'chat' ? userTurns >= 5 : userTurns >= 2,
        }),
      })
      const data = await getApiJson(response, 'Unable to continue that conversation.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to continue that conversation.')
      }

      const details =
        data.details && typeof data.details === 'object'
          ? (data.details as Partial<CardDetails>)
          : null
      const isReady = data.status === 'ready'

      const assistantMessage =
        typeof data.assistantMessage === 'string' && data.assistantMessage.trim()
          ? data.assistantMessage.trim()
          : isReady
            ? 'I filled in the form below. Tweak anything you want, then create your card.'
            : 'Tell me a bit more so I can fill in the form.'
      setInterviewMessages((current) => [...current, { role: 'assistant', content: assistantMessage }])

      if (details) {
        applyInterviewDetails(details)
      }

      if (interviewVoiceLoopRef.current && interviewMicSupported) {
        isInterviewingRef.current = false
        setIsInterviewing(false)
        if (isReady && details) {
          setInterviewComplete(true)
          await runGenieVoiceTurn(assistantMessage, false)
          if (!showCardInterviewRef.current) {
            return
          }
          setInterviewNotice('All set — I filled the form below. Review it, then create your card.')
          window.setTimeout(() => {
            document.querySelector('.form-panel .field-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }, 80)
        } else {
          setInterviewComplete(false)
          await runGenieVoiceTurn(assistantMessage, true)
        }
      } else if (isReady && details) {
        setInterviewComplete(true)
        setInterviewNotice('All set — I filled the form below. Review it, then create your card.')
        window.setTimeout(() => {
          document.querySelector('.form-panel .field-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 80)
      } else {
        setInterviewComplete(false)
        setInterviewNotice(
          interviewMode === 'chat'
            ? details
              ? 'I updated the form below — keep chatting, then tap I’m done when you’ve answered.'
              : 'Genie has a follow-up — answer it, then tap I’m done again.'
            : details
              ? 'I filled in what I know below — answer the follow-up, then tap I’m done again.'
              : 'Genie has a quick follow-up — answer it, then tap I’m done again.',
        )
        ensureInterviewListening({ announce: false })
      }
    } catch (caughtError) {
      setInterviewComplete(false)
      const friendly = getFriendlyErrorMessage(caughtError, 'Unable to continue that conversation.')
      const message =
        isLocalApiDev && /failed to fetch|load failed|networkerror|network request failed/i.test(
          caughtError instanceof Error ? caughtError.message : '',
        )
          ? 'Local Genie API is not running. Start it with npm run dev:server (port 8787), then try again.'
          : friendly
      setInterviewNotice(interviewVoiceLoopRef.current ? `${message} Listening again.` : message)
      interviewMicIgnoreUntilRef.current = Date.now()
      ensureInterviewListening({ announce: false })
    } finally {
      isInterviewingRef.current = false
      setIsInterviewing(false)
    }
  }

  sendCardInterviewRef.current = sendCardInterview

  useEffect(() => {
    return () => {
      stopInterviewListening()
      stopGenieSpeech()
      if (actionFeedbackClearRef.current !== null) {
        window.clearTimeout(actionFeedbackClearRef.current)
      }
    }
  }, [])

  useEffect(() => {
    // Browser back from Stripe often restores this page from bfcache with checkout still "busy".
    const resetCheckoutOpeningState = () => {
      setIsOpeningCheckout(false)
      if (actionFeedbackClearRef.current !== null) {
        window.clearTimeout(actionFeedbackClearRef.current)
        actionFeedbackClearRef.current = null
      }
      setActionFeedback((current) =>
        /^Opening secure checkout/i.test(current.trim()) ? '' : current,
      )
      setCreditNotice((notice) =>
        /^Opening secure checkout/i.test(String(notice).trim()) ? '' : notice,
      )
    }

    window.addEventListener('pageshow', resetCheckoutOpeningState)
    return () => window.removeEventListener('pageshow', resetCheckoutOpeningState)
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollInterviewThreadToBottom()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [interviewMessages, interviewNotice, isInterviewing])

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
    showActionFeedback(acceptedFiles.length > 1 ? 'Adding photos…' : 'Adding photo…')

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
      clearActionFeedback()
    }
  }

  const removeReferencePhoto = (photoId: string) => {
    setReferencePhotos((current) => current.filter((photo) => photo.id !== photoId))
    setReferencePhotoNotice('')
  }

  const rememberCredits = (nextCredits: number) => {
    const balance = Math.max(0, nextCredits)
    setCredits(balance)
    window.localStorage.setItem(creditStorageKey, String(balance))
    return balance
  }

  const syncAccountCredits = async (payload: { balance?: number; add?: number; reason: string }) => {
    if (!accountSession?.token) {
      return
    }

    try {
      const response = await fetch(apiUrl('/api/account/credits'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accountSession.token}`,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        return
      }
      const data = await getApiJson(response, 'Unable to update credits.')
      const nextBalance = parseCreditBalance(data.creditBalance)
      if (nextBalance !== null) {
        rememberCredits(nextBalance)
      }
    } catch {
      // Keep the local balance if the account update cannot be reached.
    }
  }

  const formatAccountDate = (value?: string) => {
    if (!value) {
      return ''
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }
    return date.toLocaleString()
  }

  const accountActivityPreviewLimit = 5

  const creditEventDetail = (event: {
    note?: string
    label?: string
    creditsDelta?: number
    balanceAfter?: number
  }) => {
    const note = event.note?.trim() || ''
    if (note) {
      // Soften older Stripe notes that stored raw session/price IDs.
      const stripeMatch = note.match(/^Stripe checkout\s+\S+(?:\s·\s*pack\s+(\d+))?/i)
      if (stripeMatch) {
        const packCredits = stripeMatch[1] || (event.creditsDelta && event.creditsDelta > 0 ? String(event.creditsDelta) : '')
        return packCredits ? `${packCredits} credit pack` : 'Credit pack purchase'
      }
      return note
    }
    if (typeof event.balanceAfter === 'number') {
      return `Balance ${event.balanceAfter}`
    }
    return 'Credit update'
  }

  const cardActivityItems = useMemo(() => {
    if (!accountHistory) {
      return []
    }

    const resolveThumbUrl = (cardId?: string, coverThumbUrl?: string) => {
      if (!coverThumbUrl) {
        return ''
      }
      if (cardId && apiBaseUrl) {
        return `${apiBaseUrl}/c/${encodeURIComponent(cardId)}/thumb`
      }
      return coverThumbUrl
    }

    const deliveries = accountHistory.deliveries || []
    const cardIdsWithEmailSend = new Set(
      deliveries
        .filter((delivery) => !delivery.isSenderCopy && delivery.method === 'email')
        .map((delivery) => delivery.cardId)
        .filter(Boolean),
    )

    const created = (accountHistory.cards || [])
      .filter((card) => !cardIdsWithEmailSend.has(card.id))
      .map((card) => ({
        id: `card-${card.id}`,
        createdAt: card.createdAt,
        title: 'Created',
        detail: [card.recipientName, card.occasion].filter(Boolean).join(' · ') || 'Card',
        status: card.status,
        coverThumbUrl: resolveThumbUrl(card.id, card.coverThumbUrl),
      }))

    const sent = deliveries
      .filter((delivery) => !delivery.isSenderCopy)
      .map((delivery) => ({
        id: `delivery-${delivery.id}`,
        createdAt: delivery.createdAt,
        title: `Sent · ${delivery.method === 'text' ? 'Text' : 'Email'}`,
        detail: delivery.destination,
        status: delivery.status,
        coverThumbUrl: resolveThumbUrl(delivery.cardId, delivery.coverThumbUrl),
      }))

    const thanks = (accountHistory.thankYous || []).map((thankYou) => ({
      id: `thanks-${thankYou.id}`,
      createdAt: thankYou.createdAt,
      title: 'Thank-you received',
      detail: thankYou.recipientName
        ? `${thankYou.recipientName}: “${thankYou.message}”`
        : `“${thankYou.message}”`,
      status: thankYou.status || 'Sent',
      coverThumbUrl: '',
    }))

    return [...created, ...sent, ...thanks].sort((left, right) =>
      String(right.createdAt).localeCompare(String(left.createdAt)),
    )
  }, [accountHistory])

  const printOrderItems = useMemo(() => {
    if (!accountHistory?.printOrders?.length) {
      return []
    }

    const resolveThumbUrl = (cardId?: string, coverThumbUrl?: string) => {
      if (!coverThumbUrl) {
        return ''
      }
      if (cardId && apiBaseUrl) {
        return `${apiBaseUrl}/c/${encodeURIComponent(cardId)}/thumb`
      }
      return coverThumbUrl
    }

    return accountHistory.printOrders.map((order) => {
      const shipToLines =
        formatAccountMailingAddress(order.shipTo) || order.shipToName || 'Mailing address saved'
      const detailParts = [
        `Ship to:\n${shipToLines}`,
        order.shopperEmail ? `Confirmation: ${order.shopperEmail}` : null,
      ].filter(Boolean)

      return {
        id: `print-${order.orderCode}`,
        orderCode: order.orderCode,
        createdAt: order.createdAt,
        detail: detailParts.join('\n'),
        status: order.status || 'submitted',
        coverThumbUrl: resolveThumbUrl(order.cardId, order.coverThumbUrl),
      }
    })
  }, [accountHistory])

  const loadAccountHistory = async (token: string) => {
    setIsLoadingAccountHistory(true)
    setAccountHistoryError('')
    try {
      const response = await fetch(apiUrl('/api/account/history'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await getApiJson(response, 'Unable to load your account.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load your account.')
      }
      setAccountHistory(data)
      const serverBalance = parseCreditBalance(data.account?.creditBalance)
      if (serverBalance !== null) {
        rememberCredits(serverBalance)
      }
      const profileEmail = String(data.account?.email || '')
      const profilePreferredName = String(data.account?.preferredName || '').trim()
      const profileMailing = normalizeResumeMailingAddress(
        data.account?.mailingAddress,
        emptyMailingAddress(),
      )
      const hasMailing = !isMailingAddressBlank(profileMailing)
      setAccountProfileEmail(profileEmail)
      setAccountPreferredName(profilePreferredName)
      setAccountProfileMailing(hasMailing ? profileMailing : emptyMailingAddress())
      setAccountProfileNotice('')
      setAccountSession((current) => {
        if (!current || current.token !== token) {
          return current
        }
        const next = {
          ...current,
          phoneE164: String(data.phoneE164 || current.phoneE164),
          copyEmail: profileEmail || current.copyEmail || '',
          preferredName: profilePreferredName || current.preferredName || '',
          mailingAddress: hasMailing ? profileMailing : null,
        }
        window.localStorage.setItem(
          accountSessionStorageKey,
          JSON.stringify({
            token: next.token,
            phoneE164: next.phoneE164,
            copyEmail: next.copyEmail,
          }),
        )
        return next
      })
      if (profilePreferredName) {
        setShowPreferredNamePrompt(false)
      }
      if (profileEmail) {
        setSenderCopyEmail((current) => current || profileEmail)
        setPrintShopperEmail((current) => current || profileEmail)
      }
      if (hasMailing) {
        setPrintMailFrom((current) =>
          isDefaultPrintMailFromAddress(current) ? profileMailing : current,
        )
      }
    } catch (caughtError) {
      setAccountHistoryError(caughtError instanceof Error ? caughtError.message : 'Unable to load your account.')
    } finally {
      setIsLoadingAccountHistory(false)
    }
  }

  const loadAdminMetrics = async (
    token: string,
    period: 'today' | '7d' | '30d' | 'ytd' = adminMetricsPeriod,
  ) => {
    setIsLoadingAdminMetrics(true)
    setAdminMetricsError('')
    try {
      const response = await fetch(apiUrl(`/api/admin/metrics?period=${encodeURIComponent(period)}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await getApiJson(response, 'Unable to load site analytics.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load site analytics.')
      }
      setAdminMetrics(data)
    } catch (caughtError) {
      setAdminMetrics(null)
      setAdminMetricsError(caughtError instanceof Error ? caughtError.message : 'Unable to load site analytics.')
    } finally {
      setIsLoadingAdminMetrics(false)
    }
  }

  const selectAdminMetricsPeriod = async (period: 'today' | '7d' | '30d' | 'ytd') => {
    setAdminMetricsPeriod(period)
    if (!accountSession?.token) {
      return
    }
    await loadAdminMetrics(accountSession.token, period)
  }

  const loadAdminReviews = async (
    token: string,
    status: 'pending' | 'approved' | 'rejected' = adminReviewStatus,
  ) => {
    setIsLoadingPendingReviews(true)
    setPendingReviewNotice('')
    try {
      const response = await fetch(apiUrl(`/api/admin/testimonials?status=${encodeURIComponent(status)}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await getApiJson(response, 'Unable to load reviews.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load reviews.')
      }
      setPendingReviews(Array.isArray(data.testimonials) ? data.testimonials : [])
    } catch (caughtError) {
      setPendingReviews([])
      setPendingReviewNotice(caughtError instanceof Error ? caughtError.message : 'Unable to load reviews.')
    } finally {
      setIsLoadingPendingReviews(false)
    }
  }

  const selectAdminReviewStatus = async (status: 'pending' | 'approved' | 'rejected') => {
    setAdminReviewStatus(status)
    if (!accountSession?.token) {
      return
    }
    await loadAdminReviews(accountSession.token, status)
  }

  const updatePendingReview = async (id: string, status: 'pending' | 'approved' | 'rejected') => {
    if (!accountSession?.token) {
      return
    }
    setUpdatingReviewId(id)
    setPendingReviewNotice('')
    try {
      const response = await fetch(apiUrl(`/api/admin/testimonials/${encodeURIComponent(id)}`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accountSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      })
      const data = await getApiJson(response, 'Unable to update that review.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to update that review.')
      }
      setPendingReviews((current) => current.filter((review) => review.id !== id))
      const notice =
        status === 'approved' ? 'Review approved.' : status === 'rejected' ? 'Review hidden.' : 'Review moved to pending.'
      setPendingReviewNotice(notice)
      void loadAdminMetrics(accountSession.token)
    } catch (caughtError) {
      setPendingReviewNotice(caughtError instanceof Error ? caughtError.message : 'Unable to update that review.')
    } finally {
      setUpdatingReviewId('')
    }
  }

  const openAccountPage = async () => {
    setShowAccountPage(true)
    setAdminView(null)
    setShowCreditMenu(false)
    setAccountHistoryError('')
    setShowAllCreditEvents(false)
    setShowAllCardActivity(false)
    setShowAllPrintOrders(false)
    setActiveCoverThumbId(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })

    if (!accountSession?.token) {
      setAccountHistory(null)
      showActionFeedback('Opening account…', 1200)
      return
    }

    showActionFeedback('Loading your account…')
    try {
      await loadAccountHistory(accountSession.token)
    } finally {
      clearActionFeedback()
    }
  }

  const openAdminAnalytics = async () => {
    if (!accountSession?.token || !isAdmin) {
      return
    }
    setShowAccountPage(false)
    setAdminView('analytics')
    setShowCreditMenu(false)
    setAdminMetricsPeriod('7d')
    setThumbBackfillNotice('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    await loadAdminMetrics(accountSession.token, '7d')
  }

  const runCoverThumbBackfill = async () => {
    if (!accountSession?.token || !isAdmin) {
      return
    }

    setIsBackfillingThumbs(true)
    setThumbBackfillNotice('Backfilling cover thumbnails…')
    let cursor: string | null = null
    let totalCreated = 0
    let totalScanned = 0
    let totalFailed = 0
    let pages = 0

    try {
      do {
        const response = await fetch(apiUrl('/api/admin/backfill-cover-thumbs'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accountSession.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ limit: 25, cursor }),
        })
        const data = await getApiJson(response, 'Unable to backfill cover thumbnails.')
        if (!response.ok) {
          throw new Error(data.error || 'Unable to backfill cover thumbnails.')
        }

        totalCreated += Number(data.created) || 0
        totalScanned += Number(data.scanned) || 0
        totalFailed += Number(data.failed) || 0
        cursor = data.done ? null : String(data.cursor || '') || null
        pages += 1
        setThumbBackfillNotice(
          `Backfill in progress… scanned ${totalScanned}, created ${totalCreated}${
            totalFailed ? `, failed ${totalFailed}` : ''
          }.`,
        )
      } while (cursor && pages < 40)

      setThumbBackfillNotice(
        `Backfill finished. Scanned ${totalScanned}, created ${totalCreated}${
          totalFailed ? `, failed ${totalFailed}` : ''
        }.`,
      )
      if (accountSession.token) {
        await loadAccountHistory(accountSession.token)
      }
    } catch (caughtError) {
      setThumbBackfillNotice(
        caughtError instanceof Error ? caughtError.message : 'Unable to backfill cover thumbnails.',
      )
    } finally {
      setIsBackfillingThumbs(false)
    }
  }

  const openAdminReviews = async () => {
    if (!accountSession?.token || !isAdmin) {
      return
    }
    setShowAccountPage(false)
    setAdminView('reviews')
    setShowCreditMenu(false)
    setPendingReviewNotice('')
    setAdminReviewStatus('pending')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    await loadAdminReviews(accountSession.token, 'pending')
  }

  const closeAdminView = () => {
    setAdminView(null)
    void openAccountPage()
  }

  const grantCreditsToPhone = async () => {
    if (!accountSession?.token || !isAdmin) {
      return
    }

    const validatedPhone = validatePhoneNumber(adminGrantPhone)
    if (!validatedPhone.ok) {
      setAdminGrantNotice(validatedPhone.message)
      return
    }

    const amount = Math.floor(Number(adminGrantCredits))
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
      setAdminGrantNotice('Enter a credit amount between 1 and 500.')
      return
    }

    setIsGrantingCredits(true)
    setAdminGrantNotice('')

    try {
      const response = await fetch(apiUrl('/api/admin/grant-credits'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accountSession.token}`,
        },
        body: JSON.stringify({
          phone: validatedPhone.value,
          credits: amount,
        }),
      })
      const data = await getApiJson(response, 'Unable to grant credits.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to grant credits.')
      }

      setAdminGrantPhone(formatPhoneNumberDisplay(String(data.phoneE164 || validatedPhone.value)))
      setAdminGrantNotice(
        String(data.message || `Added ${amount} credits. New balance: ${data.creditBalance}.`),
      )
    } catch (caughtError) {
      setAdminGrantNotice(caughtError instanceof Error ? caughtError.message : 'Unable to grant credits.')
    } finally {
      setIsGrantingCredits(false)
    }
  }

  const buyCreditPack = async (pack: (typeof creditPacks)[number]) => {
    if (!accountSession?.token) {
      setShowCreditMenu(false)
      setCreditNotice('Confirm your mobile number to buy credits.')
      setDeliveryNotice('')
      setRefinementNotice('')
      void openAccountPage()
      return
    }

    setShowCreditMenu(false)
    setIsOpeningCheckout(true)
    showActionFeedback('Opening secure checkout…')
    setDeliveryNotice('')
    setRefinementNotice('')

    try {
      // Stripe leaves the page — stash card + recipients so checkout return can restore them.
      let resumeCardId: string | undefined

      if (card) {
        resumeCardId = sharedCard?.id
        let resumeShareUrl = sharedCard?.shareUrl

        try {
          const shared = await saveCurrentCard()
          resumeCardId = shared.id
          resumeShareUrl = shared.shareUrl
        } catch {
          // Keep any previously saved card id; otherwise refuse to leave the page.
          if (!resumeCardId) {
            setCreditNotice(
              'Could not save your card before checkout. Please try again so it is not lost when you return.',
            )
            setIsOpeningCheckout(false)
            clearActionFeedback()
            return
          }
        }

        const resumeBase: CheckoutResumeState = {
          version: 1,
          savedAt: Date.now(),
          cardId: resumeCardId,
          shareUrl: resumeShareUrl,
          details,
          // Never persist the full data-URL cover — localStorage quotas wipe the whole snapshot.
          card: slimCheckoutResumeCard(card),
          greeting: cardGreeting,
          signature: cardSignature,
          step: hasViewedInside ? 'inside' : hasViewedFront ? 'front' : step,
          hasViewedFront: hasViewedFront || Boolean(card),
          hasViewedInside: hasViewedInside || Boolean(card),
          hasSentCurrentCard,
          deliveryMethod,
          deliveryDestinations,
          showSenderCopyField,
          senderCopyEmail,
          smsConsentConfirmed,
          printOrderStep,
          printShipTo,
          printMailFrom,
          printShopperEmail,
        }

        try {
          writeCheckoutResume(resumeBase)
        } catch {
          // Resume URL still carries cardId; recipients may be lost but the card can reload.
        }
      }

      const response = await fetch(apiUrl('/api/billing/checkout-session'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accountSession.token}`,
        },
        body: JSON.stringify({
          packId: pack.id,
          priceId: pack.priceId,
          ...(resumeCardId ? { resumeCardId } : {}),
        }),
      })
      const data = await getApiJson(response, 'Unable to start checkout.')
      if (!response.ok || !data.url) {
        setCreditNotice(String(data.error || 'Unable to start checkout.'))
        setIsOpeningCheckout(false)
        clearActionFeedback()
        return
      }
      window.location.assign(String(data.url))
    } catch (caughtError) {
      setCreditNotice(caughtError instanceof Error ? caughtError.message : 'Unable to start checkout.')
      setIsOpeningCheckout(false)
      clearActionFeedback()
    }
  }

  const setCreditBalance = (balance: number) => {
    rememberCredits(balance)
    setCreditNotice(`Credits set to ${balance} for testing.`)
    void syncAccountCredits({ balance, reason: 'dev_set' })
  }

  const finishGeneratedCard = (
    data: {
      message: string
      closing?: string
      imageUrl: string
      messageVariants?: MessageVariants
      selectedLength?: MessageLengthId
    },
    signatureName: string,
  ) => {
    const selectedLength =
      data.selectedLength === 'short' || data.selectedLength === 'long' ? data.selectedLength : 'medium'
    const variants =
      data.messageVariants?.short && data.messageVariants?.medium && data.messageVariants?.long
        ? {
            short: normalizeCardCopy(data.messageVariants.short, data.closing, signatureName).message,
            medium: normalizeCardCopy(data.messageVariants.medium, data.closing, signatureName).message,
            long: normalizeCardCopy(data.messageVariants.long, data.closing, signatureName).message,
          }
        : undefined
    const activeMessage = variants?.[selectedLength] || data.message
    const copy = normalizeCardCopy(activeMessage, data.closing, signatureName)
    setCard({
      imageUrl: data.imageUrl,
      message: copy.message,
      closing: copy.closing,
      messageVariants: variants,
      selectedLength: variants ? selectedLength : undefined,
    })
    setCardGreeting('')
    setCardSignature(signatureName)
    setStep('envelope')
    restoreSentAfterFailedGenerateRef.current = false
    setHasSentCurrentCard(false)
    setShowCompletionNote(true)
    setCreditNotice('Creating a card is free. Sending uses 3 credits.')
    window.setTimeout(() => setShowCompletionNote(false), 6000)
    clearStoredGenerationJob()
    clearActionFeedback()
  }

  const followGenerationJob = async (jobId: string, signatureName: string) => {
    const pollId = generationPollIdRef.current + 1
    generationPollIdRef.current = pollId
    const isCurrent = () => generationPollIdRef.current === pollId

    setIsGenerating(true)
    setError('')
    setShowEditor(false)
    setShowPolishDialog(false)
    setHasAcceptedRevision(false)
    setHasViewedFront(false)
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
      if (restoreSentAfterFailedGenerateRef.current) {
        setHasSentCurrentCard(true)
        restoreSentAfterFailedGenerateRef.current = false
      }
      setCreditNotice('Your credits are still in your account.')
    } finally {
      if (isCurrent()) {
        setIsGenerating(false)
        clearActionFeedback()
      }
    }
  }

  followGenerationJobRef.current = followGenerationJob

  const generateCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget

    if (!form.checkValidity()) {
      const firstInvalid = form.querySelector(':invalid')
      setHighlightInvalidFields(true)
      setError(getCreateCardValidationMessage(firstInvalid))
      if (firstInvalid instanceof HTMLElement) {
        firstInvalid.focus({ preventScroll: true })
      }
      window.setTimeout(() => {
        form.querySelector('.error-message')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 50)
      return
    }

    setHighlightInvalidFields(false)
    setError('')

    restoreSentAfterFailedGenerateRef.current = hasSentCurrentCard
    setIsGenerating(true)
    showActionFeedback('Creating your card…')
    setShowCompletionNote(false)
    setActiveGenerationStep(0)
    setShowEditor(false)
    setShowPolishDialog(false)
    setHasAcceptedRevision(false)
    setSharedCard(null)
    setDeliveryNotice('')
    setHasSentCurrentCard(false)
    setHasViewedFront(false)
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
      if (restoreSentAfterFailedGenerateRef.current) {
        setHasSentCurrentCard(true)
        restoreSentAfterFailedGenerateRef.current = false
      }
      setCreditNotice('Your credits are still in your account.')
    } finally {
      if (!startedBackgroundJob) {
        setIsGenerating(false)
        clearActionFeedback()
      }
    }
  }

  const openEnvelope = () => {
    setStep('opening')
    window.setTimeout(() => setStep('front'), 4600)
  }

  const playEnvelopeBack = () => {
    setStep('envelopeBack')
    window.setTimeout(openEnvelope, 350)
  }

  const flipEnvelope = () => {
    setStep('envelopeFlip')
    window.setTimeout(playEnvelopeBack, 1200)
  }

  const replayAnimation = () => {
    setShowEditor(false)
    setShowPolishDialog(false)
    setHasViewedFront(false)
    setHasViewedInside(false)
    setStep('envelope')
  }

  const sendThankYou = async () => {
    if (!sharedCardId || isSendingThankYou || thankYouAlreadySent) {
      return
    }

    const selectedPreset = thankYouPresetsState.find((preset) => preset.id === selectedThankYouPreset)
    const customMessage = customThankYouMessage.replace(/\s+/g, ' ').trim()
    if (selectedPreset?.allowsCustom) {
      if (!customMessage) {
        setThankYouNotice('Write a short thank-you message.')
        return
      }
      if (customMessage.length > thankYouCustomMaxLength) {
        setThankYouNotice(`Keep your thank-you under ${thankYouCustomMaxLength} characters.`)
        return
      }
    }

    setIsSendingThankYou(true)
    setThankYouNotice('')

    try {
      const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(sharedCardId)}/thank-you`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          presetId: selectedThankYouPreset,
          message: selectedPreset?.allowsCustom ? customMessage : undefined,
        }),
      })
      const data = await getApiJson(response, 'Unable to send the thank-you.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send the thank-you.')
      }

      setThankYouAlreadySent(true)
      setThankYouAvailable(false)
      setThankYouNotice(data.message || 'Your thank-you is on its way to the sender.')
    } catch (caughtError) {
      setThankYouNotice(getFriendlyErrorMessage(caughtError, 'Unable to send the thank-you.'))
    } finally {
      setIsSendingThankYou(false)
    }
  }

  const openEditor = () => {
    setShowEditor(true)
    setEditorHasChanges(false)
    setRefinementNotice('')
    setEditorTab(step === 'inside' ? 'inside' : 'front')
  }

  const updateCardMessage = (message: string) => {
    setCard((current) => {
      if (!current) {
        return current
      }

      const selected = current.selectedLength
      const nextVariants =
        current.messageVariants && selected
          ? { ...current.messageVariants, [selected]: message }
          : current.messageVariants

      return {
        ...current,
        message,
        messageVariants: nextVariants,
      }
    })
    setEditorHasChanges(true)
  }

  const selectMessageLength = (lengthId: MessageLengthId) => {
    setCard((current) => {
      if (!current?.messageVariants?.[lengthId]) {
        return current
      }

      return {
        ...current,
        selectedLength: lengthId,
        message: current.messageVariants[lengthId],
      }
    })
  }

  const updateCardClosing = (closing: string) => {
    setCard((current) => (current ? { ...current, closing } : current))
    setEditorHasChanges(true)
  }

  const saveImageToDevice = async (imageUrl: string, fileName: string, label: string) => {
    if (!imageUrl) {
      return
    }

    setSaveNotice('')
    setAdminPrintNotice('')
    setIsSavingImage(true)
    showActionFeedback(`Preparing ${label.toLowerCase()}…`)

    const resolveShareFile = async () => {
      try {
        return await imageUrlToFile(imageUrl, fileName)
      } catch {
        const loaded = await loadCoverImageForPrint({
          imageUrl,
          cardId: sharedCard?.id,
        })
        try {
          const jpeg =
            upscaleImageToDataUrl(loaded.source, loaded.width, loaded.height, 'image/jpeg', 0.92) ||
            upscaleImageToDataUrl(loaded.source, loaded.width, loaded.height, 'image/png')
          if (!jpeg) {
            throw new Error('Unable to prepare that image for saving.')
          }
          return imageUrlToFile(jpeg, fileName.replace(/\.\w+$/, '.jpg'))
        } finally {
          loaded.dispose?.()
        }
      }
    }

    try {
      if (prefersPhotoSave) {
        try {
          const imageFile = await resolveShareFile()

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
    } finally {
      setIsSavingImage(false)
      clearActionFeedback()
    }
  }

  const prepareAdminPrintFiles = async () => {
    if (!card) {
      return
    }

    setIsPreparingAdminPrintFiles(true)
    setAdminPrintNotice('')
    setAdminPrintFiles(null)

    try {
      const loaded = await loadCoverImageForPrint({
        imageUrl: card.imageUrl,
        cardId: sharedCard?.id,
      })
      let coverUrl = ''
      try {
        coverUrl = upscaleImageToDataUrl(loaded.source, PRINT_CARD_WIDTH, PRINT_CARD_HEIGHT)
      } finally {
        loaded.dispose?.()
      }
      if (!coverUrl) {
        throw new Error('Unable to prepare the print cover file.')
      }

      const insideUrl = await buildPrintInsideImageUrl({
        greeting: insideGreeting,
        paragraphs: messageParagraphs,
        closing: cardClosing,
        signature: cardSignatureLabel,
        density: messageDensity,
      })
      if (!insideUrl) {
        throw new Error('Unable to prepare the print inside file.')
      }

      setAdminPrintFiles({ coverUrl, insideUrl })
      setAdminPrintNotice('Print test files are ready at 1504×2096 px.')
    } catch (caughtError) {
      setAdminPrintNotice(
        caughtError instanceof Error ? caughtError.message : 'Unable to prepare print test files.',
      )
    } finally {
      setIsPreparingAdminPrintFiles(false)
    }
  }

  const updatePrintAddressField = (
    which: 'ship-to' | 'mail-from' | 'account',
    field: keyof MailingAddress,
    value: string,
  ) => {
    const setter =
      which === 'ship-to'
        ? setPrintShipTo
        : which === 'mail-from'
          ? setPrintMailFrom
          : setAccountProfileMailing
    setter((current) => ({
      ...current,
      [field]: field === 'state' ? value.toUpperCase() : field === 'country' ? 'US' : value,
    }))
    if (which === 'account') {
      setAccountProfileNotice('')
    } else {
      setPrintOrderNotice('')
    }
  }

  const resolveKnownShopperEmail = () =>
    formatEmailAddress(accountSession?.copyEmail || senderCopyEmail || printShopperEmail || '')

  const resolveSavedMailingAddress = (): MailingAddress | null => {
    const fromSession = accountSession?.mailingAddress
    if (fromSession && !isMailingAddressBlank(fromSession)) {
      return fromSession
    }
    const fromHistory = accountHistory?.account?.mailingAddress
    const normalized = normalizeResumeMailingAddress(fromHistory, emptyMailingAddress())
    return isMailingAddressBlank(normalized) ? null : normalized
  }

  const openPrintOrder = () => {
    const knownEmail = resolveKnownShopperEmail()
    if (knownEmail) {
      setPrintShopperEmail(knownEmail)
    }
    applySavedMailingAddressToPrint(resolveSavedMailingAddress())
    setPrintOrderStep('ship-to')
    setPrintOrderNotice('')
    window.setTimeout(() => {
      document.querySelector('.print-order-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  const previewPrintEnvelope = () => {
    if (printOrderStep === 'review') {
      setPrintOrderStep('closed')
      setPrintOrderNotice('')
      return
    }

    setPrintShipTo({ ...samplePrintShipTo })
    setPrintMailFrom({ ...defaultPrintMailFrom })
    const knownEmail = resolveKnownShopperEmail()
    if (knownEmail) {
      setPrintShopperEmail(knownEmail)
    }
    setPrintOrderStep('review')
    setPrintOrderNotice('Preview only — sample addresses. You can still place a real order from here.')
    window.setTimeout(() => {
      document.querySelector('.print-order-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  const submitPrintShipTo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validated = validateMailingAddress(printShipTo, 'recipient')
    if (!validated.ok) {
      setPrintOrderNotice(validated.message)
      return
    }
    setPrintShipTo(validated.value)
    const knownEmail = resolveKnownShopperEmail()
    if (knownEmail && !printShopperEmail.trim()) {
      setPrintShopperEmail(knownEmail)
    }
    setPrintOrderStep('review')
    setPrintOrderNotice('')
  }

  const submitPrintMailFrom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validated = validateMailingAddress(printMailFrom, 'mail-from')
    if (!validated.ok) {
      setPrintOrderNotice(validated.message)
      return
    }
    setPrintMailFrom(validated.value)
    setPrintOrderStep('review')
    setPrintOrderNotice('')
  }

  const preparePrintOrderImages = async (cardId?: string) => {
    if (!card) {
      throw new Error('Create a card before ordering a print.')
    }

    const loaded = await loadCoverImageForPrint({
      imageUrl: card.imageUrl,
      cardId: cardId || sharedCard?.id,
    })
    let coverUrl = ''
    let coverThumbUrl = ''
    try {
      coverUrl = upscaleImageToDataUrl(loaded.source, PRINT_CARD_WIDTH, PRINT_CARD_HEIGHT, 'image/jpeg', 0.92)
      if (!coverUrl) {
        coverUrl = upscaleImageToDataUrl(loaded.source, PRINT_CARD_WIDTH, PRINT_CARD_HEIGHT, 'image/jpeg', 0.82)
      }
      const thumbScale = Math.min(1, 320 / Math.max(loaded.width, loaded.height))
      const thumbWidth = Math.max(1, Math.round(loaded.width * thumbScale))
      const thumbHeight = Math.max(1, Math.round(loaded.height * thumbScale))
      coverThumbUrl = upscaleImageToDataUrl(loaded.source, thumbWidth, thumbHeight, 'image/jpeg', 0.72)
    } finally {
      loaded.dispose?.()
    }
    if (!coverUrl) {
      throw new Error(
        'Unable to prepare the print cover file. Please keep this page open and try Mail printed card again.',
      )
    }

    const insideUrl = await buildPrintInsideImageUrl({
      greeting: insideGreeting,
      paragraphs: messageParagraphs,
      closing: cardClosing,
      signature: cardSignatureLabel,
      density: messageDensity,
    })
    if (!insideUrl) {
      throw new Error(
        'Unable to prepare the print inside file. Please keep this page open and try Mail printed card again.',
      )
    }

    if (!coverThumbUrl) {
      try {
        coverThumbUrl = await createCoverThumbDataUrl(coverUrl, cardId || sharedCard?.id)
      } catch {
        coverThumbUrl = ''
      }
    }

    let insideThumbUrl = ''
    try {
      const insideImage = await loadImageElement(insideUrl)
      insideThumbUrl = upscaleImageToDataUrl(insideImage, 280, 390)
    } catch {
      insideThumbUrl = ''
    }

    return { coverUrl, insideUrl, coverThumbUrl, insideThumbUrl }
  }

  const confirmPrintOrder = async () => {
    setPrintOrderNotice('')

    const shipTo = validateMailingAddress(printShipTo, 'recipient')
    if (!shipTo.ok) {
      setPrintOrderNotice(shipTo.message)
      setPrintOrderStep('ship-to')
      return
    }

    const mailFrom = validateMailingAddress(printMailFrom, 'mail-from')
    if (!mailFrom.ok) {
      setPrintOrderNotice(mailFrom.message)
      setPrintOrderStep('mail-from')
      return
    }

    const shopperEmail = validateEmailAddress(printShopperEmail)
    if (!shopperEmail.ok) {
      setPrintOrderNotice(
        shopperEmail.message
          .replace(/the recipient email address/i, 'your email address')
          .replace(/Recipient email/i, 'Your email'),
      )
      return
    }

    if (!accountSession?.token) {
      setPrintOrderNotice('Confirm your mobile number before ordering a printed card.')
      return
    }

    if (credits < printCardCreditCost) {
      promptNeedCredits(
        `You need ${printCardCreditCost} credits to mail a printed card. You currently have ${credits}. Buy more credits to keep going.`,
        'send',
      )
      setPrintOrderNotice(
        `You need ${printCardCreditCost} credits to mail a printed card. You currently have ${credits}.`,
      )
      return
    }

    setIsOrderingPrint(true)
    showActionFeedback('Preparing your printed card…')

    try {
      const shared = await saveCurrentCard()
      const { coverUrl, insideUrl, coverThumbUrl, insideThumbUrl } = await preparePrintOrderImages(shared.id)
      const response = await fetch(apiUrl('/api/order-print-card'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accountSession.token}`,
        },
        body: JSON.stringify({
          cardId: shared.id,
          mailFrom: mailFrom.value,
          shipTo: shipTo.value,
          shopperEmail: shopperEmail.value,
          coverImage: coverUrl,
          insideImage: insideUrl,
          coverThumbImage: coverThumbUrl || undefined,
          insideThumbImage: insideThumbUrl || undefined,
        }),
      })
      const data = await getApiJson(response, 'Unable to place the print order.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to place the print order.')
      }

      const chargedCredits =
        typeof data.creditCost === 'number' && Number.isFinite(data.creditCost)
          ? data.creditCost
          : printCardCreditCost
      const nextCredits = rememberCredits(credits - chargedCredits)
      setCreditNotice(`${chargedCredits} credits used to order a printed card.`)
      void syncAccountCredits({ balance: nextCredits, reason: 'print_card_order' })
      const orderCode =
        typeof data.orderCode === 'string' && data.orderCode.trim() ? data.orderCode.trim() : ''
      saveAccountSession({
        token: accountSession.token,
        phoneE164: accountSession.phoneE164,
        copyEmail: shopperEmail.value,
        mailingAddress: !isDefaultPrintMailFromAddress(mailFrom.value)
          ? mailFrom.value
          : accountSession.mailingAddress || null,
      })
      setPrintShopperEmail(shopperEmail.value)
      if (!isDefaultPrintMailFromAddress(mailFrom.value)) {
        setAccountProfileMailing(mailFrom.value)
        setAccountHistory((current) =>
          current
            ? {
                ...current,
                account: {
                  ...(current.account || {}),
                  email: shopperEmail.value,
                  mailingAddress: mailFrom.value,
                },
              }
            : current,
        )
      } else if (shopperEmail.value) {
        setAccountProfileEmail(shopperEmail.value)
        setAccountHistory((current) =>
          current
            ? {
                ...current,
                account: {
                  ...(current.account || {}),
                  email: shopperEmail.value,
                },
              }
            : current,
        )
      }
      setPrintOrderNotice(
        <div className="print-order-success-notice">
          <p>
            Your card will be mailed to:
            <strong className="print-order-success-address">
              {formatMailingAddressLines(shipTo.value)}
            </strong>
          </p>
          {orderCode ? (
            <p>
              Order number: <strong>{orderCode}</strong>
            </p>
          ) : null}
          <p>
            A confirmation was emailed to: <strong>{shopperEmail.value}</strong>
          </p>
        </div>,
      )
      setPrintOrderStep('closed')
      setPrintShipTo(emptyMailingAddress())
      setPrintMailFrom({ ...defaultPrintMailFrom })
    } catch (caughtError) {
      setPrintOrderNotice(getFriendlyErrorMessage(caughtError, 'Unable to place the print order.'))
    } finally {
      setIsOrderingPrint(false)
      clearActionFeedback()
    }
  }

  const renderMailingAddressFields = (
    which: 'ship-to' | 'mail-from' | 'account',
    address: MailingAddress,
    nameLabel: string,
  ) => (
    <div className="print-address-fields">
      <label>
        {nameLabel}
        <input
          value={address.name}
          onChange={(event) => updatePrintAddressField(which, 'name', event.target.value)}
          autoComplete={which === 'ship-to' ? 'shipping name' : 'name'}
          placeholder="Full name"
        />
      </label>
      <label>
        Address line 1
        <input
          value={address.line1}
          onChange={(event) => updatePrintAddressField(which, 'line1', event.target.value)}
          autoComplete={which === 'ship-to' ? 'shipping address-line1' : 'street-address'}
          placeholder="Street address"
        />
      </label>
      <label>
        Address line 2 <span className="field-optional">(optional)</span>
        <input
          value={address.line2}
          onChange={(event) => updatePrintAddressField(which, 'line2', event.target.value)}
          autoComplete={which === 'ship-to' ? 'shipping address-line2' : 'address-line2'}
          placeholder="Apt, suite, unit"
        />
      </label>
      <div className="print-address-city-row">
        <label>
          City
          <input
            value={address.city}
            onChange={(event) => updatePrintAddressField(which, 'city', event.target.value)}
            autoComplete={which === 'ship-to' ? 'shipping address-level2' : 'address-level2'}
          />
        </label>
        <label>
          State
          <select
            value={address.state}
            onChange={(event) => updatePrintAddressField(which, 'state', event.target.value)}
            autoComplete={which === 'ship-to' ? 'shipping address-level1' : 'address-level1'}
          >
            <option value="">Select</option>
            {usStateOptions.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </label>
        <label>
          ZIP
          <input
            value={address.zip}
            onChange={(event) => updatePrintAddressField(which, 'zip', event.target.value)}
            autoComplete={which === 'ship-to' ? 'shipping postal-code' : 'postal-code'}
            inputMode="numeric"
            placeholder="94526"
          />
        </label>
      </div>
      <label>
        Country
        <input value="United States" disabled readOnly />
      </label>
    </div>
  )

  const acceptEditorChanges = () => {
    setShowEditor(false)
    setShowPolishDialog(false)
    setEditorHasChanges(false)
    setHasAcceptedRevision(true)
  }

  const scrollToCardPreview = () => {
    window.setTimeout(() => {
      previewPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
  }

  const openCreditPurchase = () => {
    setShowCreditMenu(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /** Break after the first sentence so the last few words are not left alone on the next line. */
  const formatCreditNeedMessage = (message: string) => {
    const match = message.trim().match(/^(.+?[.!?])\s+(.+)$/)
    if (!match) {
      return message
    }
    return `${match[1]}\n${match[2]}`
  }

  const promptNeedCredits = (message: string, where: 'send' | 'refine' = 'refine') => {
    const formatted = formatCreditNeedMessage(message)
    setCreditNotice(formatted)
    if (where === 'send') {
      setDeliveryNotice(formatted)
    } else {
      setRefinementNotice(formatted)
    }
  }

  const renderCreditNeedNotice = (message: string) => (
    <div className="delivery-notice credit-need-notice">
      <span>{formatCreditNeedMessage(message)}</span>
      <button className="secondary-button" type="button" onClick={openCreditPurchase}>
        Buy more credits
      </button>
    </div>
  )

  const renderCreditsLeft = () => (
    <p className="credits-left-hint">Credits left: {credits}</p>
  )

  const dismissFeedbackPrompt = () => {
    // Session-only hide — do not permanently lock people out of sharing feedback.
    setFeedbackDismissed(true)
    setFeedbackSubmitted(false)
    setShowFeedbackForm(false)
    setFeedbackNotice('')
  }

  const cancelFeedbackForm = () => {
    setShowFeedbackForm(false)
    setFeedbackNotice('')
  }

  const openFeedbackForm = (source: 'post_send' | 'account') => {
    setFeedbackDismissed(false)
    setFeedbackSubmitted(false)
    setFeedbackSource(source)
    setShowFeedbackForm(true)
    setFeedbackNotice('')
  }

  const submitFeedback = async () => {
    const comment = feedbackComment.trim()
    if (!comment) {
      setFeedbackNotice('Write a short review before sending.')
      return
    }
    if (comment.length > feedbackCommentMaxLength) {
      setFeedbackNotice(`Keep your review under ${feedbackCommentMaxLength} characters.`)
      return
    }

    setIsSubmittingFeedback(true)
    setFeedbackNotice('')

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (accountSession?.token) {
        headers.Authorization = `Bearer ${accountSession.token}`
      }

      const response = await fetch(apiUrl('/api/testimonials'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: feedbackName.trim() || undefined,
          rating: feedbackRating ?? undefined,
          comment,
          source: feedbackSource,
        }),
      })
      const data = await getApiJson(response, 'Unable to save your review right now.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to save your review right now.')
      }

      setFeedbackSubmitted(true)
      setShowFeedbackForm(false)
      setFeedbackComment('')
      setFeedbackName('')
      setFeedbackRating(null)
      setFeedbackNotice(data.message || 'Thanks for your review — that means a lot.')
      try {
        window.localStorage.setItem(feedbackDismissStorageKey, '1')
      } catch {
        // Ignore storage failures.
      }
      setFeedbackDismissed(true)
    } catch (caughtError) {
      setFeedbackNotice(getFriendlyErrorMessage(caughtError, 'Unable to save your review right now.'))
    } finally {
      setIsSubmittingFeedback(false)
    }
  }

  const renderFeedbackPrompt = (source: 'post_send' | 'account') => {
    if (feedbackSubmitted) {
      if (source !== feedbackSource) {
        return null
      }
      return (
        <div className="feedback-prompt">
          <p>{feedbackNotice || 'Thanks for your review — that means a lot.'}</p>
          <button className="text-action-link" type="button" onClick={dismissFeedbackPrompt}>
            Close
          </button>
        </div>
      )
    }

    // After a soft dismiss, keep a quiet re-entry on My account only.
    if (feedbackDismissed && !showFeedbackForm) {
      if (source !== 'account') {
        return null
      }
      return (
        <div className="feedback-prompt">
          <button className="text-action-link" type="button" onClick={() => openFeedbackForm('account')}>
            Leave a review
          </button>
        </div>
      )
    }

    if (!showFeedbackForm || feedbackSource !== source) {
      return (
        <div className="feedback-prompt">
          <p>Please share your feedback.</p>
          <div className="feedback-actions">
            <button className="secondary-button" type="button" onClick={() => openFeedbackForm(source)}>
              Leave a review
            </button>
            <button className="text-action-link" type="button" onClick={dismissFeedbackPrompt}>
              Not now
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="feedback-prompt feedback-form">
        <p>Please share your feedback.</p>
        <label>
          Name <span className="field-optional">(optional)</span>
          <input
            value={feedbackName}
            onChange={(event) => setFeedbackName(event.target.value)}
            placeholder="Your name"
            maxLength={80}
            autoComplete="name"
          />
        </label>
        <fieldset className="feedback-rating">
          <legend>
            Stars <span className="field-optional">(optional)</span>
          </legend>
          <div className="feedback-stars" role="group" aria-label="Star rating">
            {[1, 2, 3, 4, 5].map((value) => {
              const selected = feedbackRating !== null && value <= feedbackRating
              return (
                <button
                  key={value}
                  className={`feedback-star${selected ? ' is-selected' : ''}`}
                  type="button"
                  aria-label={`${value} star${value === 1 ? '' : 's'}`}
                  aria-pressed={feedbackRating === value}
                  onClick={() => setFeedbackRating(value)}
                >
                  ★
                </button>
              )
            })}
            {feedbackRating !== null && (
              <button className="text-action-link" type="button" onClick={() => setFeedbackRating(null)}>
                Clear
              </button>
            )}
          </div>
        </fieldset>
        <label>
          Your review
          <textarea
            value={feedbackComment}
            onChange={(event) => setFeedbackComment(event.target.value.slice(0, feedbackCommentMaxLength))}
            placeholder="What worked well? What could be better?"
            rows={3}
            maxLength={feedbackCommentMaxLength}
          />
          <small>
            {feedbackComment.length}/{feedbackCommentMaxLength}
          </small>
        </label>
        {feedbackNotice && <div className="field-notice">{feedbackNotice}</div>}
        <div className="feedback-actions">
          <button
            className="primary-button"
            type="button"
            disabled={isSubmittingFeedback}
            aria-busy={isSubmittingFeedback}
            onClick={() => void submitFeedback()}
          >
            {isSubmittingFeedback ? 'Sending...' : 'Send review'}
          </button>
          <button className="text-action-link" type="button" onClick={cancelFeedbackForm}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const refineImage = async () => {
    if (!card) {
      return
    }

    setError('')
    setRefinementNotice('')

    if (!hasEnoughCreditsForCover) {
      promptNeedCredits(
        `You need ${coverRevisionCost} credit to ${coverRefinementMode === 'revise' ? 'revise' : 'create'} the cover. You currently have ${credits}. Buy more credits to keep going.`,
      )
      return
    }

    setIsRefiningImage(true)
    showActionFeedback(
      coverRefinementMode === 'revise' ? 'Updating cover…' : 'Creating a new cover…',
    )

    try {
      let reviseCardId = sharedCard?.id
      let currentImageUrl: string | undefined

      if (coverRefinementMode === 'revise') {
        try {
          currentImageUrl = await prepareCoverJpegForApi(card.imageUrl, sharedCard?.id)
        } catch {
          currentImageUrl = undefined
        }

        if (!reviseCardId) {
          try {
            const shared = await saveCurrentCard()
            reviseCardId = shared.id
          } catch {
            // Continue with the compressed cover alone if save fails.
          }
        }

        if (!currentImageUrl && !reviseCardId) {
          throw new Error('Unable to prepare the current cover for editing. Please try again.')
        }
      }

      const response = await fetch(apiUrl('/api/refine-image'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          details,
          refinement: imageRefinement,
          imageMode: coverRefinementMode,
          ...(coverRefinementMode === 'revise'
            ? {
                ...(currentImageUrl ? { currentImageUrl } : {}),
                ...(reviseCardId ? { cardId: reviseCardId } : {}),
              }
            : {}),
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
      if (typeof data.cardId === 'string' && data.cardId.trim()) {
        const nextCardId = data.cardId.trim()
        setSharedCard((current) => {
          if (current?.id === nextCardId) {
            return current
          }
          if (!card) {
            return current
          }
          const shareUrl = isLocalApiDev
            ? localShareUrl(nextCardId)
            : apiUrl(`/c/${encodeURIComponent(nextCardId)}`)
          return {
            id: nextCardId,
            shareUrl,
            details,
            card: { ...card, imageUrl: data.imageUrl },
            greeting: insideGreeting || undefined,
            signature: cardSignatureLabel || undefined,
          }
        })
      }
      setHasSentCurrentCard(false)
      setImageRefinement('')
      setStep('front')
      setEditorHasChanges(true)
      const nextCredits = rememberCredits(credits - coverRevisionCost)
      setCreditNotice(`${coverRevisionCost} credit used to ${coverRefinementMode === 'revise' ? 'revise' : 'create'} the cover.`)
      void syncAccountCredits({ balance: nextCredits, reason: 'cover_revise' })
      scrollToCardPreview()
    } catch (caughtError) {
      setError(getFriendlyErrorMessage(caughtError, 'Unable to refine the cover image.'))
      setCreditNotice('Your credits are still in your account.')
    } finally {
      setIsRefiningImage(false)
      clearActionFeedback()
    }
  }

  const refineCopy = async () => {
    if (!card) {
      return
    }

    setError('')
    setRefinementNotice('')

    if (!hasEnoughCreditsForAiCopy) {
      promptNeedCredits(
        `You need ${aiCopyCost} credit for an AI rewrite. You currently have ${credits}. Editing the message yourself is free.`,
      )
      return
    }

    setIsRefiningCopy(true)
    showActionFeedback('Rewriting inside…')

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
              messageVariants:
                current.messageVariants && current.selectedLength
                  ? {
                      ...current.messageVariants,
                      [current.selectedLength]: copy.message,
                    }
                  : current.messageVariants,
            }
          : current,
      )
      setCopyRefinement('')
      setShowPolishDialog(false)
      setStep('inside')
      setEditorHasChanges(true)
      const nextCredits = rememberCredits(credits - aiCopyCost)
      setCreditNotice(`${aiCopyCost} credit used for the AI rewrite. Editing the message yourself is free.`)
      void syncAccountCredits({ balance: nextCredits, reason: 'ai_copy' })
      scrollToCardPreview()
    } catch (caughtError) {
      setError(getFriendlyErrorMessage(caughtError, 'Unable to refine the inside message.'))
      setCreditNotice('Your credits are still in your account.')
    } finally {
      setIsRefiningCopy(false)
      clearActionFeedback()
    }
  }

  const buildCurrentCardPayload = (coverImageUrl?: string) => {
    if (!card) {
      throw new Error('Create a card before delivering it.')
    }

    return {
      details,
      card: {
        imageUrl: coverImageUrl || card.imageUrl,
        message: cardMessage,
        closing: cardClosing,
      },
      greeting: insideGreeting,
      signature: cardSignatureLabel,
    }
  }

  const saveCurrentCard = async () => {
    let coverThumb = ''
    let storedCover = card!.imageUrl
    try {
      storedCover = await prepareCoverJpegForApi(card!.imageUrl, sharedCard?.id)
    } catch {
      storedCover = card!.imageUrl
    }
    try {
      coverThumb = await createCoverThumbDataUrl(storedCover, sharedCard?.id)
    } catch {
      coverThumb = ''
    }

    const response = await fetch(apiUrl('/api/cards'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...buildCurrentCardPayload(storedCover),
        ...(sharedCard?.id ? { cardId: sharedCard.id } : {}),
        ...(coverThumb ? { coverThumb } : {}),
      }),
    })
    const data = await getApiJson(response, 'Unable to save the card for delivery.')

    if (!response.ok) {
      throw new Error(data.error || 'Unable to save the card for delivery.')
    }

    const shared = data as SharedCard
    const normalized: SharedCard = isLocalApiDev
      ? { ...shared, shareUrl: localShareUrl(shared.id) }
      : shared
    setSharedCard(normalized)
    return normalized
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

  const saveAccountSession = (session: {
    token: string
    phoneE164: string
    copyEmail?: string
    preferredName?: string
    mailingAddress?: MailingAddress | null
  }) => {
    setAccountSession(session)
    window.localStorage.setItem(
      accountSessionStorageKey,
      JSON.stringify({
        token: session.token,
        phoneE164: session.phoneE164,
        copyEmail: session.copyEmail,
      }),
    )
    if (session.copyEmail) {
      setSenderCopyEmail((current) => current || session.copyEmail || '')
      setPrintShopperEmail((current) => current || session.copyEmail || '')
    }
    if (typeof session.preferredName === 'string') {
      setAccountPreferredName(session.preferredName.trim())
    }
  }

  const dismissPreferredNamePrompt = (phoneE164: string) => {
    setShowPreferredNamePrompt(false)
    setPreferredNamePromptDraft('')
    try {
      window.localStorage.setItem(preferredNamePromptStorageKey(phoneE164), '1')
    } catch {
      // Ignore storage failures.
    }
  }

  const savePreferredNameFromPrompt = async () => {
    if (!accountSession?.token) {
      return
    }
    const name = preferredNamePromptDraft.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!name) {
      return
    }

    setIsSavingPreferredNamePrompt(true)
    try {
      const response = await fetch(apiUrl('/api/account/profile'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accountSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ preferredName: name }),
      })
      const data = await getApiJson(response, 'Unable to save your name.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to save your name.')
      }
      const savedName = String(data.preferredName || name).trim()
      setAccountPreferredName(savedName)
      setAccountSession((current) => (current ? { ...current, preferredName: savedName } : current))
      dismissPreferredNamePrompt(accountSession.phoneE164)
    } catch (caughtError) {
      setCreditNotice(caughtError instanceof Error ? caughtError.message : 'Unable to save your name.')
    } finally {
      setIsSavingPreferredNamePrompt(false)
    }
  }

  const applySavedMailingAddressToPrint = (address?: MailingAddress | null) => {
    if (!address || isMailingAddressBlank(address)) {
      return
    }
    setPrintMailFrom((current) => (isDefaultPrintMailFromAddress(current) ? address : current))
  }

  const saveAccountProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accountSession?.token) {
      return
    }

    const emailTrimmed = accountProfileEmail.trim()
    if (emailTrimmed) {
      const validatedEmail = validateEmailAddress(emailTrimmed)
      if (!validatedEmail.ok) {
        setAccountProfileNotice(validatedEmail.message)
        return
      }
    }

    const blankAddress = isMailingAddressBlank(accountProfileMailing)
    const nameOnly =
      !blankAddress &&
      Boolean(accountProfileMailing.name.trim()) &&
      !accountProfileMailing.line1.trim() &&
      !accountProfileMailing.line2.trim() &&
      !accountProfileMailing.city.trim() &&
      !accountProfileMailing.state.trim() &&
      !accountProfileMailing.zip.trim()
    let mailingPayload: MailingAddress | null = null
    if (nameOnly) {
      mailingPayload = {
        ...emptyMailingAddress(),
        name: accountProfileMailing.name.trim(),
      }
    } else if (!blankAddress) {
      const validatedAddress = validateMailingAddress(accountProfileMailing, 'mailing')
      if (!validatedAddress.ok) {
        setAccountProfileNotice(validatedAddress.message)
        return
      }
      mailingPayload = validatedAddress.value
    }

    setIsSavingAccountProfile(true)
    setAccountProfileNotice('')
    try {
      const response = await fetch(apiUrl('/api/account/profile'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accountSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: emailTrimmed,
          preferredName: accountPreferredName.trim(),
          mailingAddress: mailingPayload,
        }),
      })
      const data = await getApiJson(response, 'Unable to save your details.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to save your details.')
      }

      const savedEmail = String(data.email || emailTrimmed || '')
      const savedPreferredName = String(data.preferredName || accountPreferredName || '').trim()
      const savedMailing = normalizeResumeMailingAddress(
        data.mailingAddress,
        mailingPayload || emptyMailingAddress(),
      )
      const hasMailing = !isMailingAddressBlank(savedMailing)
      setAccountProfileEmail(savedEmail)
      setAccountPreferredName(savedPreferredName)
      setAccountProfileMailing(hasMailing ? savedMailing : emptyMailingAddress())
      setAccountHistory((current) =>
        current
          ? {
              ...current,
              account: {
                ...(current.account || {}),
                email: savedEmail,
                preferredName: savedPreferredName,
                mailingAddress: hasMailing ? savedMailing : null,
              },
            }
          : current,
      )
      saveAccountSession({
        token: accountSession.token,
        phoneE164: accountSession.phoneE164,
        copyEmail: savedEmail,
        preferredName: savedPreferredName,
        mailingAddress: hasMailing ? savedMailing : null,
      })
      if (savedPreferredName) {
        setShowPreferredNamePrompt(false)
        try {
          window.localStorage.setItem(preferredNamePromptStorageKey(accountSession.phoneE164), '1')
        } catch {
          // Ignore storage failures.
        }
      }
      if (hasMailing) {
        applySavedMailingAddressToPrint(savedMailing)
      }
      setAccountProfileNotice('Saved.')
    } catch (caughtError) {
      setAccountProfileNotice(
        caughtError instanceof Error ? caughtError.message : 'Unable to save your details.',
      )
    } finally {
      setIsSavingAccountProfile(false)
    }
  }

  const requestAccountCode = async () => {
    const validated = validatePhoneNumber(accountPhone)
    if (!validated.ok) {
      if (showAccountPage) {
        setAccountHistoryError(validated.message)
      } else {
        setDeliveryNotice(validated.message)
      }
      return
    }

    setIsSendingAccountCode(true)
    showActionFeedback('Sending sign-in code…')
    setDeliveryNotice('')
    setAccountHistoryError('')

    try {
      const response = await fetch(apiUrl('/api/auth/otp/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: validated.value }),
      })
      const data = await getApiJson(response, 'Unable to send a sign-in code.')
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send a sign-in code.')
      }

      setAccountPhone(formatPhoneNumberDisplay(String(data.phoneE164 || validated.value)))
      const notice = data.message || 'We texted you a 6-digit code.'
      if (showAccountPage) {
        setAccountHistoryError(notice)
      } else {
        setDeliveryNotice(notice)
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Unable to send a sign-in code.'
      if (showAccountPage) {
        setAccountHistoryError(message)
      } else {
        setDeliveryNotice(message)
      }
    } finally {
      setIsSendingAccountCode(false)
      clearActionFeedback()
    }
  }

  const verifyAccountCode = async () => {
    const validated = validatePhoneNumber(accountPhone)
      if (!validated.ok) {
        if (showAccountPage) {
          setAccountHistoryError(validated.message)
        } else {
          setDeliveryNotice(validated.message)
        }
        return
      }

      if (!/^\d{6}$/.test(accountCode.trim())) {
        const message = 'Enter the 6-digit code from the text message.'
        if (showAccountPage) {
          setAccountHistoryError(message)
        } else {
          setDeliveryNotice(message)
        }
        return
      }

      setIsVerifyingAccountCode(true)
      showActionFeedback('Confirming your number…')
      setDeliveryNotice('')
      setAccountHistoryError('')

    try {
      const response = await fetch(apiUrl('/api/auth/otp/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: validated.value, code: accountCode.trim() }),
      })
      const data = await getApiJson(response, 'Unable to confirm that code.')
      if (!response.ok || !data.token) {
        throw new Error(data.error || 'Unable to confirm that code.')
      }

      const token = String(data.token)
      const signingInFromAccount = showAccountPage
      const preferredName = String(data.preferredName || '').trim()
      saveAccountSession({
        token,
        phoneE164: String(data.phoneE164 || validated.value),
        copyEmail: String(data.email || ''),
        preferredName,
      })
      setAccountPreferredName(preferredName)
      if (parseCreditBalance(data.creditBalance) !== null) {
        rememberCredits(parseCreditBalance(data.creditBalance) as number)
      }
      setAccountCode('')
      const bonusCredits = Number(data.phoneVerifyBonusCredits) || 0
      const registrationMessage =
        data.isNew && bonusCredits > 0
          ? `Your number is confirmed. We added ${bonusCredits} credits for registering.`
          : data.message || 'Your number is confirmed. You can send the card.'
      if (signingInFromAccount) {
        setAccountHistoryError('')
        setCreditNotice(registrationMessage)
        await loadAccountHistory(token)
      } else {
        setDeliveryNotice(registrationMessage)
        if (data.isNew && bonusCredits > 0) {
          setCreditNotice(`+${bonusCredits} credits for confirming your mobile number.`)
        }
      }
      if (!preferredName) {
        try {
          const dismissed =
            window.localStorage.getItem(
              preferredNamePromptStorageKey(String(data.phoneE164 || validated.value)),
            ) === '1'
          if (!dismissed) {
            setPreferredNamePromptDraft('')
            setShowPreferredNamePrompt(true)
          }
        } catch {
          setPreferredNamePromptDraft('')
          setShowPreferredNamePrompt(true)
        }
      } else {
        setShowPreferredNamePrompt(false)
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Unable to confirm that code.'
      if (showAccountPage) {
        setAccountHistoryError(message)
      } else {
        setDeliveryNotice(message)
      }
    } finally {
      setIsVerifyingAccountCode(false)
      clearActionFeedback()
    }
  }

  const updateDeliveryDestination = (index: number, value: string) => {
    setDeliveryDestinations((current) => current.map((entry, entryIndex) => (entryIndex === index ? value : entry)))
    setDeliveryNotice('')
  }

  const removeDeliveryDestination = (index: number) => {
    setDeliveryDestinations((current) => {
      if (current.length <= 1) {
        return ['']
      }

      return current.filter((_, entryIndex) => entryIndex !== index)
    })
    setDeliveryNotice('')
  }

  const addDeliveryDestination = () => {
    if (deliveryDestinations.length >= maxDeliveryRecipients) {
      setDeliveryNotice(`You can send to up to ${maxDeliveryRecipients} recipients at a time.`)
      return
    }

    const lastEntry = deliveryDestinations[deliveryDestinations.length - 1]?.trim() || ''
    if (lastEntry) {
      if (deliveryMethod === 'email') {
        const validated = validateEmailAddress(lastEntry)
        if (!validated.ok) {
          setDeliveryNotice(validated.message)
          return
        }
        setDeliveryDestinations((current) => [
          ...current.slice(0, -1),
          validated.value,
          '',
        ])
      } else {
        const validated = validatePhoneNumber(lastEntry)
        if (!validated.ok) {
          setDeliveryNotice(validated.message)
          return
        }
        setDeliveryDestinations((current) => [
          ...current.slice(0, -1),
          validated.display,
          '',
        ])
      }
    } else {
      setDeliveryDestinations((current) => [...current, ''])
    }

    setDeliveryNotice('')
  }

  const resetDeliveryDestinations = () => {
    setDeliveryDestinations([''])
  }

  const deliverCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setDeliveryNotice('')

    const rawEntries = deliveryDestinations.map((entry) => entry.trim()).filter(Boolean)

    if (!rawEntries.length) {
      setDeliveryNotice(
        deliveryMethod === 'email'
          ? 'Enter the recipient email address.'
          : 'Enter the recipient cellphone number.',
      )
      return
    }

    if (rawEntries.length > maxDeliveryRecipients) {
      setDeliveryNotice(`You can send to up to ${maxDeliveryRecipients} recipients at a time.`)
      return
    }

    const validatedDestinations: Array<{ value: string; display: string }> = []
    const seen = new Set<string>()

    for (const entry of rawEntries) {
      if (deliveryMethod === 'email') {
        const validated = validateEmailAddress(entry)
        if (!validated.ok) {
          setDeliveryNotice(validated.message)
          return
        }
        if (seen.has(validated.value)) {
          continue
        }
        seen.add(validated.value)
        validatedDestinations.push({ value: validated.value, display: validated.value })
      } else {
        const validated = validatePhoneNumber(entry)
        if (!validated.ok) {
          setDeliveryNotice(validated.message)
          return
        }
        if (seen.has(validated.value)) {
          continue
        }
        seen.add(validated.value)
        validatedDestinations.push({ value: validated.value, display: validated.display })
      }
    }

    if (!validatedDestinations.length) {
      setDeliveryNotice(
        deliveryMethod === 'email'
          ? 'Enter the recipient email address.'
          : 'Enter the recipient cellphone number.',
      )
      return
    }

    setDeliveryDestinations(validatedDestinations.map((entry) => entry.display))

    if (deliveryMethod === 'text' && !smsConsentConfirmed) {
      setDeliveryNotice(
        validatedDestinations.length > 1
          ? 'Confirm each recipient agreed to receive this one-time card delivery text.'
          : 'Confirm the recipient agreed to receive this one-time card delivery text.',
      )
      return
    }

    let senderCopyValue = ''

    if (showSenderCopyField && senderCopyEmail.trim()) {
      const validatedSenderCopy = validateEmailAddress(senderCopyEmail)

      if (!validatedSenderCopy.ok) {
        setDeliveryNotice(validatedSenderCopy.message)
        return
      }

      senderCopyValue = validatedSenderCopy.value
      setSenderCopyEmail(validatedSenderCopy.value)
    }

    if (!accountSession?.token) {
      setDeliveryNotice('Confirm your mobile number before sending. We’ll text you a one-time code.')
      return
    }

    const sendCost = getSendCreditCost(validatedDestinations.length)

    if (credits < sendCost) {
      promptNeedCredits(
        `You need ${sendCost} credits to send to ${validatedDestinations.length} recipient${
          validatedDestinations.length === 1 ? '' : 's'
        }. You currently have ${credits}. Buy more credits to keep going.`,
        'send',
      )
      return
    }

    setIsDelivering(true)
    showActionFeedback(
      plannedRecipientCount > 1 ? 'Sending your cards…' : 'Sending your card…',
    )
    let loggedDeliveryFailure = false

    try {
      const shared = await saveCurrentCard()
      const response = await fetch(apiUrl('/api/deliver-card'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accountSession.token}`,
        },
        body: JSON.stringify({
          cardId: shared.id,
          method: deliveryMethod,
          destinations: validatedDestinations.map((entry) => entry.value),
          recipientConsentConfirmed: deliveryMethod === 'text' ? smsConsentConfirmed : undefined,
          senderCopyEmail: senderCopyValue || undefined,
        }),
      })
      const data = await getApiJson(response, 'Unable to deliver the card.')

      if (!response.ok) {
        const failedResults = Array.isArray(data.results)
          ? (data.results as Array<{ destination?: string; status?: string; error?: string }>)
          : []
        for (const result of failedResults) {
          if (result.status !== 'failed') {
            continue
          }
          loggedDeliveryFailure = true
          addDeliveryLog({
            method: deliveryMethod,
            destination:
              deliveryMethod === 'email'
                ? formatEmailAddress(String(result.destination || ''))
                : formatPhoneNumberDisplay(String(result.destination || '')),
            status: 'Failed',
            message: result.error || data.error || 'Unable to deliver the card.',
          })
        }
        throw new Error(data.error || 'Unable to deliver the card.')
      }

      const results = Array.isArray(data.results)
        ? (data.results as Array<{ destination?: string; status?: string; error?: string }>)
        : []
      const sentResults = results.filter((result) => result.status === 'sent')
      const failedResults = results.filter((result) => result.status === 'failed')
      const deliveredCount =
        typeof data.deliveredCount === 'number'
          ? data.deliveredCount
          : sentResults.length || validatedDestinations.length
      const chargedCredits = getSendCreditCost(deliveredCount)

      for (const result of sentResults) {
        addDeliveryLog({
          method: deliveryMethod,
          destination:
            deliveryMethod === 'email'
              ? formatEmailAddress(String(result.destination || ''))
              : formatPhoneNumberDisplay(String(result.destination || '')),
          status: 'Sent',
          message: 'Card has been sent.',
        })
      }

      for (const result of failedResults) {
        addDeliveryLog({
          method: deliveryMethod,
          destination:
            deliveryMethod === 'email'
              ? formatEmailAddress(String(result.destination || ''))
              : formatPhoneNumberDisplay(String(result.destination || '')),
          status: 'Failed',
          message: result.error || 'Unable to deliver the card.',
        })
      }

      if (!sentResults.length && deliveredCount > 0) {
        const fallbackDisplay =
          deliveryMethod === 'email'
            ? formatEmailAddress(String(data.deliveredTo || validatedDestinations[0].value))
            : formatPhoneNumberDisplay(String(data.deliveredTo || validatedDestinations[0].value))
        addDeliveryLog({
          method: deliveryMethod,
          destination: fallbackDisplay,
          status: 'Sent',
          message: data.message || 'Card has been sent.',
        })
      }

      const notice =
        typeof data.message === 'string' && data.message
          ? data.message
          : deliveredCount === 1
            ? `Card sent to ${
                deliveryMethod === 'email'
                  ? formatEmailAddress(String(data.deliveredTo || validatedDestinations[0].display))
                  : formatPhoneNumberDisplay(String(data.deliveredTo || validatedDestinations[0].display))
              }.`
            : `Card sent to ${deliveredCount} recipients.`

      setDeliveryNotice(notice)
      resetDeliveryDestinations()
      setHasSentCurrentCard(true)
      const nextCredits = rememberCredits(credits - chargedCredits)
      setCreditNotice(
        chargedCredits === 1
          ? '1 credit used to send this card.'
          : `${chargedCredits} credits used to send this card.`,
      )
      void syncAccountCredits({ balance: nextCredits, reason: 'card_send' })
      if (senderCopyValue) {
        setShowSenderCopyField(false)
        saveAccountSession({
          token: accountSession.token,
          phoneE164: accountSession.phoneE164,
          copyEmail: senderCopyValue,
        })
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Unable to deliver the card.'
      setDeliveryNotice(message)
      if (!loggedDeliveryFailure) {
        addDeliveryLog({
          method: deliveryMethod,
          destination: validatedDestinations.map((entry) => entry.display).join(', '),
          status: 'Failed',
          message,
        })
      }
    } finally {
      setIsDelivering(false)
      clearActionFeedback()
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-section">
        {isRecipientView ? (
          <a className="brand brand-split" href="/" aria-label="Card Genie home">
            <img
              className="brand-mark"
              src={`${import.meta.env.BASE_URL}logo-mark.png`}
              width={72}
              height={72}
              alt=""
            />
            <span className="brand-wordmark">Card Genie</span>
          </a>
        ) : (
          <div className="brand brand-split">
            <button
              className={`brand-mark-button${startingInterviewMode === 'chat' ? ' is-starting' : ''}`}
              type="button"
              onClick={() => openCardInterview('chat')}
              aria-label="Chat with Genie about your card"
              title="Chat with Genie"
              aria-busy={startingInterviewMode === 'chat'}
            >
              <img
                className="brand-mark"
                src={`${import.meta.env.BASE_URL}logo-mark.png`}
                width={72}
                height={72}
                alt=""
              />
            </button>
            <a className="brand-wordmark-link" href="/" aria-label="Card Genie home">
              <span className="brand-wordmark">Card Genie</span>
            </a>
          </div>
        )}
        <a
          className="brand-powered"
          href="https://www.greetingcarduniverse.com"
          target="_blank"
          rel="noreferrer"
        >
          Powered by GreetingCardUniverse.com
        </a>
        {actionFeedback ? (
          <div className="action-feedback-toast" role="status" aria-live="polite">
            <span className="action-feedback-spinner" aria-hidden="true" />
            <span>{actionFeedback}</span>
          </div>
        ) : null}
        {isRecipientView && (
          <h1 className={`recipient-headline ${recipientHeadlineSize}`.trim()}>
            You received a card from {senderLabel}
          </h1>
        )}
        {!isRecipientView && (
          <div className="credit-wallet-block">
            <p
              className={`wallet-kicker${
                /need .+ credits?/i.test(creditNotice) ? ' is-credit-need' : ''
              }`.trim()}
            >
              {creditNotice ||
                (details.senderName.trim()
                  ? `Welcome back, ${details.senderName.trim()}. Ready to make another card?`
                  : 'Ready to make your next card?')}
            </p>
            <div className="credit-wallet" aria-label="Wish balance">
              <div>
                <strong>{creditsSummary}</strong>
                <small>
                  Creating a card is free. Click here for{' '}
                  <button
                    className="text-action-link credit-details-toggle"
                    type="button"
                    aria-expanded={showCreditDetails}
                    onClick={() => setShowCreditDetails((current) => !current)}
                  >
                    more details.
                  </button>
                </small>
              </div>
              <div className="credit-buy">
                <div className="credit-buy-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={isLoadingAccountHistory}
                    aria-busy={isLoadingAccountHistory}
                    onClick={() => void openAccountPage()}
                  >
                    {isLoadingAccountHistory ? 'Loading account...' : accountButtonLabel}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    aria-expanded={showCreditMenu}
                    disabled={isOpeningCheckout}
                    aria-busy={isOpeningCheckout}
                    onClick={() => setShowCreditMenu((current) => !current)}
                  >
                    {isOpeningCheckout ? 'Opening secure checkout...' : 'Buy more credits'}
                  </button>
                </div>
                {showCreditMenu && (
                  <div className="credit-menu" role="menu" aria-label="Credit packs">
                    {creditPacks.map((pack) => (
                      <button
                        key={pack.id}
                        type="button"
                        role="menuitem"
                        onClick={() => void buyCreditPack(pack)}
                      >
                        {pack.credits} credits — ${pack.price}
                      </button>
                    ))}
                  </div>
                )}
                {(isAdmin || isLocalApiDev) && (
                  <p className="credit-dev-links">
                    Set credits:
                    <button type="button" onClick={() => setCreditBalance(0)}>
                      0
                    </button>
                    <button type="button" onClick={() => setCreditBalance(1)}>
                      1
                    </button>
                    <button type="button" onClick={() => setCreditBalance(2)}>
                      2
                    </button>
                    <button type="button" onClick={() => setCreditBalance(25)}>
                      25
                    </button>
                    <button type="button" onClick={() => setCreditBalance(50)}>
                      50
                    </button>
                  </p>
                )}
              </div>
            </div>
            {showCreditDetails && (
              <div className="credit-details-panel" role="region" aria-label="Credit details">
                <button
                  className="credit-details-close"
                  type="button"
                  aria-label="Close credit details"
                  onClick={() => setShowCreditDetails(false)}
                >
                  ×
                </button>
                <ul>
                  <li>You start with 2 credits on this device.</li>
                  <li>Sign in with your mobile number to get 2 more and keep credits across devices.</li>
                  <li>Sending a card uses 3 credits (2 more for each extra recipient).</li>
                  <li>Cover changes and AI text changes use 1 credit each.</li>
                  <li>Mailing a printed card uses {printCardCreditCost} credits.</li>
                </ul>
              </div>
            )}
            {isSignedIn && showPreferredNamePrompt && !accountPreferredName.trim() && (
              <div className="preferred-name-prompt" aria-label="What should we call you">
                <p>What should we call you?</p>
                <div className="preferred-name-prompt-row">
                  <input
                    type="text"
                    autoComplete="given-name"
                    value={preferredNamePromptDraft}
                    onChange={(event) => setPreferredNamePromptDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void savePreferredNameFromPrompt()
                      }
                    }}
                    placeholder="Example: Mindy"
                    maxLength={60}
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={isSavingPreferredNamePrompt || !preferredNamePromptDraft.trim()}
                    onClick={() => void savePreferredNameFromPrompt()}
                  >
                    {isSavingPreferredNamePrompt ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className="text-action-link"
                    type="button"
                    onClick={() => dismissPreferredNamePrompt(accountSession?.phoneE164 || '')}
                  >
                    Not now
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {showAccountPage && !isRecipientView && (
        <section className="account-page" aria-label="My account">
          <div className="panel-heading">
            <div>
              <h2>My account</h2>
              <p>Credits, cards, and sends for this phone number.</p>
            </div>
            <button className="secondary-button account-back" type="button" onClick={() => setShowAccountPage(false)}>
              Back to card
            </button>
          </div>
          {!accountSession && (
            <div className="account-gate">
              <span className="field-title">Sign in</span>
              <p className="field-help">
                Enter your mobile number. We’ll text a one-time code so you can open this account. New accounts get 2
                extra credits when you confirm.
              </p>
              <label>
                Mobile number
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={accountPhone}
                  onChange={(event) => setAccountPhone(event.target.value)}
                  placeholder="(925) 555-1234"
                />
              </label>
              <div className="account-code-row">
                <label>
                  Text code
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={accountCode}
                    onChange={(event) => setAccountCode(event.target.value)}
                    placeholder="6-digit code"
                  />
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isSendingAccountCode}
                  onClick={() => void requestAccountCode()}
                >
                  {isSendingAccountCode ? 'Sending code...' : 'Text me a code'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isVerifyingAccountCode || !accountCode.trim()}
                  onClick={() => void verifyAccountCode()}
                >
                  {isVerifyingAccountCode ? 'Checking...' : 'Confirm number'}
                </button>
              </div>
            </div>
          )}
          {isLoadingAccountHistory && <p>Loading your account...</p>}
          {accountHistoryError && <div className="field-notice">{accountHistoryError}</div>}
          {accountSession && accountHistory && (
            <>
              {isAdmin && (
                <div className="account-block admin-links">
                  <h3>Admin</h3>
                  <div className="admin-link-row">
                    <button className="text-action-link" type="button" onClick={() => void openAdminAnalytics()}>
                      Analytics
                    </button>
                    <button className="text-action-link" type="button" onClick={() => void openAdminReviews()}>
                      Reviews
                    </button>
                  </div>
                  <form
                    className="admin-grant-credits"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void grantCreditsToPhone()
                    }}
                  >
                    <button
                      className="text-action-link admin-grant-toggle"
                      type="button"
                      aria-expanded={showAdminGrantCredits}
                      onClick={() => {
                        setShowAdminGrantCredits((current) => !current)
                        setAdminGrantNotice('')
                      }}
                    >
                      Grant credits to shoppers
                    </button>
                    {showAdminGrantCredits && (
                      <>
                        <p className="field-help">Add credits to any confirmed Card Genie phone number.</p>
                        <div className="admin-grant-row">
                          <label>
                            Phone number
                            <input
                              type="tel"
                              inputMode="tel"
                              autoComplete="tel"
                              value={adminGrantPhone}
                              onChange={(event) => {
                                setAdminGrantPhone(event.target.value)
                                setAdminGrantNotice('')
                              }}
                              onBlur={() => {
                                if (!adminGrantPhone.trim()) {
                                  return
                                }
                                const validated = validatePhoneNumber(adminGrantPhone)
                                if (validated.ok) {
                                  setAdminGrantPhone(validated.display)
                                }
                              }}
                              placeholder="(925) 555-1234"
                            />
                          </label>
                          <label>
                            Credits
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={500}
                              value={adminGrantCredits}
                              onChange={(event) => {
                                setAdminGrantCredits(event.target.value)
                                setAdminGrantNotice('')
                              }}
                            />
                          </label>
                          <button
                            className="secondary-button"
                            type="submit"
                            disabled={isGrantingCredits || !adminGrantPhone.trim()}
                          >
                            {isGrantingCredits ? 'Granting…' : 'Grant'}
                          </button>
                        </div>
                        {adminGrantNotice && <p className="admin-grant-notice">{adminGrantNotice}</p>}
                      </>
                    )}
                  </form>
                </div>
              )}
              <div className="account-block account-profile-block">
                <h3>Your details</h3>
                <p className="field-help">
                  First name is for greetings like “Hi Mindy.” Email and mailing address are saved for order
                  confirmations and as the default return address on printed cards. Email is also filled the first time
                  you use Send me a copy.
                </p>
                <form className="account-profile-form" onSubmit={(event) => void saveAccountProfile(event)}>
                  <label>
                    First name
                    <input
                      type="text"
                      autoComplete="given-name"
                      value={accountPreferredName}
                      onChange={(event) => {
                        setAccountPreferredName(event.target.value)
                        setAccountProfileNotice('')
                      }}
                      placeholder="Example: Mindy"
                      maxLength={60}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={accountProfileEmail}
                      onChange={(event) => {
                        setAccountProfileEmail(event.target.value)
                        setAccountProfileNotice('')
                      }}
                      onBlur={() => {
                        const trimmed = accountProfileEmail.trim()
                        if (!trimmed) {
                          return
                        }
                        const validated = validateEmailAddress(trimmed)
                        if (validated.ok) {
                          setAccountProfileEmail(validated.value)
                        }
                      }}
                      placeholder="you@example.com"
                    />
                  </label>
                  {renderMailingAddressFields('account', accountProfileMailing, 'Mailing name')}
                  <div className="account-profile-actions">
                    <button
                      className="secondary-button"
                      type="submit"
                      disabled={isSavingAccountProfile}
                    >
                      {isSavingAccountProfile ? 'Saving…' : 'Save details'}
                    </button>
                    {accountProfileNotice && (
                      <p
                        className={
                          accountProfileNotice === 'Saved.'
                            ? 'account-profile-notice is-success'
                            : 'account-profile-notice'
                        }
                      >
                        {accountProfileNotice}
                      </p>
                    )}
                  </div>
                </form>
              </div>
              <div className="account-summary">
                <div>
                  <span>Credits now</span>
                  <strong>{accountHistory.account?.creditBalance ?? credits}</strong>
                </div>
                <div>
                  <span>Purchased</span>
                  <strong>{accountHistory.account?.creditsPurchased ?? 0}</strong>
                </div>
                <div>
                  <span>Spent</span>
                  <strong>{accountHistory.account?.creditsSpent ?? 0}</strong>
                </div>
                <div>
                  <span>Phone</span>
                  <strong>{formatPhoneNumberDisplay(accountHistory.phoneE164 || accountSession?.phoneE164 || '')}</strong>
                </div>
              </div>
              <div className="account-block">
                <h3>Cards and sends</h3>
                {cardActivityItems.some((item) => item.coverThumbUrl) && (
                  <p className="account-thumb-hint">Hover or tap a row to preview the cover.</p>
                )}
                {cardActivityItems.length === 0 ? (
                  <p>No cards sent yet.</p>
                ) : (
                  <>
                    <div className="account-list">
                      {(showAllCardActivity
                        ? cardActivityItems
                        : cardActivityItems.slice(0, accountActivityPreviewLimit)
                      ).map((item) => (
                        <div
                          className={[
                            'account-row',
                            item.coverThumbUrl ? 'has-cover-thumb' : '',
                            activeCoverThumbId === item.id ? 'is-thumb-open' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          key={item.id}
                          role={item.coverThumbUrl ? 'button' : undefined}
                          tabIndex={item.coverThumbUrl ? 0 : undefined}
                          aria-expanded={item.coverThumbUrl ? activeCoverThumbId === item.id : undefined}
                          aria-label={
                            item.coverThumbUrl
                              ? activeCoverThumbId === item.id
                                ? `${item.title}. Hide cover preview.`
                                : `${item.title}. Show cover preview.`
                              : undefined
                          }
                          onClick={() => {
                            if (!item.coverThumbUrl) {
                              return
                            }
                            setActiveCoverThumbId((current) => (current === item.id ? null : item.id))
                          }}
                          onKeyDown={(event) => {
                            if (!item.coverThumbUrl) {
                              return
                            }
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setActiveCoverThumbId((current) => (current === item.id ? null : item.id))
                            }
                          }}
                        >
                          <span className="account-row-title">{item.title}</span>
                          <span className="account-row-detail">{item.detail}</span>
                          <span className="account-row-status">{item.status}</span>
                          <span className="account-row-date">{formatAccountDate(item.createdAt)}</span>
                          {item.coverThumbUrl ? (
                            <span className="account-row-thumb" aria-hidden="true">
                              <img
                                src={item.coverThumbUrl}
                                alt=""
                                loading="lazy"
                                onError={(event) => {
                                  const row = event.currentTarget.closest('.account-row')
                                  row?.classList.remove('has-cover-thumb', 'is-thumb-open')
                                  event.currentTarget.closest('.account-row-thumb')?.remove()
                                  setActiveCoverThumbId((current) => (current === item.id ? null : current))
                                }}
                              />
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {cardActivityItems.length > accountActivityPreviewLimit && (
                      <button
                        className="text-action-link account-more-link"
                        type="button"
                        onClick={() => setShowAllCardActivity((current) => !current)}
                      >
                        {showAllCardActivity
                          ? 'Show less'
                          : `Show ${cardActivityItems.length - accountActivityPreviewLimit} more`}
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="account-block">
                <h3>Credit activity</h3>
                {(accountHistory.creditEvents || []).length === 0 ? (
                  <p>No credit activity yet.</p>
                ) : (
                  <>
                    <div className="account-list">
                      {(showAllCreditEvents
                        ? accountHistory.creditEvents || []
                        : (accountHistory.creditEvents || []).slice(0, accountActivityPreviewLimit)
                      ).map((event, index) => (
                        <div className="account-row" key={`${event.createdAt}-${index}`}>
                          <span className="account-row-title">{event.label}</span>
                          <span className="account-row-detail">{creditEventDetail(event)}</span>
                          <span className="account-row-amount">
                            {event.creditsDelta > 0 ? `+${event.creditsDelta}` : event.creditsDelta}
                          </span>
                          <span className="account-row-date">{formatAccountDate(event.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                    {(accountHistory.creditEvents || []).length > accountActivityPreviewLimit && (
                      <button
                        className="text-action-link account-more-link"
                        type="button"
                        onClick={() => setShowAllCreditEvents((current) => !current)}
                      >
                        {showAllCreditEvents
                          ? 'Show less'
                          : `Show ${(accountHistory.creditEvents || []).length - accountActivityPreviewLimit} more`}
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="account-block">
                <h3>Printed cards</h3>
                {printOrderItems.some((item) => item.coverThumbUrl) && (
                  <p className="account-thumb-hint">Hover or tap a row to preview the cover.</p>
                )}
                {printOrderItems.length === 0 ? (
                  <p>No printed cards ordered yet.</p>
                ) : (
                  <>
                    <div className="account-list">
                      {(showAllPrintOrders
                        ? printOrderItems
                        : printOrderItems.slice(0, accountActivityPreviewLimit)
                      ).map((order) => (
                        <div
                          className={[
                            'account-row',
                            'account-print-order-row',
                            order.coverThumbUrl ? 'has-cover-thumb' : '',
                            activeCoverThumbId === order.id ? 'is-thumb-open' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          key={order.id}
                          role={order.coverThumbUrl ? 'button' : undefined}
                          tabIndex={order.coverThumbUrl ? 0 : undefined}
                          aria-expanded={order.coverThumbUrl ? activeCoverThumbId === order.id : undefined}
                          aria-label={
                            order.coverThumbUrl
                              ? activeCoverThumbId === order.id
                                ? `Order ${order.orderCode}. Hide cover preview.`
                                : `Order ${order.orderCode}. Show cover preview.`
                              : undefined
                          }
                          onClick={() => {
                            if (!order.coverThumbUrl) {
                              return
                            }
                            setActiveCoverThumbId((current) => (current === order.id ? null : order.id))
                          }}
                          onKeyDown={(event) => {
                            if (!order.coverThumbUrl) {
                              return
                            }
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setActiveCoverThumbId((current) => (current === order.id ? null : order.id))
                            }
                          }}
                        >
                          <span className="account-row-title">Order {order.orderCode}</span>
                          <span className="account-row-detail">{order.detail}</span>
                          <span className="account-row-status">{order.status}</span>
                          <span className="account-row-date">{formatAccountDate(order.createdAt)}</span>
                          {order.coverThumbUrl ? (
                            <span className="account-row-thumb" aria-hidden="true">
                              <img
                                src={order.coverThumbUrl}
                                alt=""
                                loading="lazy"
                                onError={(event) => {
                                  const row = event.currentTarget.closest('.account-row')
                                  row?.classList.remove('has-cover-thumb', 'is-thumb-open')
                                  event.currentTarget.closest('.account-row-thumb')?.remove()
                                  setActiveCoverThumbId((current) => (current === order.id ? null : current))
                                }}
                              />
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {printOrderItems.length > accountActivityPreviewLimit && (
                      <button
                        className="text-action-link account-more-link"
                        type="button"
                        onClick={() => setShowAllPrintOrders((current) => !current)}
                      >
                        {showAllPrintOrders
                          ? 'Show less'
                          : `Show ${printOrderItems.length - accountActivityPreviewLimit} more`}
                      </button>
                    )}
                  </>
                )}
              </div>
              {renderFeedbackPrompt('account')}
            </>
          )}
        </section>
      )}

      {adminView === 'analytics' && isAdmin && !isRecipientView && (
        <section className="account-page admin-page" aria-label="Site analytics">
          <div className="panel-heading">
            <div>
              <h2>Analytics</h2>
              <p>Today and all-time site activity.</p>
            </div>
            <div className="admin-page-actions">
              <button
                className="text-action-link"
                type="button"
                disabled={isLoadingAdminMetrics || !accountSession?.token}
                onClick={() => accountSession?.token && void loadAdminMetrics(accountSession.token)}
              >
                {isLoadingAdminMetrics ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                className="text-action-link"
                type="button"
                disabled={isBackfillingThumbs || !accountSession?.token}
                onClick={() => void runCoverThumbBackfill()}
              >
                {isBackfillingThumbs ? 'Backfilling thumbs…' : 'Backfill cover thumbs'}
              </button>
              <button className="secondary-button account-back" type="button" onClick={closeAdminView}>
                Back to account
              </button>
            </div>
          </div>
          {thumbBackfillNotice && <div className="field-notice">{thumbBackfillNotice}</div>}
          <div className="mode-toggle admin-metrics-periods" role="tablist" aria-label="Analytics period">
            {(
              [
                { id: 'today', label: 'Today' },
                { id: '7d', label: 'Last 7 days' },
                { id: '30d', label: 'Last 30 days' },
                { id: 'ytd', label: 'YTD' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                className={adminMetricsPeriod === tab.id ? 'is-selected' : ''}
                type="button"
                role="tab"
                aria-selected={adminMetricsPeriod === tab.id}
                disabled={isLoadingAdminMetrics || !accountSession?.token}
                onClick={() => void selectAdminMetricsPeriod(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {adminMetricsError && <div className="field-notice">{adminMetricsError}</div>}
          {isLoadingAdminMetrics && !adminMetrics && <p>Loading site analytics...</p>}
          {adminMetrics && (
            <div className="account-block admin-analytics">
              <p className="admin-analytics-note">
                {adminMetricsPeriod === 'today'
                  ? `Today (${adminMetrics.today}, Pacific).`
                  : adminMetricsPeriod === 'ytd'
                    ? `Year to date (${adminMetrics.rangeStart} – ${adminMetrics.rangeEnd}, Pacific).`
                    : `${adminMetrics.rangeStart} – ${adminMetrics.rangeEnd} (Pacific).`}{' '}
                Cards are recorded when first sent.
              </p>
              <div className="admin-stat-grid">
                <div>
                  <span>
                    Accounts {adminMetricsPeriodLabel}
                    <small> · Total {adminMetrics.totals?.accounts ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.accounts ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Sends {adminMetricsPeriodLabel}
                    <small> · Total {adminMetrics.totals?.sends ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.sends ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Cards {adminMetricsPeriodLabel}
                    <small> · Total {adminMetrics.totals?.cards ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.cards ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Logins {adminMetricsPeriodLabel}
                    <small> · Active 7d {adminMetrics.totals?.activeUsers7 ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.logins ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Thank-yous {adminMetricsPeriodLabel}
                    <small> · Total {adminMetrics.totals?.thankYous ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.thankYous ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Reviews {adminMetricsPeriodLabel}
                    <small>
                      {' '}
                      · Pending {adminMetrics.totals?.testimonialsPending ?? 0} · Total{' '}
                      {adminMetrics.totals?.testimonials ?? 0}
                    </small>
                  </span>
                  <strong>{adminPeriodStats.testimonials ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Credits spent {adminMetricsPeriodLabel}
                    <small> · Total {adminMetrics.totals?.creditsSpent ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.creditsSpent ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Credits bought {adminMetricsPeriodLabel}
                    <small> · Total {adminMetrics.totals?.creditsPurchased ?? 0}</small>
                  </span>
                  <strong>{adminPeriodStats.creditsPurchased ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Amount paid {adminMetricsPeriodLabel}
                    <small> · Total {formatAdminDollars(adminMetrics.totals?.amountPaid)}</small>
                  </span>
                  <strong>{formatAdminDollars(adminPeriodStats.amountPaid)}</strong>
                </div>
                <div>
                  <span>
                    Failed sends
                    <small> · All time</small>
                  </span>
                  <strong>{adminMetrics.totals?.failedSends ?? 0}</strong>
                </div>
                <div>
                  <span>
                    Active 30 days
                    <small> · Recent use</small>
                  </span>
                  <strong>{adminMetrics.totals?.activeUsers30 ?? 0}</strong>
                </div>
              </div>
              <div className="admin-daily-table-wrap">
                <table className="admin-daily-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Accounts</th>
                      <th>Sends</th>
                      <th>Logins</th>
                      <th>Thanks</th>
                      <th>Reviews</th>
                      <th className="admin-th-stack">
                        Credits
                        <br />
                        purchased
                      </th>
                      <th className="admin-th-stack">
                        Credits
                        <br />
                        spent
                      </th>
                      <th className="admin-th-stack">
                        Amount
                        <br />
                        paid
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(adminMetrics.daily?.sends || []).map((row, index) => (
                      <tr key={row.day}>
                        <td>{row.day.slice(5)}</td>
                        <td>{adminMetrics.daily?.accounts?.[index]?.count ?? 0}</td>
                        <td>{row.count}</td>
                        <td>{adminMetrics.daily?.logins?.[index]?.count ?? 0}</td>
                        <td>{adminMetrics.daily?.thankYous?.[index]?.count ?? 0}</td>
                        <td>{adminMetrics.daily?.testimonials?.[index]?.count ?? 0}</td>
                        <td>{adminMetrics.daily?.creditsPurchased?.[index]?.count ?? 0}</td>
                        <td>{adminMetrics.daily?.creditsSpent?.[index]?.count ?? 0}</td>
                        <td>
                          {formatAdminDollars(
                            ((adminMetrics.daily?.amountPaidCents?.[index]?.count ?? 0) as number) / 100,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {adminView === 'reviews' && isAdmin && !isRecipientView && (
        <section className="account-page admin-page" aria-label="Reviews">
          <div className="panel-heading">
            <div>
              <h2>Reviews</h2>
              <p>Approve reviews to show later, or hide ones you don’t want.</p>
            </div>
            <div className="admin-page-actions">
              <button
                className="text-action-link"
                type="button"
                disabled={isLoadingPendingReviews || !accountSession?.token}
                onClick={() => accountSession?.token && void loadAdminReviews(accountSession.token)}
              >
                {isLoadingPendingReviews ? 'Refreshing...' : 'Refresh'}
              </button>
              <button className="secondary-button account-back" type="button" onClick={closeAdminView}>
                Back to account
              </button>
            </div>
          </div>
          <div className="mode-toggle admin-review-filters" role="tablist" aria-label="Review status">
            {(
              [
                { id: 'pending', label: 'Pending' },
                { id: 'approved', label: 'Approved' },
                { id: 'rejected', label: 'Hidden' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                className={adminReviewStatus === tab.id ? 'is-selected' : ''}
                type="button"
                role="tab"
                aria-selected={adminReviewStatus === tab.id}
                disabled={isLoadingPendingReviews || !accountSession?.token}
                onClick={() => void selectAdminReviewStatus(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="account-block admin-reviews">
            {pendingReviewNotice && <div className="field-notice">{pendingReviewNotice}</div>}
            {isLoadingPendingReviews && pendingReviews.length === 0 ? (
              <p>Loading reviews...</p>
            ) : pendingReviews.length === 0 ? (
              <p>
                {adminReviewStatus === 'pending'
                  ? 'No reviews waiting for approval.'
                  : adminReviewStatus === 'approved'
                    ? 'No approved reviews yet.'
                    : 'No hidden reviews.'}
              </p>
            ) : (
              <div className="admin-review-list">
                {pendingReviews.map((review) => (
                  <div className="admin-review-card" key={review.id}>
                    <div className="admin-review-meta">
                      <strong>{review.name?.trim() || 'Anonymous'}</strong>
                      <span>
                        {review.rating ? `${review.rating}/5 · ` : ''}
                        {formatAccountDate(review.createdAt)}
                        {review.source ? ` · ${review.source}` : ''}
                      </span>
                    </div>
                    <p>{review.comment}</p>
                    <div className="feedback-actions">
                      {adminReviewStatus !== 'approved' && (
                        <button
                          className="primary-button"
                          type="button"
                          disabled={updatingReviewId === review.id}
                          onClick={() => void updatePendingReview(review.id, 'approved')}
                        >
                          {updatingReviewId === review.id ? 'Saving...' : 'Approve'}
                        </button>
                      )}
                      {adminReviewStatus !== 'rejected' && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={updatingReviewId === review.id}
                          onClick={() => void updatePendingReview(review.id, 'rejected')}
                        >
                          Hide
                        </button>
                      )}
                      {adminReviewStatus !== 'pending' && (
                        <button
                          className="text-action-link"
                          type="button"
                          disabled={updatingReviewId === review.id}
                          onClick={() => void updatePendingReview(review.id, 'pending')}
                        >
                          Move to pending
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <section className={`workspace ${isRecipientView ? 'recipient-workspace' : ''} ${showProofPanel ? '' : 'is-form-only'} ${showAccountPage || adminView ? 'is-hidden' : ''}`.trim()}>
        {!isRecipientView && (
          <form
            ref={createFormRef}
            className={`card-panel form-panel${highlightInvalidFields ? ' is-validated' : ''}`}
            noValidate
            onSubmit={generateCard}
          >
          <div className="panel-heading">
            <div>
              <h2>Tell us about the card</h2>
              <p>
                Fill in the fields, or{' '}
                <button className="text-action-link" type="button" onClick={() => openCardInterview('quick')}>
                  ask Genie
                </button>{' '}
                to fill in for you.
              </p>
            </div>
          </div>

          {showCardInterview && (
            <div
              className="card-interview-panel"
              aria-label={interviewMode === 'chat' ? 'Chat with Genie' : 'Ask Genie'}
            >
              <button
                className="card-interview-close"
                type="button"
                onClick={closeCardInterview}
                aria-label={interviewMode === 'chat' ? 'Close chat with Genie' : 'Close Ask Genie'}
              >
                ×
              </button>
              <div className="card-interview-thread" aria-live="polite" ref={interviewThreadRef}>
                {interviewMessages.map((entry, index) => (
                  <div
                    className={`card-interview-bubble is-${entry.role}`}
                    key={`${entry.role}-${index}-${entry.content.slice(0, 12)}`}
                  >
                    <span className="card-interview-role">
                      {entry.role === 'assistant'
                        ? interviewMode === 'chat'
                          ? 'Genie'
                          : 'Ask Genie'
                        : 'You'}
                    </span>
                    <p>{entry.content}</p>
                  </div>
                ))}
              </div>
              <label className="card-interview-compose">
                Your reply
                <textarea
                  className="card-interview-input"
                  rows={4}
                  value={interviewDraft}
                  disabled={isInterviewing || isInterviewSpeaking}
                  onChange={(event) => {
                    const value = event.target.value
                    interviewBaseDraftRef.current = value
                    interviewLatestDraftRef.current = value
                    setInterviewDraft(value)
                    if (interviewVoiceLoopRef.current) {
                      scheduleVoiceAutoSend()
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendCardInterview()
                    }
                  }}
                  placeholder={
                    isInterviewListening
                      ? 'Genie is listening. Pause when you finish a thought — or type here.'
                      : isInterviewSpeaking
                        ? 'Genie is speaking…'
                        : interviewVoiceLoop
                          ? 'Your turn is next — or type here while you wait.'
                          : "Example: I'd like to send a birthday card to Jamie from Alex and Sam for their surprise party last weekend. We had a great time, specially enjoyed the swimming and BBQing in the backyard."
                  }
                />
              </label>
              <div className="card-interview-actions">
                {pendingHearGenieText && interviewMode === 'chat' && !interviewComplete && (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={hearPendingGenie}
                  >
                    Hear Genie
                  </button>
                )}
                {interviewMicSupported && !interviewComplete && interviewMode === 'chat' && !pendingHearGenieText && (
                  <button
                    className={`secondary-button card-interview-mic${isInterviewListening ? ' is-listening' : ''}`}
                    type="button"
                    disabled={isInterviewing || isInterviewSpeaking}
                    aria-pressed={isInterviewListening}
                    onClick={() => {
                      if (isInterviewListening) {
                        stopInterviewListening()
                        setInterviewNotice('Mic paused. Tap Talk when you’re ready again.')
                      } else {
                        void (async () => {
                          if (microphoneAccessKnown !== 'granted' && !interviewMicStreamIsLive()) {
                            setInterviewNotice('Allow the microphone so Genie can hear you…')
                          }
                          const micAccess = await ensureMicrophoneAccess({
                            holdStream: preferStreamInterviewListen(),
                          })
                          if (micAccess === 'denied') {
                            setInterviewNotice(
                              'Microphone permission is needed to talk to Genie. You can still type your reply.',
                            )
                            return
                          }
                          interviewVoiceLoopRef.current = true
                          setInterviewVoiceLoop(true)
                          void unlockGenieSpeechAudio()
                          void acquireScreenStayAwake()
                          startInterviewListening({ announce: true })
                        })()
                      }
                    }}
                  >
                    {isInterviewListening ? 'Listening…' : 'Talk'}
                  </button>
                )}
                {interviewMicSupported && !interviewComplete && !interviewVoiceLoop && interviewMode !== 'chat' && (
                  <button
                    className={`secondary-button card-interview-mic${isInterviewListening ? ' is-listening' : ''}`}
                    type="button"
                    disabled={isInterviewing}
                    aria-pressed={isInterviewListening}
                    onClick={() => {
                      if (isInterviewListening) {
                        stopInterviewListening()
                        setInterviewNotice('Mic paused. Tap I’m done when your reply looks right.')
                      } else {
                        void (async () => {
                          setInterviewNotice('Allow the microphone so Genie can hear you…')
                          const micAccess = await ensureMicrophoneAccess({
                            holdStream: preferStreamInterviewListen(),
                          })
                          if (micAccess === 'denied') {
                            setInterviewNotice(
                              'Microphone permission is needed to talk to Genie. You can still type your reply.',
                            )
                            return
                          }
                          startInterviewListening({ announce: true })
                        })()
                      }
                    }}
                  >
                    {isInterviewListening ? 'Listening…' : 'Answer'}
                  </button>
                )}
                {!interviewComplete && !interviewVoiceLoop && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={isInterviewing || (!interviewDraft.trim() && !isInterviewListening)}
                    aria-busy={isInterviewing}
                    onClick={() => void sendCardInterview()}
                  >
                    {isInterviewing ? 'Genie is thinking…' : 'I’m done'}
                  </button>
                )}
                {interviewComplete && (
                  <button className="secondary-button" type="button" onClick={closeCardInterview}>
                    Hide {interviewMode === 'chat' ? 'Lamp Genie' : 'Ask Genie'}
                  </button>
                )}
                <button className="text-action-link" type="button" onClick={resetCardInterview}>
                  Start over
                </button>
              </div>
              {interviewMode === 'chat' && isAdmin && (
                <div className="card-interview-voice">
                  <div className="card-interview-voice-bar">
                    <p>
                      Lamp Genie voice: <strong>{lampGenieVoiceLabel(lampGenieVoice)}</strong>
                    </p>
                    <button
                      className="text-action-link"
                      type="button"
                      onClick={() => setShowLampVoicePicker((open) => !open)}
                    >
                      {showLampVoicePicker ? 'Hide voices' : 'Try voices'}
                    </button>
                  </div>
                  {showLampVoicePicker && (
                    <div className="card-interview-voice-picker" role="list">
                      {lampGenieVoiceOptions.map((option) => {
                        const isSelected = option.id === lampGenieVoice
                        const isPreviewing = previewingLampVoice === option.id
                        return (
                          <div
                            className={`card-interview-voice-option${isSelected ? ' is-selected' : ''}`}
                            key={option.id}
                            role="listitem"
                          >
                            <div>
                              <strong>{option.label}</strong>
                              <span>{option.blurb}</span>
                            </div>
                            <div className="card-interview-voice-option-actions">
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={Boolean(previewingLampVoice) || isInterviewing}
                                onClick={() => void previewLampGenieVoice(option.id)}
                              >
                                {isPreviewing ? 'Playing…' : 'Preview'}
                              </button>
                              <button
                                className="primary-button"
                                type="button"
                                disabled={isSelected}
                                onClick={() => chooseLampGenieVoice(option.id)}
                              >
                                {isSelected ? 'Selected' : 'Use this voice'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {interviewNotice && (
                <p
                  className={`card-interview-notice${
                    interviewComplete
                      ? ' is-success'
                      : isInterviewSpeaking
                        ? ' is-speaking'
                        : isInterviewListening
                          ? ' is-listening'
                          : ''
                  }`}
                >
                  {interviewNotice}
                </p>
              )}
              {prefersPhotoSave && interviewMode === 'chat' && !interviewComplete && (
                <p className="card-interview-stay-awake-hint">
                  On Chrome, Genie keeps one mic session for the whole chat. After you talk, wait a couple
                  seconds for your words to appear. Low Power Mode can still dim the screen.
                </p>
              )}
            </div>
          )}

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
              rows={9}
              value={details.keyDetails}
              onChange={(event) => updateDetails('keyDetails', event.target.value)}
              placeholder={
                'Add memories, interests, stories, or scene ideas for the card.\n\nPhysical traits (tall, green eyes, blonde hair, etc.) help draw people on the cover — they won\u2019t appear in the inside message.\n\nDescribe how people should look if you want them on the cover. Those details shape the artwork, not the inside note.'
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
                  {isAddingPhotos ? 'Adding photos...' : 'Add a photo'}
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

          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}

          {!card && (
            <button className="primary-button" type="submit" disabled={isGenerating} aria-busy={isGenerating}>
              {isGenerating ? 'Creating a little magic...' : 'Create this card'}
            </button>
          )}
          {isGenerating && (
            <p className="generate-scroll-hint">Your card is taking shape below.</p>
          )}
        </form>
        )}

        {showProofPanel && <section ref={previewPanelRef} className={`card-panel preview-panel ${isRecipientView ? 'recipient-preview-panel' : ''}`}>
          {!isRecipientView && (
            <div className="panel-heading proof-heading">
              <div>
                {showSendActions && !showEditor && (
                  <button className="secondary-button" type="button" onClick={replayAnimation}>
                    Watch the reveal again
                  </button>
                )}
                {showEditor && <h2>Revise your card</h2>}
              </div>
              {!isGenerating &&
                card &&
                showEditor &&
                editorHasChanges && (
                  <button
                    className="secondary-button revise-top-button"
                    type="button"
                    onClick={acceptEditorChanges}
                  >
                    Accept changes
                  </button>
                )}
            </div>
          )}

          {isGenerating && (
            <div className="creative-loader" role="status" aria-live="polite">
              <div className="wish-loader" aria-hidden="true">
                <div className="wish-halo" />
                <img className="wish-art" src={`${import.meta.env.BASE_URL}loader-wish.png`} alt="" />
                <svg className="wish-sparks" viewBox="0 0 500 814" fill="none">
                  <defs>
                    <filter id="spark-glow" x="-80%" y="-80%" width="260%" height="260%">
                      <feGaussianBlur stdDeviation="1.4" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id="wisp-blur" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="0.7" />
                    </filter>
                  </defs>
                  <g className="wisps" filter="url(#wisp-blur)">
                    <path className="wisp wisp-1" d="M70 572C110 532 145 507 125 477C90 447 75 427 100 402C170 367 310 357 400 307C445 272 430 247 350 220C240 190 125 177 132 137C140 97 230 67 285 30" />
                    <path className="wisp wisp-2" d="M82 570C122 527 158 500 138 472C102 442 88 422 114 396C182 360 322 350 412 300C456 266 440 240 360 214C250 184 138 170 145 130C154 90 242 60 296 26" />
                    <path className="wisp wisp-3" d="M58 574C96 538 132 514 112 484C78 454 64 434 88 408C158 374 298 364 388 314C434 280 418 254 338 226C228 196 114 184 120 144C128 106 218 74 274 36" />
                    <path className="wisp wisp-4" d="M100 402C170 367 310 357 400 307C445 272 430 247 350 220C240 190 125 177 132 137" />
                    <path className="wisp wisp-5" d="M68 580C88 552 120 527 118 500C110 480 88 470 78 457" />
                  </g>
                  <g className="sparks" filter="url(#spark-glow)">
                    <path className="spark spark-1" d="M248 24 249.3 28.7 254 30 249.3 31.3 248 36 246.7 31.3 242 30 246.7 28.7Z" />
                    <path className="spark spark-2" d="M286 100 287.5 105.5 293 107 287.5 108.5 286 114 284.5 108.5 279 107 284.5 105.5Z" />
                    <path className="spark spark-3" d="M214 166 215.8 172.2 222 174 215.8 175.8 214 182 212.2 175.8 206 174 212.2 172.2Z" />
                    <path className="spark spark-4" d="M304 244 305.5 249.5 311 251 305.5 252.5 304 258 302.5 252.5 297 251 302.5 249.5Z" />
                    <path className="spark spark-5" d="M236 324 237.3 328.7 242 330 237.3 331.3 236 336 234.7 331.3 230 330 234.7 328.7Z" />
                    <path className="spark spark-6" d="M318 400 319.8 406.2 326 408 319.8 409.8 318 416 316.2 409.8 310 408 316.2 406.2Z" />
                    <path className="spark spark-7" d="M176 470 177.1 473.9 181 475 177.1 476.1 176 480 174.9 476.1 171 475 174.9 473.9Z" />
                    <path className="spark spark-8" d="M252 670 253.3 674.7 258 676 253.3 677.3 252 682 250.7 677.3 246 676 250.7 674.7Z" />
                    <path className="spark spark-9" d="M348 704 349.1 707.9 353 709 349.1 710.1 348 714 346.9 710.1 343 709 346.9 707.9Z" />
                    <path className="spark spark-10" d="M152 644 153.3 648.7 158 650 153.3 651.3 152 656 150.7 651.3 146 650 150.7 648.7Z" />
                    <path className="spark spark-11" d="M268 48 269.1 51.9 273 53 269.1 54.1 268 58 266.9 54.1 263 53 266.9 51.9Z" />
                    <path className="spark spark-12" d="M228 220 228.9 223.1 232 224 228.9 224.9 228 228 227.1 224.9 224 224 227.1 223.1Z" />
                    <path className="spark spark-13" d="M292 340 293.3 344.7 298 346 293.3 347.3 292 352 290.7 347.3 286 346 290.7 344.7Z" />
                    <path className="spark spark-14" d="M210 408 211.5 413.5 217 415 211.5 416.5 210 422 208.5 416.5 203 415 208.5 413.5Z" />
                    <circle className="spark spark-15" cx="274" cy="142" r="2.2" />
                    <circle className="spark spark-16" cx="242" cy="282" r="1.8" />
                    <circle className="spark spark-17" cx="300" cy="462" r="1.7" />
                  </g>
                </svg>
              </div>
              <span className="loader-kicker">Creating a little magic</span>
              <h3 key={generationLines[activeGenerationStep]}>{generationLines[activeGenerationStep]}</h3>
              <p className="loader-note">This could take up to a minute. You can leave and come back, the card will be waiting for you.</p>
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
                      <span className="envelope-from">From {cardSignatureLabel}</span>
                      <span className={`envelope-front-address ${envelopeAddressSize}`.trim()}>
                        {envelopeAddress}
                      </span>
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
                      <span className="envelope-from">From {cardSignatureLabel}</span>
                      <span className={`envelope-front-address ${envelopeAddressSize}`.trim()}>
                        {envelopeAddress}
                      </span>
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
                  <div className="opening-stack">
                    <div className={`envelope envelope-static${step === 'opening' ? ' is-opening' : ''}`}>
                      <div className="envelope-back-face is-static">
                        <div className="envelope-back" />
                        <div className="envelope-body">
                          {step === 'opening' ? <small aria-hidden="true"></small> : null}
                        </div>
                      </div>
                      <div className="envelope-liner" />
                      <div className={`envelope-flap${step === 'opening' ? '' : ' envelope-flap-static'}`} />
                    </div>
                    {step === 'opening' && (
                      <div className={coverPreviewClass('envelope-card-rise')}>
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
                  <div className={coverPreviewClass('card-cover-frame')}>
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
                    <div className={coverPreviewClass('card-opening-cover')}>
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
              {!isRecipientView &&
                step === 'inside' &&
                card?.messageVariants?.short &&
                card.messageVariants.medium &&
                card.messageVariants.long && (
                  <div className="message-length-picker" aria-label="Message length">
                    <div className="mode-toggle message-length-toggle" role="group" aria-label="Choose message length">
                      {messageLengthChoices.map((choice) => (
                        <button
                          key={choice.id}
                          className={selectedMessageLengthId === choice.id ? 'is-selected' : ''}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            selectMessageLength(choice.id)
                          }}
                        >
                          {choice.label}
                        </button>
                      ))}
                    </div>
                    <p className="message-length-hint">
                      {isPrintOrderOpen ? (
                        <>
                          Printing uses the{' '}
                          <strong className="print-order-length-label">
                            {selectedMessageLengthLabel.toLowerCase()}
                          </strong>{' '}
                          message shown above.
                        </>
                      ) : (
                        'Message Length — pick the one you like.'
                      )}
                    </p>
                  </div>
                )}
              {showCoverWatermark &&
                !showEditor &&
                (step === 'front' || step === 'inside' || step === 'opening' || step === 'cardOpening') && (
                <p className="cover-watermark-note">
                  <span>A preview watermark is shown on the cover.</span>
                  <span>It will not appear on the card sent to your recipient.</span>
                </p>
              )}
              {isRecipientView && card && (step === 'front' || step === 'inside') && (
                <>
                  <div className="recipient-save-links" aria-label="Save card images">
                    <button
                      type="button"
                      disabled={isSavingImage}
                      aria-busy={isSavingImage}
                      onClick={() => void saveImageToDevice(card.imageUrl, coverDownloadName, 'Cover image')}
                    >
                      {isSavingImage ? 'Preparing…' : coverSaveLabel}
                    </button>
                    <span aria-hidden="true">|</span>
                    <button
                      type="button"
                      disabled={isSavingImage}
                      aria-busy={isSavingImage}
                      onClick={() => void saveImageToDevice(insideDownloadUrl, insideDownloadName, 'Inside image')}
                    >
                      {isSavingImage ? 'Preparing…' : insideSaveLabel}
                    </button>
                  </div>
                  {saveNotice && <p className="recipient-save-note">{saveNotice}</p>}
                </>
              )}

              {showSendActions && isRecipientView && (
                <div className="proof-actions">
                  <button className="secondary-button" type="button" onClick={replayAnimation}>
                    Watch the reveal again
                  </button>
                </div>
              )}
              {isRecipientView && (step === 'front' || step === 'inside') && (
                <aside className="recipient-invite" aria-label="Say thanks or make a card">
                  <div className="recipient-thanks">
                    <h3>Say thanks</h3>
                    {thankYouAlreadySent ? (
                      <p className="recipient-thanks-note" role="status">
                        {thankYouNotice || 'Your thank-you was already sent to the sender.'}
                      </p>
                    ) : thankYouAvailable ? (
                      <>
                        <p>Send a short thank-you to {senderLabel}. It’s free, and you can only send one.</p>
                        <div className="thank-you-presets" role="radiogroup" aria-label="Thank-you message">
                          {thankYouPresetsState.map((preset) => (
                            <label key={preset.id} className={selectedThankYouPreset === preset.id ? 'is-selected' : ''}>
                              <input
                                type="radio"
                                name="thank-you-preset"
                                value={preset.id}
                                checked={selectedThankYouPreset === preset.id}
                                onChange={() => setSelectedThankYouPreset(preset.id)}
                              />
                              <span>{preset.label}</span>
                            </label>
                          ))}
                        </div>
                        {thankYouPresetsState.find((preset) => preset.id === selectedThankYouPreset)?.allowsCustom && (
                          <label className="thank-you-custom">
                            Your message
                            <textarea
                              rows={3}
                              maxLength={thankYouCustomMaxLength}
                              value={customThankYouMessage}
                              onChange={(event) => setCustomThankYouMessage(event.target.value)}
                              placeholder="Example: Thank you so much — this meant a lot to me."
                            />
                            <small>
                              {customThankYouMessage.trim().length}/{thankYouCustomMaxLength}
                            </small>
                          </label>
                        )}
                        <button
                          className="primary-button"
                          type="button"
                          disabled={isSendingThankYou}
                          aria-busy={isSendingThankYou}
                          onClick={() => void sendThankYou()}
                        >
                          {isSendingThankYou ? 'Sending thank-you...' : 'Send thank-you'}
                        </button>
                        {thankYouNotice && (
                          <p className="recipient-thanks-note" role="status">
                            {thankYouNotice}
                          </p>
                        )}
                      </>
                    ) : (
                      <p>Want to go further? Make a thank-you card for {senderLabel}.</p>
                    )}
                    <a className="text-action-link" href={thankYouCardHref}>
                      Send a thank-you card
                    </a>
                  </div>
                  <div className="recipient-create">
                    <a className="secondary-button recipient-create-button" href="/">
                      <span className="recipient-create-kicker">Loved this card?</span>
                      <span className="recipient-create-label">Create your own</span>
                    </a>
                  </div>
                </aside>
              )}
              {showSendActions && !isRecipientView && !showEditor && showReviseButton && (
                <div className="proof-actions revise-actions">
                  {hasAcceptedRevision ? (
                    <button className="text-action-link" type="button" onClick={openEditor}>
                      Revise card again
                    </button>
                  ) : (
                    <button className="primary-button" type="button" onClick={openEditor}>
                      Revise card
                    </button>
                  )}
                  <button className="secondary-button" type="button" onClick={startNewCard}>
                    Start a new card
                  </button>
                </div>
              )}
              {showSendActions && !isRecipientView && <form className="delivery-panel" onSubmit={deliverCard}>
                <div>
                  <span className="delivery-kicker">Ready to send this card</span>
                  <p>Send by email or cellphone after you approve the card.</p>
                </div>
                <div className="mode-toggle delivery-methods" aria-label="Delivery method">
                  <button
                    className={deliveryMethod === 'email' ? 'is-selected' : ''}
                    type="button"
                    onClick={() => {
                      setDeliveryMethod('email')
                      resetDeliveryDestinations()
                      setShowSenderCopyField(false)
                      setSenderCopyEmail('')
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
                      resetDeliveryDestinations()
                      setShowSenderCopyField(false)
                      setSenderCopyEmail('')
                      setSmsConsentConfirmed(false)
                      setDeliveryNotice('')
                    }}
                  >
                    Cellphone
                  </button>
                </div>
                <div className="delivery-recipients">
                  {deliveryDestinations.map((destination, index) => (
                    <label key={`delivery-recipient-${index}`} className="delivery-recipient-field">
                      <span className="delivery-recipient-label-row">
                        <span>
                          {deliveryDestinations.length === 1
                            ? deliveryMethod === 'email'
                              ? 'Recipient email'
                              : 'Recipient cellphone'
                            : deliveryMethod === 'email'
                              ? `Recipient email ${index + 1}`
                              : `Recipient cellphone ${index + 1}`}
                        </span>
                        {deliveryDestinations.length > 1 && (
                          <button
                            className="text-action-link delivery-recipient-remove"
                            type="button"
                            onClick={() => removeDeliveryDestination(index)}
                          >
                            Remove
                          </button>
                        )}
                      </span>
                      <input
                        type={deliveryMethod === 'email' ? 'email' : 'tel'}
                        inputMode={deliveryMethod === 'email' ? 'email' : 'tel'}
                        autoComplete={deliveryMethod === 'email' ? 'email' : 'tel'}
                        value={destination}
                        onChange={(event) => updateDeliveryDestination(index, event.target.value)}
                        onBlur={() => {
                          if (!destination.trim()) {
                            return
                          }

                          if (deliveryMethod === 'email') {
                            const validated = validateEmailAddress(destination)

                            if (validated.ok) {
                              updateDeliveryDestination(index, validated.value)
                              setDeliveryNotice('')
                            } else {
                              setDeliveryNotice(validated.message)
                            }

                            return
                          }

                          const validated = validatePhoneNumber(destination)

                          if (validated.ok) {
                            updateDeliveryDestination(index, validated.display)
                            setDeliveryNotice('')
                          } else {
                            setDeliveryNotice(validated.message)
                          }
                        }}
                        placeholder={deliveryMethod === 'email' ? 'jamie@example.com' : '(925) 555-1234'}
                      />
                    </label>
                  ))}
                  {deliveryDestinations.length < maxDeliveryRecipients && (
                    <button className="text-action-link delivery-add-recipient" type="button" onClick={addDeliveryDestination}>
                      Add another recipient
                    </button>
                  )}
                </div>
                <label className="sender-copy">
                  <input
                    type="checkbox"
                    checked={showSenderCopyField}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setShowSenderCopyField(checked)
                      if (checked) {
                        setSenderCopyEmail((current) => current || accountSession?.copyEmail || '')
                      } else {
                        setSenderCopyEmail('')
                      }
                      setDeliveryNotice('')
                    }}
                  />
                  <span>Send me a copy</span>
                </label>
                {showSenderCopyField && (
                  <label>
                    <input
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      aria-label="Your email for a copy"
                      value={senderCopyEmail}
                      onChange={(event) => {
                        setSenderCopyEmail(event.target.value)
                        setDeliveryNotice('')
                      }}
                      onBlur={() => {
                        if (!senderCopyEmail.trim()) {
                          return
                        }

                        const validated = validateEmailAddress(senderCopyEmail)

                        if (validated.ok) {
                          setSenderCopyEmail(validated.value)
                          setDeliveryNotice('')
                        } else {
                          setDeliveryNotice(validated.message)
                        }
                      }}
                      placeholder="your-email@example.com"
                    />
                  </label>
                )}
                {deliveryMethod === 'text' && (
                  <label className="sms-consent">
                    <input
                      type="checkbox"
                      checked={smsConsentConfirmed}
                      onChange={(event) => setSmsConsentConfirmed(event.target.checked)}
                    />
                    <span>
                      Optional SMS delivery: I confirm{' '}
                      {plannedRecipientCount > 1 ? 'each recipient agreed' : 'this recipient agreed'} to receive a
                      one-time SMS/text message from Card Genie with a link to this card. Message frequency is one
                      message per card delivery request. Msg & data rates may apply. Reply STOP to cancel, HELP for
                      help. SMS consent is optional and is not required to create a card or use email delivery. See our{' '}
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
                {accountSession ? (
                  <p className="account-confirmed">
                    Your Phone# is Confirmed {formatPhoneNumberDisplay(accountSession.phoneE164)}
                  </p>
                ) : (
                  <>
                    <label className="sender-copy">
                      <input
                        type="checkbox"
                        checked={showAccountConfirm}
                        onChange={(event) => {
                          const checked = event.target.checked
                          setShowAccountConfirm(checked)
                          if (!checked) {
                            setAccountPhone('')
                            setAccountCode('')
                          }
                          setDeliveryNotice('')
                        }}
                      />
                      <span>Confirm my number</span>
                    </label>
                    {showAccountConfirm && (
                      <div className="account-gate">
                        <span className="field-title">Your mobile number</span>
                        <p className="field-help">
                          Confirm your number to send. We’ll text a one-time code. New accounts get 2 extra credits when
                          you confirm. Recipients will not see this number.
                        </p>
                        <label>
                          Mobile number
                          <input
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            value={accountPhone}
                            onChange={(event) => setAccountPhone(event.target.value)}
                            placeholder="(925) 555-1234"
                          />
                        </label>
                        <div className="account-code-row">
                          <label>
                            Text code
                            <input
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              value={accountCode}
                              onChange={(event) => setAccountCode(event.target.value)}
                              placeholder="6-digit code"
                            />
                          </label>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={isSendingAccountCode}
                            onClick={() => void requestAccountCode()}
                          >
                            {isSendingAccountCode ? 'Sending code...' : 'Text me a code'}
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={isVerifyingAccountCode || !accountCode.trim()}
                            onClick={() => void verifyAccountCode()}
                          >
                            {isVerifyingAccountCode ? 'Checking...' : 'Confirm number'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <div className="credit-action-block">
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={isDelivering || !accountSession || (deliveryMethod === 'text' && !smsConsentConfirmed)}
                    aria-busy={isDelivering}
                  >
                    {isDelivering
                      ? plannedRecipientCount > 1
                        ? 'Sending your cards...'
                        : 'Sending your card...'
                      : plannedRecipientCount > 1
                        ? `Send to ${plannedRecipientCount} · ${currentSendCreditCost} credits`
                        : `Send by ${deliveryMethod === 'email' ? 'email' : 'text'} · ${currentSendCreditCost} credits`}
                  </button>
                  {renderCreditsLeft()}
                </div>
                {sharedCard && isAdmin && (
                  <a className="share-link" href={sharedCard.shareUrl} target="_blank" rel="noreferrer">
                    Open shareable card link
                  </a>
                )}
                {isAdmin && card && !isRecipientView && showReviseButton && (
                  <div className="admin-print-test">
                    <button
                      className="text-action-link"
                      type="button"
                      disabled={isPreparingAdminPrintFiles}
                      onClick={() => void prepareAdminPrintFiles()}
                    >
                      {isPreparingAdminPrintFiles
                        ? 'Preparing print files…'
                        : 'Create print test files (1504×2096)'}
                    </button>
                    <span aria-hidden="true"> · </span>
                    <button className="text-action-link" type="button" onClick={previewPrintEnvelope}>
                      {printOrderStep === 'review' ? 'Close envelope preview' : 'Preview envelope'}
                    </button>
                    {adminPrintFiles && (
                      <div className="admin-print-links" aria-label="Save print test files">
                        <button
                          className="text-action-link"
                          type="button"
                          onClick={() =>
                            void saveImageToDevice(
                              adminPrintFiles.coverUrl,
                              printCoverDownloadName,
                              'Print cover',
                            )
                          }
                        >
                          {printCoverSaveLabel}
                        </button>
                        <span aria-hidden="true"> · </span>
                        <button
                          className="text-action-link"
                          type="button"
                          onClick={() =>
                            void saveImageToDevice(
                              adminPrintFiles.insideUrl,
                              printInsideDownloadName,
                              'Print inside',
                            )
                          }
                        >
                          {printInsideSaveLabel}
                        </button>
                      </div>
                    )}
                    {(saveNotice || adminPrintNotice) && (
                      <p className="admin-print-notice">{saveNotice || adminPrintNotice}</p>
                    )}
                  </div>
                )}
                {deliveryNotice &&
                  (/need .+ credits?/i.test(deliveryNotice)
                    ? renderCreditNeedNotice(deliveryNotice)
                    : (
                      <div className="delivery-notice">
                        <div>{deliveryNotice}</div>
                        {hasSentCurrentCard && !isGenerating && (
                          <button
                            className="text-action-link"
                            type="button"
                            onClick={() => createFormRef.current?.requestSubmit()}
                          >
                            Create another card
                          </button>
                        )}
                        {hasSentCurrentCard && !isGenerating && renderFeedbackPrompt('post_send')}
                      </div>
                    ))}
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
              {showSendActions && !isRecipientView && !showEditor && (
                <section className="print-order-panel" aria-label="Mail a printed card">
                  {printOrderStep === 'closed' ? (
                    <div className="print-order-intro">
                      <div className="credit-action-block">
                        <button className="text-action-link" type="button" onClick={openPrintOrder}>
                          Mail a printed card ({printCardCreditCost} credits)
                        </button>
                        {renderCreditsLeft()}
                      </div>
                      <p>
                        Your card will be mailed out the next business day via USPS regular mail, from Northern
                        California. Once mailed, it&apos;ll take 3 to 7 business days for delivery.
                      </p>
                    </div>
                  ) : null}

                  {printOrderStep === 'ship-to' && (
                    <form className="print-order-form" onSubmit={submitPrintShipTo}>
                      <div>
                        <span className="delivery-kicker">Mail a printed card</span>
                        <p>Where should we ship this card? United States only.</p>
                        <p className="print-order-message-note">
                          Printing the{' '}
                          <strong className="print-order-length-label">
                            {selectedMessageLengthLabel.toLowerCase()}
                          </strong>{' '}
                          inside message shown above. Switch Short / Medium / Long anytime before you place the
                          order.
                        </p>
                      </div>
                      {renderMailingAddressFields('ship-to', printShipTo, 'Recipient name')}
                      <div className="print-order-actions">
                        <button className="primary-button" type="submit">
                          Continue to envelope
                        </button>
                        <button
                          className="text-action-link"
                          type="button"
                          onClick={() => {
                            setPrintOrderStep('closed')
                            setPrintOrderNotice('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}

                  {printOrderStep === 'mail-from' && (
                    <form className="print-order-form" onSubmit={submitPrintMailFrom}>
                      <div>
                        <span className="delivery-kicker">Mail from address</span>
                        <p>This appears as the return address on the envelope.</p>
                      </div>
                      {renderMailingAddressFields('mail-from', printMailFrom, 'From name')}
                      <div className="print-order-actions">
                        <button className="primary-button" type="submit">
                          Save from address
                        </button>
                        <button
                          className="text-action-link"
                          type="button"
                          onClick={() => {
                            setPrintMailFrom({ ...defaultPrintMailFrom })
                            setPrintOrderStep('review')
                            setPrintOrderNotice('')
                          }}
                        >
                          Use Card Genie address
                        </button>
                      </div>
                    </form>
                  )}

                  {printOrderStep === 'review' && (
                    <div className="print-order-review">
                      <div>
                        <span className="delivery-kicker">Review envelope</span>
                        <p>Confirm the addresses, then place the print order.</p>
                        <p className="print-order-message-note">
                          Inside message for print:{' '}
                          <strong className="print-order-length-label">{selectedMessageLengthLabel}</strong>
                        </p>
                      </div>
                      <div className="proof-stage envelope-scene print-order-envelope-scene">
                        <div className="envelope print-order-envelope">
                          <div className="envelope-front-face">
                            <img className="envelope-stamp" src={stampSrc} alt="" aria-hidden="true" />
                            <div className="envelope-from print-order-from">
                              <span className="print-order-address-block">
                                {formatMailingAddressLines(printMailFrom)}
                              </span>
                              <button
                                className="text-action-link print-order-change"
                                type="button"
                                onClick={() => {
                                  setPrintOrderStep('mail-from')
                                  setPrintOrderNotice('')
                                }}
                              >
                                Change
                              </button>
                            </div>
                            <div className="print-order-to">
                              <span className="print-order-address-block">
                                {formatMailingAddressLines(printShipTo)}
                              </span>
                              <button
                                className="text-action-link print-order-change"
                                type="button"
                                onClick={() => {
                                  setPrintOrderStep('ship-to')
                                  setPrintOrderNotice('')
                                }}
                              >
                                Change
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                      <label className="print-shopper-email">
                        Your email for order confirmation
                        <input
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          value={printShopperEmail}
                          onChange={(event) => {
                            setPrintShopperEmail(event.target.value)
                            if (printOrderNotice) {
                              setPrintOrderNotice('')
                            }
                          }}
                          onBlur={() => {
                            const trimmed = printShopperEmail.trim()
                            if (!trimmed) {
                              return
                            }
                            const validated = validateEmailAddress(printShopperEmail)
                            if (validated.ok) {
                              setPrintShopperEmail(validated.value)
                            }
                          }}
                          placeholder="your-email@example.com"
                          disabled={isOrderingPrint}
                        />
                      </label>
                      <p className="print-order-rights-note">
                        You’re ordering a custom printed greeting card and mailing service, not exclusive rights to the
                        artwork. Similar designs may be created for others.{' '}
                        <a href="/terms/" target="_blank" rel="noreferrer">
                          Terms
                        </a>
                      </p>
                      <div className="print-order-actions">
                        <div className="credit-action-block">
                          <button
                            className="primary-button"
                            type="button"
                            disabled={isOrderingPrint || !accountSession}
                            aria-busy={isOrderingPrint}
                            onClick={() => void confirmPrintOrder()}
                          >
                            {isOrderingPrint
                              ? 'Sending print order…'
                              : `Mail printed card · ${printCardCreditCost} credits`}
                          </button>
                          {renderCreditsLeft()}
                        </div>
                        <button
                          className="text-action-link"
                          type="button"
                          disabled={isOrderingPrint}
                          onClick={() => {
                            setPrintOrderStep('closed')
                            setPrintOrderNotice('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {printOrderNotice &&
                    (typeof printOrderNotice === 'string' &&
                    credits < printCardCreditCost &&
                    /need .* credits/i.test(printOrderNotice)
                      ? renderCreditNeedNotice(printOrderNotice)
                      : (
                        <div className="delivery-notice">
                          {typeof printOrderNotice === 'string' ? (
                            <div className="print-order-success-notice">{printOrderNotice}</div>
                          ) : (
                            printOrderNotice
                          )}
                        </div>
                      ))}
                </section>
              )}
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
                      <span className={coverPreviewClass('editor-cover-thumb')}>
                        <img src={card.imageUrl} alt="" />
                      </span>
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
                            <div className={coverPreviewClass('card-cover-frame editor-cover-frame')}>
                              <img src={card.imageUrl} alt={`Cover preview for ${recipientLabel}`} />
                            </div>
                            <div className={coverPreviewClass('image-zoom-popover')} aria-hidden="true">
                              <img src={card.imageUrl} alt="" />
                            </div>
                          </div>
                          {showCoverWatermark ? (
                            <span className="cover-watermark-note editor-watermark-note">
                              <span>A preview watermark is shown on the cover.</span>
                              <span>It will not appear on the card sent to your recipient.</span>
                            </span>
                          ) : (
                            <span className="zoom-hint">Hover over the cover to enlarge</span>
                          )}
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
                          {card?.messageVariants?.short && card.messageVariants.medium && card.messageVariants.long && (
                            <div className="message-length-picker editor-message-length-picker" aria-label="Message length">
                              <div
                                className="mode-toggle message-length-toggle"
                                role="group"
                                aria-label="Choose message length"
                              >
                                {messageLengthChoices.map((choice) => (
                                  <button
                                    key={choice.id}
                                    className={(card.selectedLength || 'medium') === choice.id ? 'is-selected' : ''}
                                    type="button"
                                    onClick={() => selectMessageLength(choice.id)}
                                  >
                                    {choice.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
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
                          <div className="credit-action-block">
                            <button
                              className="primary-button cost-button"
                              type="button"
                              disabled={isRefiningImage || !imageRefinement.trim()}
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
                                  <span className="button-points">{coverRevisionCost} credit</span>
                                </>
                              )}
                            </button>
                            {renderCreditsLeft()}
                          </div>
                          {refinementNotice && editorTab === 'front' && renderCreditNeedNotice(refinementNotice)}
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
                            <input
                              value={insideGreeting}
                              onChange={(event) => {
                                setCardGreeting(event.target.value)
                                setEditorHasChanges(true)
                              }}
                            />
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
                              onChange={(event) => {
                                setCardSignature(event.target.value)
                                setEditorHasChanges(true)
                              }}
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
                              <div className="credit-action-block">
                                <button
                                  className="primary-button cost-button"
                                  type="button"
                                  disabled={isRefiningCopy || !copyRefinement.trim()}
                                  aria-busy={isRefiningCopy}
                                  onClick={refineCopy}
                                >
                                  {isRefiningCopy ? (
                                    'Rewriting inside...'
                                  ) : (
                                    <>
                                      <span>Rewrite with AI</span>
                                      <span className="button-points">{aiCopyCost} credit</span>
                                    </>
                                  )}
                                </button>
                                {renderCreditsLeft()}
                              </div>
                              {refinementNotice && editorTab === 'inside' && renderCreditNeedNotice(refinementNotice)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {editorHasChanges && (
                      <div className="editor-accept-bar">
                        <button className="primary-button" type="button" onClick={acceptEditorChanges}>
                          Accept changes
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>}
      </section>
      <footer className="site-footer">
        <div className="footer-primary">
          {!isRecipientView && (
            <button type="button" onClick={() => void openAccountPage()}>
              {accountButtonLabel}
            </button>
          )}
          <a href={supportMailto}>Email us</a>
          <a href="/faq/">FAQ</a>
        </div>
        <div className="footer-legal">
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          {(isAdmin || isLocalApiDev) && !isRecipientView && (
            <button type="button" onClick={clearCreateCardInputs}>
              Clear
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}

export default App
