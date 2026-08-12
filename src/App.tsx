import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
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

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const apiUrl = (path: string) => `${apiBaseUrl}${path}`
const hostedApiMessage =
  'This online demo needs a deployed API server before Card Genie can generate cards. Run it locally with the Express server, or connect VITE_API_BASE_URL to a hosted backend.'
const staticPageRedirects: Record<string, string> = {
  '/privacy': '/privacy/index.html',
  '/privacy/': '/privacy/index.html',
  '/sms-opt-in': '/sms-opt-in/index.html',
  '/sms-opt-in/': '/sms-opt-in/index.html',
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

const getLengthRange = (length: string) => {
  const match = length.match(/(\d+)\s*-\s*(\d+)\s*words/i)
  return match ? { min: Number(match[1]), max: Number(match[2]) } : null
}

const trimToWordLimit = (message: string, length: string) => {
  const range = getLengthRange(length)

  if (!range) {
    return message.trim()
  }

  const cleanMessage = message.trim().replace(/\s+/g, ' ')
  const words = cleanMessage.split(/\s+/).filter(Boolean)

  if (words.length <= range.max) {
    return cleanMessage
  }

  const sentences = cleanMessage.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []
  let fitted = ''

  for (const sentence of sentences) {
    const candidate = `${fitted} ${sentence.trim()}`.trim()

    if (candidate.split(/\s+/).filter(Boolean).length > range.max) {
      break
    }

    fitted = candidate
  }

  if (fitted) {
    return /[.!?]$/.test(fitted) ? fitted : `${fitted}.`
  }

  return `${words.slice(0, range.max).join(' ').replace(/[,\s]+$/, '')}.`
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
    .split(/\n{2,}/)
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
  const sharedCardId = useMemo(() => new URLSearchParams(window.location.search).get('card'), [])
  const isRecipientView = Boolean(sharedCardId)
  const [details, setDetails] = useState<CardDetails>(initialDetails)
  const [card, setCard] = useState<GeneratedCard | null>(null)
  const [step, setStep] = useState<ExperienceStep>('envelope')
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
  const [creditNotice, setCreditNotice] = useState('You have 50 starter credits for this demo.')
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
  const rawMessage = card?.message ?? ''
  const messageParts = useMemo(() => {
    const parts = splitMessageParts(rawMessage, senderLabel)
    return {
      body: parts.body,
      closing: card?.closing ?? parts.closing,
    }
  }, [card?.closing, rawMessage, senderLabel])
  const cardMessage = useMemo(() => trimToWordLimit(messageParts.body, details.length), [details.length, messageParts.body])
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
            closing: messageParts.closing,
            signature: cardSignatureLabel,
          })
        : '',
    [card, cardSignatureLabel, insideGreeting, isRecipientView, messageParagraphs, messageParts.closing],
  )
  const generationLines = useMemo(
    () => [
      `Coming up with a creative ${details.occasion || 'card'} image for ${envelopeLabel}.`,
      `Writing a ${details.tone.toLowerCase()} note that sounds personal, not canned.`,
      `Blending the ${details.imageStyle.toLowerCase()} look with the story you shared.`,
      'Getting the envelope, cover, and inside message ready for a first look.',
    ],
    [details.imageStyle, details.occasion, details.tone, envelopeLabel],
  )
  const hasEnoughCreditsForCard = credits >= cardGenerationCost
  const hasEnoughCreditsForRevision = credits >= revisionCost

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
        setCard(shared.card)
        setCardGreeting(shared.greeting || null)
        setCardSignature(shared.signature || null)
        setShowEditor(false)
        setShowCompletionNote(false)
        setStep('envelope')
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : 'Unable to load the shared card.')
      } finally {
        setIsLoadingSharedCard(false)
      }
    }

    void loadSharedCard()
  }, [sharedCardId])

  const updateDetails = (field: keyof CardDetails, value: string) => {
    setDetails((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const addCreditPack = () => {
    setCredits((current) => current + creditPackAmount)
    setCreditNotice(`Added ${creditPackAmount} demo credits. In production this would happen after checkout.`)
  }

  const generateCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    if (!hasEnoughCreditsForCard) {
      setCreditNotice(`You need ${cardGenerationCost} credits to create a card. Add a credit pack to keep going.`)
      return
    }

    setIsGenerating(true)
    setShowCompletionNote(false)
    setActiveGenerationStep(0)
    setShowEditor(false)
    setShowPolishDialog(false)
    setSharedCard(null)
    setDeliveryNotice('')
    setStep('envelope')

    try {
      const response = await fetch(apiUrl('/api/generate-card'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(details),
      })

      const data = await getApiJson(response, 'Unable to generate the card.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to generate the card.')
      }

      setCard({
        imageUrl: data.imageUrl,
        message: data.message,
        closing: data.closing,
      })
      setCardGreeting('')
      setCardSignature(senderLabel)
      setStep('envelope')
      setShowCompletionNote(true)
      setCredits((current) => current - cardGenerationCost)
      setCreditNotice(`${cardGenerationCost} credits used to create this card.`)
      window.setTimeout(() => setShowCompletionNote(false), 6000)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to generate the card.')
    } finally {
      setIsGenerating(false)
    }
  }

  const openInside = () => {
    setStep('cardOpening')
    window.setTimeout(() => {
      setStep('inside')
    }, 1800)
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
      setCreditNotice(`You need ${revisionCost} credits to revise the cover. Add a credit pack to keep going.`)
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
        }),
      })

      const data = await getApiJson(response, 'Unable to refine the cover image.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to refine the cover image.')
      }

      setCard((current) => (current ? { ...current, imageUrl: data.imageUrl } : current))
      setImageRefinement('')
      setStep('front')
      setCredits((current) => current - revisionCost)
      setCreditNotice(`${revisionCost} credits used to revise the cover.`)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to refine the cover image.')
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
      setCreditNotice(`You need ${revisionCost} credits to polish the message. Add a credit pack to keep going.`)
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
          currentClosing: messageParts.closing,
        }),
      })

      const data = await getApiJson(response, 'Unable to refine the inside message.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to refine the inside message.')
      }

      setCard((current) =>
        current
          ? {
              ...current,
              message: data.message,
              closing: data.closing,
            }
          : current,
      )
      setCopyRefinement('')
      setShowPolishDialog(false)
      setStep('inside')
      setCredits((current) => current - revisionCost)
      setCreditNotice(`${revisionCost} credits used to polish the inside message.`)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to refine the inside message.')
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
        closing: messageParts.closing,
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
        <div className="eyebrow">Card Genie</div>
        <h1>
          {isRecipientView ? 'You received a card' : 'Any Card Imaginable'}
          {!isRecipientView && <span className="trademark-mark">™</span>}
        </h1>
        <p>
          {isRecipientView
            ? 'Click the envelope to open your personalized greeting card.'
            : 'Powered by GreetingCardUniverse.com'}
        </p>
        {!isRecipientView && <div className="credit-wallet" aria-label="Credit balance">
          <div>
            <span className="wallet-kicker">Welcome back, {senderLabel}</span>
            <strong>{credits} credits available</strong>
            <small>
              Cards use {cardGenerationCost} credits. Revisions use {revisionCost} credits.
            </small>
          </div>
          <button className="secondary-button" type="button" onClick={addCreditPack}>
            Buy 50 credits - $10
          </button>
        </div>}
      </section>

      <section className={`workspace ${isRecipientView ? 'recipient-workspace' : ''}`}>
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
            <strong>{credits} credits</strong>
          </div>

          <div className="field-grid">
            <label>
              Recipient name
              <input
                value={details.recipientName}
                onChange={(event) => updateDetails('recipientName', event.target.value)}
                placeholder="Example: Jamie"
              />
            </label>

            <label>
              Recipient type or relation
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
              Occasion
              <input
                required
                value={details.occasion}
                onChange={(event) => updateDetails('occasion', event.target.value)}
                placeholder="Example: birthday, thank you, anniversary"
              />
            </label>

            <label>
              From / Signature
              <input
                required
                value={details.senderName}
                onChange={(event) => updateDetails('senderName', event.target.value)}
                placeholder="Example: your name"
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

          <label>
            Image style
            <select
              value={details.imageStyle}
              onChange={(event) => updateDetails('imageStyle', event.target.value)}
            >
              {styleOptions.map((style) => (
                <option key={style}>{style}</option>
              ))}
            </select>
          </label>

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

          {error && <div className="error-message">{error}</div>}

          <button className="primary-button" disabled={isGenerating} aria-busy={isGenerating}>
            {isGenerating
              ? 'Generating your card...'
              : card
                ? `Regenerate card - ${cardGenerationCost} credits`
                : `Generate card - ${cardGenerationCost} credits`}
          </button>
        </form>}

        <section className={`card-panel preview-panel ${isRecipientView ? 'recipient-preview-panel' : ''}`}>
          <div className="panel-heading proof-heading">
            {!isRecipientView && <span>02</span>}
            <div>
              <h2>
                {isRecipientView ? `Your card from ${senderLabel}` : showEditor ? 'Revise your card' : 'Your card proof'}
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
              <span className="loader-kicker">Card Genie is creating</span>
              <h3 key={generationLines[activeGenerationStep]}>{generationLines[activeGenerationStep]}</h3>
            </div>
          )}

          {isLoadingSharedCard && (
            <div className="empty-state" role="status" aria-live="polite">
              <div className="sparkle">CG</div>
              <h3>Loading your card</h3>
              <p>Opening the shared greeting card proof.</p>
            </div>
          )}

          {isRecipientView && error && <div className="error-message">{error}</div>}

          {!isGenerating && !isLoadingSharedCard && !card && (
            <div className="empty-state">
              <div className="sparkle">✦</div>
              <h3>No proof yet</h3>
              <p>Fill in the form, then generate a complete digital greeting card.</p>
            </div>
          )}

          {!isGenerating && card && (
            <>
              {!showEditor && (
                <>
              {showCompletionNote && (
                <div className="completion-note">
                  All right, I think I got it. Let me know what you think of this.
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
                  <span className="envelope-prompt">Click to Open</span>
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
                      <div className="envelope-flap envelope-flap-static" />
                      <div className="envelope-body" />
                    </div>
                  </div>
                  <span className="envelope-prompt envelope-prompt-placeholder" aria-hidden="true">
                    Click to Open
                  </span>
                </div>
              )}

              {step === 'envelopeBack' && (
                <div className="proof-stage envelope-scene" aria-live="polite">
                  <div className="envelope envelope-static">
                    <div className="envelope-back-face is-static">
                      <div className="envelope-back" />
                      <div className="envelope-flap envelope-flap-static" />
                      <div className="envelope-body" />
                    </div>
                  </div>
                  <span className="envelope-prompt envelope-prompt-placeholder" aria-hidden="true">
                    Tap to Open
                  </span>
                </div>
              )}

              {step === 'opening' && (
                <div className="proof-stage envelope-scene opening-scene" aria-live="polite">
                  <div className="envelope is-opening">
                    <div className="envelope-back-face">
                      <small aria-hidden="true"></small>
                    </div>
                    <div className="envelope-back" />
                    <div className="envelope-card-rise">
                      <img src={card.imageUrl} alt={`Front of card for ${recipientLabel}`} />
                    </div>
                    <div className="envelope-flap" />
                    <div className="envelope-body">
                      <small aria-hidden="true"></small>
                    </div>
                  </div>
                </div>
              )}

              {step === 'front' && (
                <button className="proof-stage card-reveal front-reveal" type="button" onClick={openInside}>
                  <div className="card-cover-frame">
                    <img src={card.imageUrl} alt={`Front of card for ${recipientLabel}`} />
                  </div>
                  <span>Click to open</span>
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
                      <div className="card-closing">{messageParts.closing}</div>
                      <div className="card-signature">{cardSignatureLabel}</div>
                    </div>
                    <div className="card-opening-cover">
                      <img src={card.imageUrl} alt={`Opening card cover for ${recipientLabel}`} />
                    </div>
                  </div>
                </div>
              )}

              {step === 'inside' && (
                <div className="proof-stage card-open-scene is-static-inside">
                  <div className="open-card">
                    <div className={`open-card-message ${messageDensity}`}>
                      {insideGreeting && <span>{insideGreeting}</span>}
                      <div className="message-paragraphs">
                        {messageParagraphs.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                      <div className="card-closing">{messageParts.closing}</div>
                      <div className="card-signature">{cardSignatureLabel}</div>
                    </div>
                  </div>
                </div>
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

              <div className="proof-actions">
                <button className="secondary-button" type="button" onClick={replayAnimation}>
                  Replay animation
                </button>
              </div>
              {!isRecipientView && <form className="delivery-panel" onSubmit={deliverCard}>
                <div>
                  <span className="delivery-kicker">Ready to send?</span>
                  <h3>Deliver this card</h3>
                  <p>Send a secure card link by email or text after you approve the proof.</p>
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
                  {isDelivering ? 'Sending card...' : `Send by ${deliveryMethod === 'email' ? 'email' : 'text'}`}
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

                  <div className={`editor-layout ${editorTab === 'inside' ? 'is-inside-editor' : ''}`}>
                    {editorTab === 'front' && (
                      <div className="editor-preview">
                        <div className="image-zoom" tabIndex={0} aria-label="Cover preview. Hover or focus to enlarge.">
                          <div className="card-cover-frame editor-cover-frame">
                            <img src={card.imageUrl} alt={`Cover preview for ${recipientLabel}`} />
                          </div>
                          <div className="image-zoom-popover" aria-hidden="true">
                            <img src={card.imageUrl} alt="" />
                          </div>
                        </div>
                        <span className="zoom-hint">Hover over the cover to enlarge</span>
                      </div>
                    )}

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
                            <h3>Edit Inside</h3>
                            <button
                              className="primary-button cost-button"
                              type="button"
                              onClick={() => setShowPolishDialog(true)}
                            >
                              <span>Revise Card Inside</span>
                              <span className="button-points">{revisionCost} points</span>
                            </button>
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
                              value={messageParts.closing}
                              onChange={(event) => updateCardClosing(event.target.value)}
                            />
                          </label>
                          <label>
                            Signature name
                            <input
                              value={cardSignatureLabel}
                              onChange={(event) => setCardSignature(event.target.value)}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {showPolishDialog && (
                <div className="polish-dialog-backdrop">
                  <div className="polish-dialog" role="dialog" aria-modal="true" aria-labelledby="polish-title">
                    <div className="polish-dialog-heading">
                      <span className="polish-icon" aria-hidden="true">
                        CG
                      </span>
                      <div>
                        <h3 id="polish-title">Revise Card Inside</h3>
                        <p>Tell Card Genie how to revise the message while keeping it personal.</p>
                      </div>
                    </div>
                    <textarea
                      rows={5}
                      value={copyRefinement}
                      onChange={(event) => setCopyRefinement(event.target.value)}
                      placeholder="Example: make it shorter, warmer, funnier, or more specific about a favorite memory."
                    />
                    <div className="polish-dialog-actions">
                      <button className="secondary-button" type="button" onClick={() => setShowPolishDialog(false)}>
                        Cancel
                      </button>
                      <button
                        className="primary-button cost-button"
                        type="button"
                        disabled={isRefiningCopy || !copyRefinement.trim() || !hasEnoughCreditsForRevision}
                        aria-busy={isRefiningCopy}
                        onClick={refineCopy}
                      >
                        {isRefiningCopy ? (
                          'Revising inside...'
                        ) : (
                          <>
                            <span>Revise Card Inside</span>
                            <span className="button-points">{revisionCost} points</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
