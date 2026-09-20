import 'dotenv/config'

import crypto from 'node:crypto'
import express from 'express'
import OpenAI, { toFile } from 'openai'

const COVER_IMAGE_SIZE = '1056x1472'
const COVER_IMAGE_WIDTH = 1056
const COVER_IMAGE_HEIGHT = 1472
/** Outer band kept clear of essential content for print trim (15% ≈ 226px at 1504 print width). */
const COVER_SAFE_MARGIN_PERCENT = 15

const app = express()
const port = process.env.PORT || 8787
const cardStore = new Map()
const jobStore = new Map()

const localDevAuthEnabled =
  process.env.LOCAL_DEV_AUTH === '1' || String(process.env.LOCAL_DEV_AUTH || '').toLowerCase() === 'true'
const localDevOtpCode = String(process.env.LOCAL_DEV_OTP || '424242')
  .replace(/\D/g, '')
  .padStart(6, '0')
  .slice(-6)
const localAccountSessions = new Map()
const localAccountUsers = new Map()

const isLocalDevAuthRequest = (req) => {
  if (!localDevAuthEnabled) {
    return false
  }

  const origin = req.headers.origin || ''
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return false
  }

  return true
}

const readBearerToken = (req) => {
  const header = req.headers.authorization || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

const getLocalDevUser = (phoneE164) => {
  const existing = localAccountUsers.get(phoneE164)
  if (existing) {
    return existing
  }

  const user = {
    id: crypto.randomUUID(),
    phoneE164,
    email: '',
    creditBalance: 50,
    createdAt: Date.now(),
  }
  localAccountUsers.set(phoneE164, user)
  return user
}
const localAdminPhones = new Set(['+19259637453'])
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,https://card-genie.com,https://www.card-genie.com'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})
app.use(express.json({ limit: '25mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/cards', (req, res) => {
  try {
    const record = buildCardRecord(req.body)
    cardStore.set(record.id, record)

    res.status(201).json(getCardSummary(record, req))
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to save the card.',
    })
  }
})

app.get('/api/cards/:cardId', (req, res) => {
  const record = cardStore.get(req.params.cardId)

  if (!record) {
    return res.status(404).json({
      error: 'Card not found.',
    })
  }

  res.json(getCardSummary(record, req))
})

app.get('/c/:cardId/cover', (req, res) => {
  const record = cardStore.get(req.params.cardId)
  const imageUrl = record?.card?.imageUrl

  if (!imageUrl) {
    return res.status(404).json({
      error: 'Card not found.',
    })
  }

  const parsed = parseDataImage(imageUrl)

  if (parsed) {
    res.setHeader('Content-Type', parsed.mimeType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.send(parsed.bytes)
  }

  if (/^https?:\/\//.test(imageUrl)) {
    return res.redirect(imageUrl)
  }

  return res.status(404).json({
    error: 'Card cover is unavailable.',
  })
})

app.get('/c/:cardId', (req, res) => {
  const record = cardStore.get(req.params.cardId)

  if (!record) {
    return res.status(404).json({
      error: 'Card not found.',
    })
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.send(buildSharePreviewHtml(record, req))
})

const publicDeliveryError = (error, method = 'email') => {
  const message = error instanceof Error ? error.message : String(error || '')

  if (/sendgrid/i.test(message)) {
    if (/maximum credits exceeded/i.test(message)) {
      return 'Email delivery is temporarily unavailable because the sending limit was reached. You can still open the shareable card link and send it yourself.'
    }

    if (/payload|too large|entity too large|413/i.test(message)) {
      return 'Email delivery failed because the message was too large. Try sending again.'
    }

    return 'Email delivery is temporarily unavailable. You can still open the shareable card link and send it yourself, or email support@card-genie.com.'
  }

  if (/postmark/i.test(message)) {
    return 'Email delivery is temporarily unavailable. You can still open the shareable card link and send it yourself, or email support@card-genie.com.'
  }

  if (/twilio/i.test(message)) {
    return 'Text delivery is temporarily unavailable. You can still open the shareable card link and send it yourself, or email support@card-genie.com.'
  }

  if (/not configured/i.test(message)) {
    return message
  }

  return message || (method === 'email' ? 'Unable to deliver the card by email.' : 'Unable to deliver the card by text.')
}

const MAX_DELIVERY_RECIPIENTS = 10

const collectDeliveryDestinations = ({ destination, destinations }) => {
  if (Array.isArray(destinations)) {
    return destinations.map((entry) => String(entry || '').trim()).filter(Boolean)
  }

  const single = typeof destination === 'string' ? destination.trim() : ''
  return single ? [single] : []
}

app.post('/api/deliver-card', async (req, res) => {
  const {
    cardId,
    method,
    destination,
    destinations,
    recipientConsentConfirmed,
    senderCopyEmail: rawSenderCopyEmail,
  } = req.body || {}
  const record = cardStore.get(cardId)
  const destinationList = collectDeliveryDestinations({ destination, destinations })
  const senderCopyEmail = rawSenderCopyEmail?.trim()

  if (!record) {
    return res.status(404).json({
      error: 'Save the card before delivering it.',
    })
  }

  if (!['email', 'text'].includes(method)) {
    return res.status(400).json({
      error: 'Choose email or text delivery.',
    })
  }

  if (!destinationList.length) {
    return res.status(400).json({
      error: method === 'email' ? 'Enter the recipient email address.' : 'Enter the recipient cellphone number.',
    })
  }

  if (destinationList.length > MAX_DELIVERY_RECIPIENTS) {
    return res.status(400).json({
      error: `You can send to up to ${MAX_DELIVERY_RECIPIENTS} recipients at a time.`,
    })
  }

  if (method === 'text' && recipientConsentConfirmed !== true) {
    return res.status(400).json({
      error:
        destinationList.length > 1
          ? 'Confirm each recipient agreed to receive this one-time card delivery text.'
          : 'Confirm the recipient agreed to receive this one-time card delivery text.',
    })
  }

  const shareUrl = getShareUrl(req, record.id)
  const coverUrl = getEmailCoverUrl(req, record.id)
  const copy = buildDeliveryCopy(record, shareUrl, coverUrl)
  const results = []
  const seen = new Set()
  let senderCopyDeliveredTo = null
  let senderCopyPending = Boolean(senderCopyEmail)

  for (const rawDestination of destinationList) {
    let normalizedDestination = ''

    try {
      normalizedDestination =
        method === 'email' ? normalizeEmailAddress(rawDestination) : normalizePhoneNumber(rawDestination)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid recipient.'
      results.push({ destination: rawDestination, status: 'failed', error: message })
      continue
    }

    if (seen.has(normalizedDestination)) {
      continue
    }
    seen.add(normalizedDestination)

    try {
      const deliveredTo =
        method === 'email'
          ? await sendEmailDelivery({ to: normalizedDestination, copy })
          : await sendTextDelivery({ to: normalizedDestination, copy })

      if (senderCopyPending && senderCopyEmail) {
        try {
          const senderCopy = buildSenderCopyDeliveryCopy(record, shareUrl, coverUrl)
          senderCopyDeliveredTo = await sendEmailDelivery({
            to: normalizeEmailAddress(senderCopyEmail),
            copy: senderCopy,
          })
        } catch (copyError) {
          console.error(copyError)
        }
        senderCopyPending = false
      }

      results.push({ destination: deliveredTo, status: 'sent' })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to deliver the card.'
      const isValidationError =
        /email|cellphone|phone|@|period|\.com|digits|incomplete|spaces/i.test(rawMessage) &&
        !/SendGrid|Postmark|Twilio|configured/i.test(rawMessage)

      results.push({
        destination: normalizedDestination || rawDestination,
        status: 'failed',
        error: isValidationError ? rawMessage : publicDeliveryError(error, method),
      })
    }
  }

  const sent = results.filter((entry) => entry.status === 'sent')
  const failed = results.filter((entry) => entry.status === 'failed')

  if (!sent.length) {
    return res
      .status(
        failed.every((entry) =>
          /email|cellphone|phone|@|period|\.com|digits|incomplete|spaces/i.test(entry.error || ''),
        )
          ? 400
          : 500,
      )
      .json({
        error:
          failed[0]?.error ||
          (method === 'email' ? 'Unable to deliver the card by email.' : 'Unable to deliver the card by text.'),
        results,
        deliveredCount: 0,
        failedCount: failed.length,
      })
  }

  const message = (() => {
    if (failed.length) {
      return sent.length === 1
        ? `Card sent to 1 recipient. ${failed.length} could not be reached.`
        : `Card sent to ${sent.length} recipients. ${failed.length} could not be reached.`
    }

    if (senderCopyDeliveredTo) {
      return sent.length === 1
        ? 'Card has been sent. A copy was emailed to you.'
        : `Card sent to ${sent.length} recipients. A copy was emailed to you.`
    }

    return sent.length === 1 ? 'Card has been sent.' : `Card sent to ${sent.length} recipients.`
  })()

  res.json({
    ok: true,
    shareUrl,
    deliveredTo: sent[0].destination,
    deliveredCount: sent.length,
    failedCount: failed.length,
    results,
    senderCopyDeliveredTo,
    message,
  })
})

app.post('/api/order-print-card', async (req, res) => {
  try {
    if (!isLocalDevAuthRequest(req)) {
      return res.status(404).json({ error: 'Not found.' })
    }

    const token = readBearerToken(req)
    const session = token ? localAccountSessions.get(token) : null
    if (!session) {
      return res.status(401).json({ error: 'Confirm your mobile number before ordering a printed card.' })
    }

    const {
      cardId,
      mailFrom: rawMailFrom,
      shipTo: rawShipTo,
      shopperEmail: rawShopperEmail,
      coverImage,
      insideImage,
      coverThumbImage,
      insideThumbImage,
    } = req.body || {}
    const record = cardStore.get(cardId)

    if (!record) {
      return res.status(404).json({ error: 'Save the card before ordering a print.' })
    }

    const mailFrom = normalizeMailingAddress(rawMailFrom, 'mail-from')
    const shipTo = normalizeMailingAddress(rawShipTo, 'ship-to')
    const shopperEmail = normalizeEmailAddress(rawShopperEmail)
    const cover = parseDataUrlImage(coverImage, 'cover')
    const inside = parseDataUrlImage(insideImage, 'inside')
    const coverThumb = coverThumbImage
      ? parseDataUrlImage(coverThumbImage, 'cover thumbnail')
      : { type: cover.type || 'image/png', content: cover.content }
    const insideThumb = insideThumbImage
      ? parseDataUrlImage(insideThumbImage, 'inside thumbnail')
      : { type: inside.type || 'image/png', content: inside.content }
    const shareUrl = getShareUrl(req, record.id)
    const orderNumber = allocateLocalPrintOrderNumber()
    const orderCode = String(orderNumber)
    session.email = shopperEmail
    const localUser = localAccountUsers.get(session.phoneE164)
    if (localUser) {
      localUser.email = shopperEmail
    }
    const copy = buildPrintOrderEmailCopy({
      cardId: record.id,
      orderCode,
      shareUrl,
      mailFrom,
      shipTo,
      details: record.details || {},
      shopperEmail,
    })

    await sendEmailDelivery({
      to: PRINT_ORDER_SUPPORT_EMAIL,
      copy,
      attachments: [
        {
          filename: cover.type?.includes('jpeg') || cover.type?.includes('jpg') ? 'print-cover.jpg' : 'print-cover.png',
          type: cover.type || 'image/png',
          content: cover.content,
        },
        {
          filename: 'print-inside.png',
          type: inside.type || 'image/png',
          content: inside.content,
        },
      ],
    }).catch((emailError) => {
      console.error('Print order saved but support email failed.', emailError)
    })

    try {
      const confirmationCopy = buildPrintOrderConfirmationCopy({
        orderCode,
        shipTo,
        mailFrom,
      })
      await sendEmailDelivery({
        to: shopperEmail,
        copy: confirmationCopy,
        attachments: [
          {
            filename: 'print-cover-thumb.jpg',
            type: coverThumb.type || 'image/jpeg',
            content: coverThumb.content,
            disposition: 'inline',
            contentId: 'print-cover-thumb',
          },
          {
            filename: 'print-inside-thumb.png',
            type: insideThumb.type || 'image/png',
            content: insideThumb.content,
            disposition: 'inline',
            contentId: 'print-inside-thumb',
          },
        ],
      })
    } catch (confirmationError) {
      console.error('Unable to send print order confirmation email.', confirmationError)
    }

    return res.json({
      ok: true,
      orderCode,
      orderNumber,
      creditCost: PRINT_CARD_CREDIT_COST,
      shopperEmail,
      mailedTo: PRINT_ORDER_SUPPORT_EMAIL,
      message: `Print order ${orderCode} sent. We'll mail the card shortly.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to place the print order.'
    const isValidation =
      /enter|choose|provide|valid|united states|zip|state|street|name|city|image|email|@/i.test(message) &&
      !/SendGrid|Postmark|configured/i.test(message)

    return res.status(isValidation ? 400 : 500).json({ error: message })
  }
})

const buildCopyPrompt = (details, refinement = '', messageKeyDetails) => {
  const personalDetails =
    typeof messageKeyDetails === 'string' ? messageKeyDetails : details.keyDetails || ''
  const appearanceRemoved = personalDetails.trim() !== (details.keyDetails || '').trim()

  return `
Write the inside message for a personalized greeting card.

Recipient: ${details.recipientName || details.recipientType}
Recipient type or relationship: ${details.recipientType}
Sender: ${details.senderName}
Occasion: ${details.occasion}
Tone: ${details.tone}
Length: ${details.length}
Personal details to include: ${personalDetails || 'Use the occasion, tone, and relationship only.'}
${refinement ? `\nUser refinement request: ${refinement}` : ''}
${appearanceRemoved ? '\nNote: Physical appearance details were removed from the list above. They are used only for the cover artwork. Do not infer, describe, or compliment anyone\'s looks, height, hair, eyes, figure, or skin tone.' : ''}

Strictly obey the selected Length word-count range for the message body only. Count the body copy words, not the greeting, closing, or signature. Do not exceed the maximum word count in the selected range.

Return strict JSON only, with this shape:
{
  "message": "Body copy only, split into 2-4 short logical paragraphs separated by blank lines. No salutation, closing, sender name, placeholder, or signature.",
  "closing": "A short closing phrase appropriate to the occasion, tone, and relationship — e.g. With love, / Cheers, / With gratitude, / Warmly, / Your friend, / Here's to you, etc. Never default to 'With all my love' unless it truly fits."
}

Do not include a salutation like "Dear..." and do not include the sender name, placeholder, or signature. The app will typeset the greeting, closing, and cursive signature separately.
Make the body warm, specific, natural, and suitable to appear inside a digital greeting card. Keep it concise enough to fit inside a 5x7 card with generous margins. Use natural paragraph breaks based on grammar and meaning.

Physical appearance vs. message content:
- Personal details often include physical descriptions (height, eye color, hair color or style, build, glasses, facial hair, etc.) meant for the front cover artwork only.
- Do NOT mention physical appearance in the inside message. Never write that someone is tall, has green eyes, blonde hair, a radiant figure, or similar look-based details.
- Use personal details for the message only when they describe memories, interests, hobbies, relationships, places, feelings, jokes, or occasion-relevant stories — not how someone looks.
- Wrong: "Your tall figure and green eyes captivate me." Right: "Your passion for pilates and how you embrace life inspire me."
`
}

const appearanceKeywordPattern =
  /\b(tall|taller|short|shorter|petite|slim|slender|muscular|stocky|tan|tanned|sun[- ]?kissed|figure|stature|frame|build|complexion|freckles|dimples)\b|\b(green|blue|brown|hazel|gray|grey|amber)\s+eyes?\b|\beye[- ]?color\b|\b(blonde|blond|brunette|auburn|redhead)\b|\b(black|brown|blonde|blond|red|auburn|gray|grey|white|silver|medium|dark|light|short|long|curly|wavy|straight)\s+(?:\w+\s+){0,2}hair\b|\bhair\s+(?:color|with|is)\b|\b(short|long|curly|wavy|straight)\s+hair\b|\b(radiant|captivating|stunning|beautiful|handsome|pretty)\s+(?:green|blue|brown|)?\s*eyes\b/gi

const splitIntoDetailSentences = (text = '') =>
  text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

const isAppearanceFocusedSentence = (sentence) => {
  const trimmed = sentence.trim()

  if (!trimmed) {
    return false
  }

  const appearanceMatches = trimmed.match(appearanceKeywordPattern) || []

  if (appearanceMatches.length === 0) {
    return false
  }

  if (/^(?:is|are|was|were|has|have|had)\b/i.test(trimmed) && appearanceMatches.length >= 1) {
    return true
  }

  if (
    /^(?:she|he|they|[A-Za-z]+)\s+(?:is|are|was|were|has|have|had)\s+/i.test(trimmed) &&
    appearanceMatches.length >= 1 &&
    !/\b(?:love|loves|liked|enjoy|enjoys|passion|favorite|favourite|hobby|hobbies)\b/i.test(trimmed)
  ) {
    return true
  }

  const words = trimmed.split(/\s+/).filter(Boolean)

  return appearanceMatches.length >= 2 && appearanceMatches.length / Math.max(words.length, 1) > 0.12
}

const stripAppearanceClausesFromSentence = (sentence) => {
  let result = sentence
    .replace(
      /\b(?:your|her|his|their)\s+(?:\w+\s+){0,2}(?:tall\s+)?(?:figure|stature|frame|build)\s+and\s+(?:radiant\s+|beautiful\s+|captivating\s+|stunning\s+)?(?:\w+\s+){0,2}eyes?\s+\w+\s+me,?\s*(?:while\s+)?/gi,
      '',
    )
    .replace(
      /\b(?:your|her|his|their)\s+(?:tall\s+)?(?:figure|stature|frame|build)\b(?:\s+and\s+(?:radiant\s+|beautiful\s+|captivating\s+|stunning\s+)?(?:\w+\s+){0,2}eyes?(?:\s+\w+\s+me)?)?/gi,
      '',
    )
    .replace(
      /,?\s*\b(?:is|are|was|were)\s+(?:very\s+|so\s+)?(?:tall|short|tan|tanned|slim|petite|muscular)(?:\s*,\s*|\s+and\s+)has\s+(?:medium\s+|long\s+|short\s+|beautiful\s+)?(?:(?:blonde|blond|brunette|auburn|black|brown|red|gray|grey|white|silver|\w+)\s+){0,2}hair(?:\s+with\s+(?:green|blue|brown|hazel|gray|grey)\s+eyes?)?(?:\s*,\s*|\s+and\s+)is\s+(?:tan|tanned)\b/gi,
      '',
    )
    .replace(
      /,?\s*\b(?:is|are|was|were)\s+(?:very\s+|so\s+)?(?:tall|short|tan|tanned|slim|petite|muscular)\b/gi,
      '',
    )
    .replace(
      /,?\s*\b(?:has|have|had)\s+(?:medium\s+|long\s+|short\s+|beautiful\s+)?(?:(?:blonde|blond|brunette|auburn|black|brown|red|gray|grey|white|silver|\w+)\s+){0,2}hair(?:\s+with\s+(?:green|blue|brown|hazel|gray|grey)\s+eyes?)?/gi,
      '',
    )
    .replace(
      /,?\s*\b(?:with\s+)?(?:green|blue|brown|hazel|gray|grey|radiant|captivating|beautiful|stunning)\s+eyes?\b/gi,
      '',
    )
    .replace(/\b(?:and\s+)?(?:radiant|beautiful|captivating|stunning)\s+captivate me,?\s*(?:while\s+)?/gi, '')
    .replace(/\bwhich\s+is\s+black\s+and\s+white(?:\s+with\s+short\s+hair)?/gi, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^(?:while|and)\b/i.test(result)) {
    result = result.replace(/^(?:while|and)\s+/i, '')
  }

  if (result && /^[a-z]/.test(result)) {
    result = `${result.charAt(0).toUpperCase()}${result.slice(1)}`
  }

  return result
}

const getOriginalKeyDetails = (details = {}) => {
  const raw = details.keyDetails || ''
  const marker = '\n\nCurrent inside message:'
  const index = raw.indexOf(marker)

  return index === -1 ? raw : raw.slice(0, index)
}

const extractMessageKeyDetails = (keyDetails = '') => {
  const sentences = splitIntoDetailSentences(keyDetails)

  return sentences
    .filter((sentence) => !isAppearanceFocusedSentence(sentence))
    .map((sentence) => stripAppearanceClausesFromSentence(sentence))
    .filter(Boolean)
    .join(' ')
    .trim()
}

const messageStillMentionsAppearance = (message = '') => appearanceKeywordPattern.test(message)

const stripAppearanceFromMessage = (message = '') => {
  const paragraphs = message
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  const cleanedParagraphs = paragraphs
    .map((paragraph) => {
      const sentences = splitIntoDetailSentences(paragraph)

      return sentences
        .map((sentence) => stripAppearanceClausesFromSentence(sentence))
        .filter((sentence) => sentence && !messageStillMentionsAppearance(sentence))
        .join(' ')
        .trim()
    })
    .filter(Boolean)

  return cleanedParagraphs.join('\n\n').trim()
}

const buildStyleResemblanceDirection = (imageStyle = '') => {
  if (/comic/i.test(imageStyle)) {
    return 'The people must be clearly recognizable as the people in the photos, drawn as comic-book characters: bold ink, color holds, and comic anatomy. Keep faces, hair, glasses, and facial hair identifiable. This is a stylized likeness, never a photograph.'
  }

  if (/photoreal/i.test(imageStyle)) {
    return 'The people must be clearly recognizable as the people in the photos in a natural greeting-card photograph. Keep faces, ages, hair, glasses, and facial hair. Do not paste the original photographs onto the card.'
  }

  if (imageStyle) {
    return `The people must be clearly recognizable as the people in the photos, drawn as original characters in "${imageStyle}". Keep faces, hair, glasses, and facial hair identifiable in that medium, never as a pasted photograph.`
  }

  return 'The people must be clearly recognizable as the people in the photos, drawn as original greeting-card characters in the selected art style.'
}

const buildAttachedPhotoGuidance = (hasReferenceImages) => {
  if (!hasReferenceImages) {
    return ''
  }

  return `
The attached photos are likeness references of the actual people and animals for this card.
The people on the cover must clearly resemble them: faces, ages, hair, glasses, facial hair, clothing, and how many people are in the photo.
Create original greeting-card artwork in the selected visual style. Do not paste, collage, Polaroid, frame, or print the original photographs onto the card.
`
}

const buildReferenceImageGuidance = (hasReferenceImages, imageStyle = '') => {
  if (!hasReferenceImages) {
    return ''
  }

  return `
The attached images are references for original greeting-card characters, not photos to paste onto the card.
${buildStyleResemblanceDirection(imageStyle)}
Match their ages, hair, glasses, clothing, distinctive features, and any pets.
Relationship words such as daughter, son, kids, mom, or dad must not change their ages if the photos show something different. If the photos show adults, draw adults, not children.
The people and animals from the photos should appear on the cover unless the user asked for a symbolic scene instead.
Do not copy the photographs onto the card as printed pictures, Polaroids, frames, phone screens, or collages.
If children appear, depict them fully and modestly clothed as they would on a family greeting card. Never depict nudity.
`
}

const buildLikenessBriefSection = (likenessBrief, imageStyle = '') => {
  if (!likenessBrief) {
    return ''
  }

  if (!imageStyle) {
    return `
PEOPLE AND DETAILS FROM THE SENDER'S REFERENCE PHOTOS:
${likenessBrief}
`
  }

  return `
CHARACTER RESEMBLANCE FROM THE SENDER'S REFERENCE PHOTOS:
${likenessBrief}

The selected visual style is "${imageStyle}". ${buildStyleResemblanceDirection(imageStyle)}
Match faces, age, hair, glasses, facial hair, clothing, distinctive features, and any pets. If the photos show adults, draw adults.
Do not paste the original photographs onto the card.
If children are included, they must be fully and modestly clothed.
`
}

const referenceImageDescriptionPrompt = `These are private family photos for a wholesome greeting card. Write a concise likeness brief an illustrator can follow to keep a clear resemblance.

Count the people. For each person, include: approximate age band (child, teen, young adult, adult, or older adult), hair color and style, facial hair, glasses, complexion, distinctive features, clothing color, and general build.
If several people appear together, describe them left to right.
For animals, include species, size, coat color, and distinctive markings.
Mention setting only if it should inspire the card.

Be specific about age. If people look like adults, say they are adults, not children.
If a child appears in a bath or is not fully clothed, describe them as a clothed child of that age. Do not mention nudity, baths, or unclothed states.
Do not use anyone's real name.
Return plain text only. Do not mention that these came from photos.`

const getErrorText = (error) => {
  if (!error) {
    return ''
  }

  if (typeof error === 'string') {
    return error
  }

  return [
    error.message,
    error.code,
    error.error?.message,
    error.error?.code,
    error.error?.type,
    Array.isArray(error.error?.safety_violations) ? error.error.safety_violations.join(' ') : '',
    getModerationCategories(error).join(' '),
    error.cause ? getErrorText(error.cause) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

const getSafetyViolations = (error) => {
  const raw = error?.error?.safety_violations || error?.safety_violations || error?.cause?.error?.safety_violations || []
  return Array.isArray(raw) ? raw.map(String) : []
}

const flattenModerationCategories = (value) => {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') {
        return [item]
      }

      if (item && typeof item === 'object') {
        return [item.category, item.type, item.code, ...(Array.isArray(item.categories) ? item.categories : [])].filter(
          Boolean,
        )
      }

      return []
    })
  }

  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, flagged]) => Boolean(flagged))
      .map(([name]) => name)
  }

  return [String(value)]
}

const getModerationCategories = (error) => {
  const details =
    error?.error?.moderation_details || error?.moderation_details || error?.cause?.error?.moderation_details || {}

  return [...flattenModerationCategories(details.categories), ...getSafetyViolations(error)]
}

const isSafetyRejection = (error) =>
  Boolean(error?.safety) ||
  /safety|moderation|safety_violations|rejected by the safety system/i.test(getErrorText(error))

const isTransientGenerationError = (error) => {
  if (!error || isSafetyRejection(error) || error.publicMessage) {
    return false
  }

  return /timeout|timed out|429|500|502|503|504|524|rate.?limit|overloaded|econnreset|network|fetch failed|temporar|try again/i.test(
    getErrorText(error),
  )
}

const copyrightedPropertyPattern =
  /iron\s*man|spider-?man|batman|superman|wonder\s*woman|mickey|minnie mouse|disney|pokemon|pikachu|harry\s*potter|hogwarts|star\s*wars|darth\s*vader|marvel|dc comics|elsa\b|frozen\b|mario\b|hello kitty|captain america|black panther|\bhulk\b|\bthor\b|barbie|transformers|spongebob|minion/i

const blockedUserTextPattern =
  /iron\s*man|spider-?man|batman|superman|wonder\s*woman|mickey|minnie mouse|disney|pokemon|pikachu|harry\s*potter|hogwarts|star\s*wars|darth\s*vader|marvel|dc comics|elsa\b|frozen\b|mario\b|hello kitty|captain america|black panther|\bhulk\b|\bthor\b|barbie|transformers|spongebob|minion|\bsuper\s*heros?|\bbreasts?\b|\bboobs?\b|\btits?\b|\bnipples?\b|\bnude\b|\bnaked\b|\bnsfw\b|\bporn\b|\bsexy\b|\bsexual\b|\bsex\b|\berotic\b|\blingerie\b|\bcleavage\b|\bkilling\b|\bmurder\b|\bgore\b/gi

const mentionsCopyrightedProperty = (details = {}) =>
  copyrightedPropertyPattern.test(`${details.keyDetails || ''} ${details.occasion || ''} ${details.refinement || ''}`)

const userSubmittedText = (details = {}) =>
  [details.keyDetails, details.occasion, details.refinement]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')

const sentenceContaining = (source, index) => {
  let start = 0

  for (let i = index - 1; i >= 0; i -= 1) {
    if (/[.!?]/.test(source[i])) {
      start = i + 1
      break
    }
  }

  let end = source.length

  for (let i = index; i < source.length; i += 1) {
    if (/[.!?]/.test(source[i])) {
      end = i
      break
    }
  }

  return source.slice(start, end).trim().replace(/^[,;:\s]+/, '')
}

const findBlockedTextSnippets = (details = {}) => {
  const source = userSubmittedText(details)

  if (!source) {
    return []
  }

  blockedUserTextPattern.lastIndex = 0
  const snippets = []
  const seen = new Set()

  for (const match of source.matchAll(blockedUserTextPattern)) {
    const snippet = sentenceContaining(source, match.index)
    const key = snippet.toLowerCase()

    if (snippet && !seen.has(key)) {
      seen.add(key)
      snippets.push(snippet)
    }
  }

  return snippets
}

const friendlyModerationLabels = (error) => {
  const labelsByKey = {
    sexual: 'sexual content',
    violence: 'violent content',
    hate: 'hateful content',
    'self-harm': 'self-harm content',
    self_harm: 'self-harm content',
  }
  const labels = []
  const seen = new Set()

  for (const item of getModerationCategories(error)) {
    const value = String(item).toLowerCase()
    const key = Object.keys(labelsByKey).find((name) => value.includes(name.replace('_', '-')))

    if (key && !seen.has(key)) {
      seen.add(key)
      labels.push(labelsByKey[key])
    }
  }

  return labels
}

const formatBlockedTextNote = (details, error) => {
  const snippets = findBlockedTextSnippets(details)
  const categories = friendlyModerationLabels(error)
  const parts = []

  if (snippets.length === 1) {
    parts.push(`This text was blocked: "${snippets[0]}".`)
  } else if (snippets.length > 1) {
    parts.push(`This text was blocked: ${snippets.map((item) => `"${item}"`).join('; ')}.`)
  }

  if (categories.length === 1) {
    parts.push(`It was flagged for ${categories[0]}.`)
  } else if (categories.length > 1) {
    parts.push(`It was flagged for ${categories.slice(0, -1).join(', ')} and ${categories.at(-1)}.`)
  }

  return parts.join(' ')
}

const createPublicError = (message, { safety = true } = {}) => {
  const error = new Error(message)
  error.publicMessage = message
  error.safety = safety
  return error
}

const photoRejectionMessage = (error, photoCount = 1, details = {}) => {
  const text = getErrorText(error)
  const prefix = photoCount > 1 ? 'One of the photos could not be used. ' : 'This photo could not be used. '
  let message = `${prefix}Try a closer, well-lit photo of the person's face. Group shots and distant photos are harder to match. You can also generate without a photo.`

  if (/sexual/i.test(text)) {
    message = `${prefix}Please choose a photo where everyone is fully clothed, with faces clearly visible, or generate without a photo.`
  } else if (/violence|self-harm|hate/i.test(text)) {
    message = `${prefix}Please try a different photo of the person, or generate without a photo.`
  }

  const blocked = formatBlockedTextNote(details, error)
  return blocked ? `${message} ${blocked}` : message
}

const publicGenerationError = (error, fallbackMessage, context = {}) => {
  if (error?.publicMessage) {
    return error.publicMessage
  }

  if (!isSafetyRejection(error)) {
    return error instanceof Error ? error.message : fallbackMessage
  }

  const hasPhotos = Boolean(context.hasPhotos)
  const details = context.details || {}
  const blocked = formatBlockedTextNote(details, error)

  if (blocked) {
    return `The genie couldn't create that card. ${blocked} No card was created. Change that wording and try again.`
  }

  if (hasPhotos) {
    return photoRejectionMessage(error, context.photoCount || 1, details)
  }

  if (mentionsCopyrightedProperty(details)) {
    return 'Card Genie cannot put trademarked characters or brands on the cover. Try describing the hobby without naming a superhero or brand, then generate again.'
  }

  return "The genie couldn't create that card. Try a different image style, or simplify the personal details. No card was created."
}

const maxReferenceImages = 3

const normalizeReferenceImages = (value) => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item) => typeof item === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(item))
    .slice(0, maxReferenceImages)
}

const buildImagePrompt = (details, refinement = '', imageMode = 'new') => `
${imageMode === 'revise' ? 'Create a revised version of the existing front cover concept for a personalized greeting card.' : 'Create the front cover artwork for a personalized greeting card.'}

The generated image must be portrait artwork at ${COVER_IMAGE_WIDTH}px wide by ${COVER_IMAGE_HEIGHT}px tall, composed for a greeting-card cover in standard 5x7 proportions. The app will place this image inside a separate card frame, so do not add paper edges, borders, shadows, mockups, envelopes, UI, or folded-card effects.

Occasion: ${details.occasion}
Recipient: ${details.recipientName || details.recipientType}
Relationship: ${details.recipientType}
Tone: ${details.tone}
Visual style: ${details.imageStyle || 'AI chooses the best style for this card'}
Important personal context: ${details.keyDetails}

Physical appearance from personal details:
- When the sender describes how someone looks (height, eye color, hair, glasses, build, age cues, clothing colors, etc.), use those details to depict people accurately on the cover.
- Physical adjectives and appearance notes in the personal context are primarily for cover artwork, not for text on the card. Reflect them visually when people appear on the cover.

Name and relationship context: the recipient is named "${details.recipientName || 'the recipient'}" and is described by the sender as "${details.recipientType}". The sender is named "${details.senderName || 'the sender'}". Use these names and relationship clues only as soft visual context for age, relationship, and casting when they are obvious. Do not add gender questions, do not stereotype, and do not force a photorealistic person if a symbolic or illustrative scene would work better.
${refinement ? `\nUser refinement request: ${refinement}` : ''}

Revision mode:
${
  imageMode === 'revise'
    ? '- Treat the user refinement as an edit direction, not a request for a brand-new card. Preserve the same overall concept, subject matter, mood, composition, visual style, color palette, and emotional intent as much as possible. Only change the specific things the user requested. If the request is small, keep the result close to the prior concept.'
    : '- Create a fresh cover concept from the card details and user direction. You may change the composition, subject matter, style, and overall concept if it better satisfies the request.'
}

Composition requirements:
- Portrait artwork composed for a 5x7 greeting-card cover at full ${COVER_IMAGE_WIDTH}x${COVER_IMAGE_HEIGHT} size. Do not shrink the artwork or add empty letterboxing.
- Treat the outer ${COVER_SAFE_MARGIN_PERCENT}% on every side as a protected safe margin for print trimming. Background, color, texture, and soft scenery may extend all the way to the edges.
- Essential content that must stay fully inside the central ${100 - COVER_SAFE_MARGIN_PERCENT * 2}% safe area (not in the outer ${COVER_SAFE_MARGIN_PERCENT}% band): all text; faces and heads; the main subject; hands or body parts that define the scene; key props; and any small detail meant to be read or noticed.
- Main subject centered with clear visual breathing room inside the safe area, not pressed against the margin line.
- Background should extend naturally to the edges so the printed card can be trimmed cleanly.
- Focus on an emotionally warm scene or symbolic illustration inspired by the personal context.
- It should feel like premium editorial or storybook artwork made for a finished greeting-card cover.

Cover text direction:
- Use judgment based on the occasion, tone, recipient, and personal context.
- Use the selected visual style as the primary art direction. If the style is "AI chooses the best style for this card", choose the medium that best fits the occasion and tone.
- For photorealistic styles, make it look like a natural, real photographed greeting-card cover scene with believable lighting, skin texture, fabric, and imperfections.
- For "Comic book art", the entire cover must read as printed comic-book illustration: inked linework, color holds, screentone or halftone, and comic anatomy. If people are described from reference photos, they must appear as comic characters with a recognizable stylized likeness, never as photographed people.
- For other illustrated styles such as vector, storybook, watercolor, paper-cut, poster, collage, or 3D, make the medium unmistakable and consistent across the whole image.
- Include a small amount of tasteful cover text only if it improves the greeting card.
- If cover text is used, keep it short, legible, correctly spelled, and emotionally appropriate.
- Choose font style based on the card: elegant serif or script for heartfelt/elegant cards, playful lettering for funny/playful cards, clean modern type for simple or contemporary cards.
- Text should be large enough to read but never oversized, never crowded, and never inside the outer ${COVER_SAFE_MARGIN_PERCENT}% safe margin.
- Prefer one concise phrase such as "Happy Birthday", "Thinking of You", "Thank You", or a short occasion-specific line. Avoid long sentences.
- Names and ages are allowed only when they fit naturally and remain fully inside the central safe area.

Copyright and identity:
- Do not depict trademarked superheroes, movie characters, logos, brands, or celebrity likenesses even if they are mentioned in the personal context.
- If the sender mentions a copyrighted character or brand, translate it into original greeting-card imagery with the same feeling. For example, a heroic inventor in original red-and-gold armor rather than a trademarked superhero.
- Stay in the selected art style. Never output a photograph unless the selected style is photorealistic.

Negative requirements:
- No text, letters, numbers, captions, signs, banners, labels, posters, plaques, handwriting, or decorative typography within the outer ${COVER_SAFE_MARGIN_PERCENT}% safe margin.
- No faces, heads, main subjects, key props, or other essential details within that same outer ${COVER_SAFE_MARGIN_PERCENT}% band.
- No white border, margin, frame, matting, drop shadow, mockup, envelope, folded card, or UI.
- No cropped-off subject, no text near margins, no layout elements near edges.
`

const buildImageEditPrompt = (details, refinement = '') => `
Edit the provided greeting-card cover image. Use the uploaded image as the source of truth.

User edit request: ${refinement}

Preserve the existing card concept, subject matter, composition, crop, visual style, color palette, mood, and emotional intent unless the user explicitly asks to change one of those things. Make only the requested edit. For example, if the user asks to make one person blonde, keep the same people, pose, setting, style, and layout while changing only that person's hair color.

Card context:
- Occasion: ${details.occasion}
- Recipient: ${details.recipientName || details.recipientType}
- Relationship: ${details.recipientType}
- Tone: ${details.tone}
- Visual style: ${details.imageStyle || 'AI chooses the best style for this card'}
- Personal context: ${details.keyDetails}

Keep the output as portrait artwork composed for a 5x7 greeting-card cover at full ${COVER_IMAGE_WIDTH}x${COVER_IMAGE_HEIGHT} size. Do not shrink the artwork or add empty letterboxing. Do not add borders, paper edges, frames, mockups, envelopes, or UI. Keep essential content (text, faces, heads, main subject, key props) fully inside the central safe area — at least ${COVER_SAFE_MARGIN_PERCENT}% away from every edge for print trimming; background may still extend to the edges. Do not place new text in the outer ${COVER_SAFE_MARGIN_PERCENT}% safe margin.
`

const getOpenAI = () =>
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

const validateDetails = (details) => {
  const requiredFields = ['recipientType', 'senderName', 'occasion', 'tone', 'length', 'keyDetails']
  return requiredFields.filter((field) => !details[field]?.trim())
}

const getLengthRange = (length = '') => {
  const match = length.match(/(\d+)\s*-\s*(\d+)\s*words/i)
  return match ? { min: Number(match[1]), max: Number(match[2]) } : null
}

const copyLengthSpecs = [
  { id: 'short', label: 'Short, 5-20 words', min: 5, max: 20 },
  { id: 'medium', label: 'Medium, 20-40 words', min: 20, max: 40 },
  { id: 'long', label: 'Long, 40-70 words', min: 40, max: 70 },
]

const countWords = (message = '') => message.trim().split(/\s+/).filter(Boolean).length

const trimToWordLimit = (message, maxWords) => {
  const cleanMessage = message.trim().replace(/\s+/g, ' ')
  const words = cleanMessage.split(/\s+/).filter(Boolean)

  if (words.length <= maxWords) {
    return cleanMessage
  }

  const sentences = cleanMessage.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []
  let fitted = ''

  for (const sentence of sentences) {
    const candidate = `${fitted} ${sentence.trim()}`.trim()

    if (candidate.split(/\s+/).filter(Boolean).length > maxWords) {
      break
    }

    fitted = candidate
  }

  if (fitted) {
    return /[.!?]$/.test(fitted) ? fitted : `${fitted}.`
  }

  return `${words.slice(0, maxWords).join(' ').replace(/[,\s]+$/, '')}.`
}

const fitCopyToLength = async (openai, details, copy) => {
  const range = getLengthRange(details.length)

  if (!range || countWords(copy.message) <= range.max) {
    return copy
  }

  const rewriteResponse = await openai.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: `
Rewrite this greeting card body to fit ${range.min}-${range.max} words.
Return strict JSON only with this shape:
{
  "message": "Body copy only, ${range.min}-${range.max} words.",
  "closing": "${copy.closing || 'With love,'}"
}

Keep the same recipient, occasion, tone, and most important personal detail.
Do not include salutation, closing, sender name, placeholder, or signature in the message.
Do not mention physical appearance (height, eye color, hair, build, etc.).

Current body:
${copy.message}
`,
  })
  const rewritten = parseCopyResponse(rewriteResponse)

  return {
    message: trimToWordLimit(rewritten.message, range.max),
    closing: rewritten.closing || copy.closing,
  }
}

const generateCopy = async (openai, details, refinement = '', _referenceImages = [], likenessBrief = '') => {
  const messageKeyDetails = extractMessageKeyDetails(getOriginalKeyDetails(details))
  const prompt = `${buildCopyPrompt(details, refinement, messageKeyDetails)}${buildLikenessBriefSection(likenessBrief)}
If a likeness brief is provided, you may use it to know who the card is about, but do not describe anyone's physical appearance in the message. Do not mention photos or that you saw pictures.`

  const copyResponse = await openai.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: prompt,
  })

  const copy = await fitCopyToLength(openai, details, parseCopyResponse(copyResponse))

  return {
    ...copy,
    message: stripAppearanceFromMessage(copy.message),
  }
}

const generateCopyVariants = async (openai, details, likenessBrief = '') => {
  const messageKeyDetails = extractMessageKeyDetails(getOriginalKeyDetails(details))
  const prompt = `
Write three inside-message versions for a personalized greeting card: short, medium, and long.

Recipient: ${details.recipientName || details.recipientType}
Recipient type or relationship: ${details.recipientType}
Sender: ${details.senderName}
Occasion: ${details.occasion}
Tone: ${details.tone}
Personal details to include: ${messageKeyDetails || 'Use the occasion, tone, and relationship only.'}
${buildLikenessBriefSection(likenessBrief)}
${
  messageKeyDetails.trim() !== (details.keyDetails || '').trim()
    ? '\nNote: Physical appearance details were removed from the list above. They are used only for the cover artwork. Do not infer, describe, or compliment anyone\'s looks, height, hair, eyes, figure, or skin tone.'
    : ''
}

Return strict JSON only, with this shape:
{
  "short": "Body copy only, 5-20 words. No salutation, closing, sender name, or signature.",
  "medium": "Body copy only, 20-40 words. No salutation, closing, sender name, or signature.",
  "long": "Body copy only, 40-70 words. No salutation, closing, sender name, or signature.",
  "closing": "A short closing phrase appropriate to the occasion, tone, and relationship."
}

Rules:
- All three versions must share the same emotional idea and personal details, just at different lengths.
- Strictly obey each word-count range for the body only.
- Do not include a salutation like "Dear..." or the sender name/signature in any body.
- Do NOT mention physical appearance in any version.
- If a likeness brief is provided, you may use it to know who the card is about, but do not describe anyone's physical appearance. Do not mention photos.
`

  const copyResponse = await openai.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: prompt,
  })

  const text = stripCodeFence(getMessageText(copyResponse))
  const parsed = parseJsonishText(text) || {}
  const closing = String(parsed.closing || 'With love,').trim() || 'With love,'
  const variants = {}

  for (const spec of copyLengthSpecs) {
    const raw = String(parsed[spec.id] || '').trim()
    const cleaned = stripAppearanceFromMessage(raw)
    variants[spec.id] = trimToWordLimit(cleaned || raw, spec.max)
  }

  if (!variants.short || !variants.medium || !variants.long) {
    const fallback = await generateCopy(openai, { ...details, length: 'Medium, 20-40 words' }, '', [], likenessBrief)
    return {
      message: fallback.message,
      closing: fallback.closing,
      selectedLength: 'medium',
      messageVariants: {
        short: fallback.message,
        medium: fallback.message,
        long: fallback.message,
      },
    }
  }

  return {
    message: variants.medium,
    closing,
    selectedLength: 'medium',
    messageVariants: variants,
  }
}

const generateImageFromPrompt = async (openai, prompt) => {
  const imageResponse = await openai.images.generate({
    ...buildImageModelParams(),
    prompt,
  })

  return getGeneratedImageUrl(imageResponse, 'OpenAI did not return an image.')
}

const generateImage = async (
  openai,
  details,
  refinement = '',
  imageMode = 'new',
  referenceImages = [],
  likenessBrief = '',
) => {
  const photoGuidance = buildAttachedPhotoGuidance(referenceImages.length > 0)
  const likenessSection = buildLikenessBriefSection(likenessBrief, details.imageStyle)
  const prompt = `${buildImagePrompt(details, refinement, imageMode)}${photoGuidance}${likenessSection}`
  const referenceFiles = referenceImages.length > 0 ? await referenceImagesToFiles(referenceImages) : []

  if (referenceFiles.length > 0) {
    return editImageWithFiles(openai, prompt, referenceFiles)
  }

  return generateImageFromPrompt(openai, prompt)
}

const isGptImageModel = (model) => /gpt-image/i.test(String(model || ''))

const buildImageModelParams = () => {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare'
  const params = {
    model,
    size: COVER_IMAGE_SIZE,
    quality: 'medium',
  }

  if (!isGptImageModel(model)) {
    params.response_format = 'b64_json'
  }

  return params
}

/** Always return a data URL so browsers never depend on expiring/CORS-blocked OpenAI URLs. */
const getGeneratedImageUrl = async (imageResponse, fallbackMessage) => {
  const item = imageResponse?.data?.[0]
  if (item?.b64_json) {
    return `data:image/png;base64,${item.b64_json}`
  }

  if (item?.url) {
    const response = await fetch(item.url)
    if (!response.ok) {
      throw new Error(fallbackMessage)
    }
    const contentType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim() || 'image/png'
    const base64 = Buffer.from(await response.arrayBuffer()).toString('base64')
    return `data:${contentType};base64,${base64}`
  }

  throw new Error(fallbackMessage)
}

const imageUrlToFile = async (imageUrl, fileName = 'current-cover.png') => {
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')

  if (dataUrlMatch) {
    const [, mimeType, imageBase64] = dataUrlMatch
    return toFile(Buffer.from(imageBase64, 'base64'), fileName, { type: mimeType })
  }

  if (/^https?:\/\//.test(imageUrl || '')) {
    const response = await fetch(imageUrl)

    if (!response.ok) {
      throw new Error('Unable to load the current cover image for editing.')
    }

    const contentType = response.headers.get('content-type') || 'image/png'
    const imageBuffer = Buffer.from(await response.arrayBuffer())
    return toFile(imageBuffer, fileName, { type: contentType })
  }

  throw new Error('Unable to edit the cover because the current image is missing or invalid.')
}

const referenceImagesToFiles = (referenceImages) =>
  Promise.all(referenceImages.map((imageUrl, index) => imageUrlToFile(imageUrl, `reference-${index + 1}.jpg`)))

const editImageWithFiles = async (openai, prompt, imageFiles) => {
  const imageResponse = await openai.images.edit({
    ...buildImageModelParams(),
    image: imageFiles,
    prompt,
  })

  return getGeneratedImageUrl(imageResponse, 'OpenAI did not return an edited image.')
}

const editImage = async (
  openai,
  details,
  refinement,
  currentImageUrl,
  referenceImages = [],
  likenessBrief = '',
  resolveCurrentImageUrl,
) => {
  let sourceUrl = typeof currentImageUrl === 'string' ? currentImageUrl.trim() : ''
  if ((!sourceUrl || sourceUrl.length < 64) && typeof resolveCurrentImageUrl === 'function') {
    sourceUrl = (await resolveCurrentImageUrl()) || ''
  }

  if (!sourceUrl) {
    throw new Error('Unable to load the current cover image for editing.')
  }

  const currentImage = await imageUrlToFile(sourceUrl)
  const referenceFiles = await referenceImagesToFiles(referenceImages)
  const prompt = `${buildImageEditPrompt(details, refinement)}${buildReferenceImageGuidance(referenceFiles.length > 0, details.imageStyle)}${buildLikenessBriefSection(likenessBrief, details.imageStyle)}
If additional reference photos are attached after the current cover, use them only for likeness and personal context. Edit the current cover image, not the reference photos.`

  try {
    return await editImageWithFiles(
      openai,
      prompt,
      referenceFiles.length > 0 ? [currentImage, ...referenceFiles] : [currentImage],
    )
  } catch (error) {
    if (!isSafetyRejection(error) || referenceFiles.length === 0) {
      throw error
    }

    return editImageWithFiles(
      openai,
      `${buildImageEditPrompt(details, refinement)}${buildLikenessBriefSection(likenessBrief, details.imageStyle)}`,
      [currentImage],
    )
  }
}

const getMessageText = (response) => {
  if (response.output_text) {
    return response.output_text.trim()
  }

  const text = response.output
    ?.flatMap((item) => item.content || [])
    .map((content) => content.text)
    .filter(Boolean)
    .join('\n')

  return text?.trim() || ''
}

const describeReferenceImages = async (openai, referenceImages) => {
  if (!referenceImages.length) {
    return ''
  }

  const describe = async (images) => {
    const response = await openai.responses.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: referenceImageDescriptionPrompt,
            },
            ...images.map((imageUrl) => ({
              type: 'input_image',
              image_url: imageUrl,
              detail: 'high',
            })),
          ],
        },
      ],
    })

    return getMessageText(response)
  }

  try {
    return await describe(referenceImages)
  } catch (error) {
    if (!isSafetyRejection(error)) {
      throw error
    }

    if (referenceImages.length === 1) {
      throw createPublicError(photoRejectionMessage(error, 1))
    }
  }

  const briefs = []

  for (const imageUrl of referenceImages) {
    try {
      const brief = await describe([imageUrl])

      if (brief) {
        briefs.push(brief)
      }
    } catch (error) {
      if (!isSafetyRejection(error)) {
        throw error
      }

      throw createPublicError(photoRejectionMessage(error, referenceImages.length))
    }
  }

  if (!briefs.length) {
    throw createPublicError(photoRejectionMessage(undefined, referenceImages.length))
  }

  return briefs.join('\n\n')
}

const stripCodeFence = (value = '') =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

const parseJsonishText = (value = '') => {
  const unfenced = stripCodeFence(value)
  const jsonStart = unfenced.indexOf('{')
  const jsonEnd = unfenced.lastIndexOf('}')

  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return null
  }

  try {
    return JSON.parse(unfenced.slice(jsonStart, jsonEnd + 1))
  } catch {
    return null
  }
}

const parseCopyResponse = (response) => {
  const text = stripCodeFence(getMessageText(response))
  const parsed = parseJsonishText(text)

  if (parsed) {
    return {
      message: parsed.message?.trim() || text,
      closing: parsed.closing?.trim() || 'With love,',
    }
  }

  return {
    message: text,
    closing: 'With love,',
  }
}

const createCardId = () => crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex')

const localApiHostPattern = /^(localhost|127\.0\.0\.1):8787$/i

const resolveFrontendAppUrl = (req) => {
  const configured = String(process.env.SHARE_BASE_URL || process.env.PUBLIC_APP_URL || process.env.DEV_APP_URL || '')
    .replace(/\/$/, '')
  const forwarded = String(req.headers['x-frontend-origin'] || '').replace(/\/$/, '')
  const origin = String(req.headers.origin || '').replace(/\/$/, '')
  const host = req.get('host') || ''

  if (forwarded) {
    return forwarded
  }

  if (origin) {
    try {
      if (!localApiHostPattern.test(new URL(origin).host)) {
        return origin
      }
    } catch {
      // Ignore malformed Origin values.
    }
  }

  if (configured) {
    return configured
  }

  if (localApiHostPattern.test(host)) {
    return 'http://localhost:5173'
  }

  return `${req.protocol}://${host}`.replace(/\/$/, '')
}

const getPublicAppUrl = (req) => resolveFrontendAppUrl(req)

const getShareBaseUrl = (req) => resolveFrontendAppUrl(req)

const getShareUrl = (req, cardId) => `${getShareBaseUrl(req)}/c/${encodeURIComponent(cardId)}`

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const buildSharePreviewCopy = (record) => {
  const recipientName = (record.details.recipientName || '').trim()
  const recipientFirstName = recipientName.split(/\s+/).filter(Boolean)[0] || ''
  const sender = record.signature || record.details.senderName || 'Someone special'
  const occasion = record.details.occasion || 'greeting'
  const title = recipientFirstName
    ? `${recipientFirstName}, ${sender} sent you a ${occasion} card`
    : `${sender} sent you a ${occasion} card`
  const description = recipientFirstName
    ? `${recipientFirstName}, open your personalized card from ${sender}.`
    : `Open your personalized card from ${sender}.`

  return { title, description }
}

const parseDataImage = (imageUrl) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')

  if (!match) {
    return null
  }

  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2], 'base64'),
  }
}

const buildSharePreviewHtml = (record, req) => {
  const { title, description } = buildSharePreviewCopy(record)
  const appUrl = `${getPublicAppUrl(req)}/?card=${encodeURIComponent(record.id)}`
  const imageUrl = `${getShareBaseUrl(req)}/c/${encodeURIComponent(record.id)}/cover`
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(description)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDescription}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Card Genie" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:url" content="${escapeHtml(appUrl)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:type" content="image/png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDescription}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    <link rel="canonical" href="${escapeHtml(appUrl)}" />
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; color: #315f5b; background: linear-gradient(135deg, #fff8ef, #eef3ff); }
      a { color: #fff; background: #f59e33; text-decoration: none; font-weight: 800; border-radius: 16px; padding: 14px 20px; }
      p { margin: 0 0 16px; }
    </style>
  </head>
  <body>
    <main>
      <p>${safeDescription}</p>
      <a href="${escapeHtml(appUrl)}">Open your card</a>
    </main>
    <script>location.replace(${JSON.stringify(appUrl)})</script>
  </body>
</html>`
}

const buildCardRecord = (payload) => {
  const card = payload?.card || {}
  const details = payload?.details || {}
  const imageUrl = card.imageUrl?.trim()
  const message = card.message?.trim()

  if (!imageUrl || !message) {
    throw new Error('Missing card image or message.')
  }

  return {
    id: createCardId(),
    createdAt: new Date().toISOString(),
    details: {
      recipientName: details.recipientName?.trim() || '',
      recipientType: details.recipientType?.trim() || '',
      senderName: details.senderName?.trim() || '',
      occasion: details.occasion?.trim() || '',
    },
    card: {
      imageUrl,
      message,
      closing: card.closing?.trim() || 'With love,',
    },
    greeting: payload?.greeting?.trim() || '',
    signature: payload?.signature?.trim() || details.senderName?.trim() || 'Your Name',
  }
}

const getCardSummary = (record, req) => ({
  ...record,
  shareUrl: getShareUrl(req, record.id),
})

const getEmailCoverUrl = (req, cardId) =>
  `${req.protocol}://${req.get('host')}/c/${encodeURIComponent(cardId)}/cover`

const buildCoverThumbnailHtml = (coverUrl, alt = 'Card cover') => `
        <p style="margin: 0 0 16px;">
          <img
            src="${coverUrl}"
            alt="${escapeHtml(alt)}"
            width="120"
            style="display:block;width:120px;max-width:120px;height:auto;border:0;border-radius:10px;"
          />
        </p>`

const buildDeliveryCopy = (record, shareUrl, coverUrl) => {
  const recipientFirstName = (record.details.recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const sender = record.signature || record.details.senderName || 'Someone special'
  const occasion = record.details.occasion || 'card'
  const openLine = recipientFirstName
    ? `${recipientFirstName}, open your personalized card from ${sender}.`
    : `Open your personalized card from ${sender}.`
  const thumbnailAlt = `${occasion} card cover from ${sender}`

  return {
    subject: `${sender} sent you a ${occasion} card`,
    text: `${openLine} ${shareUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #302632; line-height: 1.5;">
        ${buildCoverThumbnailHtml(coverUrl, thumbnailAlt)}
        <p>${openLine}</p>
        <p><a href="${shareUrl}" style="display:inline-block;padding:12px 18px;background:#f59e33;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Open your card</a></p>
        <p>If the button does not work, copy and paste this link: <br /><a href="${shareUrl}">${shareUrl}</a></p>
      </div>
    `,
  }
}

const buildSenderCopyDeliveryCopy = (record, shareUrl, coverUrl) => {
  const recipient = record.details.recipientName?.trim() || record.details.recipientType?.trim() || 'your recipient'
  const sender = record.signature || record.details.senderName || 'You'
  const thumbnailAlt = `Cover of the card you sent to ${recipient}`

  return {
    subject: `Your copy of the card for ${recipient}`,
    text: `Here is a copy of the card you sent to ${recipient}. ${shareUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #302632; line-height: 1.5;">
        ${buildCoverThumbnailHtml(coverUrl, thumbnailAlt)}
        <p>Here is a copy of the card you sent to ${recipient}.</p>
        <p><a href="${shareUrl}" style="display:inline-block;padding:12px 18px;background:#f59e33;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Open your card</a></p>
        <p>If the button does not work, copy and paste this link: <br /><a href="${shareUrl}">${shareUrl}</a></p>
        <p style="margin-top: 18px; color: #666;">Sent by ${sender} through Card Genie.</p>
      </div>
    `,
  }
}

const parseEmailSender = (from = '') => {
  const match = from.trim().match(/^(.*?)\s*<([^>]+)>$/)

  if (!match) {
    return { email: from.trim() }
  }

  const [, name, email] = match
  return {
    email: email.trim(),
    ...(name.trim() ? { name: name.trim().replace(/^"|"$/g, '') } : {}),
  }
}

const sendSendGridEmailDelivery = async ({ to, copy, attachments = [] }) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
  }

  const payload = {
    personalizations: [
      {
        to: [{ email: to }],
        subject: copy.subject,
      },
    ],
    from: parseEmailSender(process.env.EMAIL_FROM),
    content: [
      { type: 'text/plain', value: copy.text },
      { type: 'text/html', value: copy.html },
    ],
    tracking_settings: {
      click_tracking: {
        enable: true,
        enable_text: false,
      },
    },
  }

  if (attachments.length) {
    payload.attachments = attachments.map((attachment) => ({
      content: attachment.content,
      filename: attachment.filename,
      type: attachment.type || 'application/octet-stream',
      disposition: attachment.disposition === 'inline' ? 'inline' : 'attachment',
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
    }))
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`SendGrid could not send the card. ${errorText}`)
  }

  return to
}

const sendPostmarkEmailDelivery = async ({ to, copy, attachments = [] }) => {
  if (!process.env.POSTMARK_SERVER_TOKEN || !process.env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add POSTMARK_SERVER_TOKEN and EMAIL_FROM.')
  }

  const payload = {
    From: process.env.EMAIL_FROM,
    To: to,
    Subject: copy.subject,
    TextBody: copy.text,
    HtmlBody: copy.html,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
  }

  if (attachments.length) {
    payload.Attachments = attachments.map((attachment) => ({
      Name: attachment.filename,
      Content: attachment.content,
      ContentType: attachment.type || 'application/octet-stream',
      ...(attachment.contentId
        ? {
            ContentID: attachment.contentId,
            Disposition: 'inline',
          }
        : {}),
    }))
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Postmark could not send the card. ${errorText}`)
  }

  return to
}

const sendEmailDelivery = async ({ to, copy, attachments = [] }) => {
  if (process.env.SENDGRID_API_KEY) {
    return sendSendGridEmailDelivery({ to, copy, attachments })
  }

  if (process.env.POSTMARK_SERVER_TOKEN) {
    return sendPostmarkEmailDelivery({ to, copy, attachments })
  }

  throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
}

const PRINT_ORDER_SUPPORT_EMAIL = 'support@card-genie.com'
const PRINT_CARD_CREDIT_COST = 10
let localPrintOrderNumber = 1000

const allocateLocalPrintOrderNumber = () => {
  localPrintOrderNumber += 1
  return localPrintOrderNumber
}

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])

const parseDataUrlImage = (value, label) => {
  const match = String(value || '').match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) {
    throw new Error(`Provide a valid ${label} print image.`)
  }

  return {
    type: match[1],
    content: match[2],
  }
}

const normalizeMailingAddress = (raw, label) => {
  const address = raw && typeof raw === 'object' ? raw : {}
  const name = String(address.name || '').trim()
  const line1 = String(address.line1 || '').trim()
  const line2 = String(address.line2 || '').trim()
  const city = String(address.city || '').trim()
  const state = String(address.state || '').trim().toUpperCase()
  const zip = String(address.zip || '').trim().replace(/\s+/g, '')
  const country = String(address.country || 'US').trim().toUpperCase()

  if (!name) {
    throw new Error(`Enter the ${label} name.`)
  }
  if (!line1) {
    throw new Error(`Enter the ${label} street address.`)
  }
  if (!city) {
    throw new Error(`Enter the ${label} city.`)
  }
  if (!US_STATE_CODES.has(state)) {
    throw new Error(`Choose a valid ${label} US state.`)
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    throw new Error(`Enter a valid ${label} ZIP code.`)
  }
  if (country !== 'US' && country !== 'USA' && country !== 'UNITED STATES') {
    throw new Error('Printed cards can only be mailed within the United States right now.')
  }

  return {
    name,
    line1,
    line2,
    city,
    state,
    zip,
    country: 'US',
  }
}

const formatMailingAddressBlock = (address) =>
  [
    address.name,
    address.line1,
    address.line2 || null,
    `${address.city}, ${address.state} ${address.zip}`,
    'United States',
  ]
    .filter(Boolean)
    .join('\n')

const DEFAULT_PRINT_MAIL_FROM = {
  name: 'Card Genie',
  line1: '154 East Prospect Ave',
  line2: '',
  city: 'Danville',
  state: 'CA',
  zip: '94526',
  country: 'US',
}

const normalizeAddressKeyPart = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')

const isDefaultPrintMailFrom = (mailFrom) => {
  if (!mailFrom || typeof mailFrom !== 'object') {
    return true
  }

  return (
    normalizeAddressKeyPart(mailFrom.name) === normalizeAddressKeyPart(DEFAULT_PRINT_MAIL_FROM.name) &&
    normalizeAddressKeyPart(mailFrom.line1) === normalizeAddressKeyPart(DEFAULT_PRINT_MAIL_FROM.line1) &&
    normalizeAddressKeyPart(mailFrom.line2) === normalizeAddressKeyPart(DEFAULT_PRINT_MAIL_FROM.line2) &&
    normalizeAddressKeyPart(mailFrom.city) === normalizeAddressKeyPart(DEFAULT_PRINT_MAIL_FROM.city) &&
    normalizeAddressKeyPart(mailFrom.state) === normalizeAddressKeyPart(DEFAULT_PRINT_MAIL_FROM.state) &&
    String(mailFrom.zip || '').trim().replace(/\s+/g, '') === DEFAULT_PRINT_MAIL_FROM.zip
  )
}

const buildPrintOrderEmailCopy = ({ cardId, orderCode, shareUrl, mailFrom, shipTo, details, shopperEmail }) => {
  const occasion = String(details?.occasion || '').trim() || 'greeting card'
  const recipient = String(details?.recipientName || shipTo.name || 'recipient').trim()
  const subject = `Print card order · ${orderCode} · ${shipTo.name}`
  const text = [
    'New printed card order from Card Genie.',
    '',
    `Order number: ${orderCode}`,
    `Card ID: ${cardId}`,
    shopperEmail ? `Shopper email: ${shopperEmail}` : null,
    '',
    'Mail from:',
    formatMailingAddressBlock(mailFrom),
    '',
    'Ship to:',
    formatMailingAddressBlock(shipTo),
    '',
    `Occasion: ${occasion}`,
    `Card recipient name: ${recipient}`,
    shareUrl ? `Share link: ${shareUrl}` : null,
    '',
    'Print files are attached:',
    '- print-cover.png',
    '- print-inside.png',
  ]
    .filter((line) => line !== null)
    .join('\n')

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #16272b;">
      <h2 style="margin: 0 0 12px;">New printed card order</h2>
      <p style="margin: 0 0 16px;">A shopper requested a physical greeting card mailing.</p>
      <p style="margin: 0 0 4px; font-size: 1.15rem;"><strong>Order number:</strong> ${orderCode}</p>
      <p style="margin: 0 0 4px;"><strong>Card ID:</strong> ${cardId}</p>
      ${shopperEmail ? `<p style="margin: 0 0 16px;"><strong>Shopper email:</strong> ${shopperEmail}</p>` : '<p style="margin: 0 0 16px;"></p>'}
      <p style="margin: 0 0 6px;"><strong>Mail from</strong></p>
      <pre style="margin: 0 0 16px; font-family: Arial, sans-serif; white-space: pre-wrap;">${formatMailingAddressBlock(mailFrom)}</pre>
      <p style="margin: 0 0 6px;"><strong>Ship to</strong></p>
      <pre style="margin: 0 0 16px; font-family: Arial, sans-serif; white-space: pre-wrap;">${formatMailingAddressBlock(shipTo)}</pre>
      <p style="margin: 0 0 4px;"><strong>Occasion:</strong> ${occasion}</p>
      <p style="margin: 0 0 4px;"><strong>Card recipient name:</strong> ${recipient}</p>
      ${shareUrl ? `<p style="margin: 0 0 16px;"><strong>Share link:</strong> <a href="${shareUrl}">${shareUrl}</a></p>` : ''}
      <p style="margin: 0;">Print files are attached as <strong>print-cover.png</strong> and <strong>print-inside.png</strong>.</p>
    </div>
  `

  return { subject, text, html }
}

const buildPrintOrderConfirmationCopy = ({ orderCode, shipTo, mailFrom }) => {
  const shipToBlock = formatMailingAddressBlock(shipTo)
  const includeReturnAddress = mailFrom && !isDefaultPrintMailFrom(mailFrom)
  const returnAddressBlock = includeReturnAddress ? formatMailingAddressBlock(mailFrom) : ''
  const subject = `Your Card Genie printed card order - ${orderCode}`
  const deliveryCopy =
    "Your card will be mailed out the next business day via USPS regular mail, from Northern California. Once mailed, it'll take 3 to 7 business days for delivery."
  const text = [
    "We've received your Card Genie print order. Thank you!",
    '',
    `Order number: ${orderCode}`,
    '',
    'Shipping to:',
    shipToBlock,
    includeReturnAddress ? '' : null,
    includeReturnAddress ? 'Return address:' : null,
    includeReturnAddress ? returnAddressBlock : null,
    '',
    deliveryCopy,
    '',
    'Previews of your card cover and inside are included in this email.',
  ]
    .filter((line) => line !== null)
    .join('\n')

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #16272b;">
      <p style="margin: 0 0 12px;">We've received your Card Genie print order. Thank you!</p>
      <p style="margin: 0 0 16px; font-size: 1.1rem;"><strong>Order number:</strong> ${orderCode}</p>
      <p style="margin: 0 0 6px;"><strong>Shipping to</strong></p>
      <pre style="margin: 0 0 16px; font-family: Arial, sans-serif; white-space: pre-wrap;">${shipToBlock}</pre>
      ${
        includeReturnAddress
          ? `<p style="margin: 0 0 6px;"><strong>Return address</strong></p>
      <pre style="margin: 0 0 16px; font-family: Arial, sans-serif; white-space: pre-wrap;">${returnAddressBlock}</pre>`
          : ''
      }
      <p style="margin: 0 0 16px;">${deliveryCopy}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding: 0 12px 0 0; vertical-align: top;">
            <p style="margin: 0 0 6px; font-size: 0.85rem; color: #666;">Cover</p>
            <img src="cid:print-cover-thumb" alt="Card cover" width="140" style="display:block;width:140px;max-width:140px;height:auto;border:0;border-radius:8px;" />
          </td>
          <td style="padding: 0; vertical-align: top;">
            <p style="margin: 0 0 6px; font-size: 0.85rem; color: #666;">Inside</p>
            <img src="cid:print-inside-thumb" alt="Card inside" width="140" style="display:block;width:140px;max-width:140px;height:auto;border:1px solid #d0d0d0;border-radius:8px;" />
          </td>
        </tr>
      </table>
      <p style="margin: 18px 0 0; color: #666; font-size: 0.9rem;">Questions? Email support@card-genie.com and include your order number.</p>
    </div>
  `

  return { subject, text, html }
}

const getTwilioAuthCredentials = () => {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_AUTH_TOKEN } = process.env

  if (!TWILIO_ACCOUNT_SID) {
    throw new Error('Text delivery is not configured. Add TWILIO_ACCOUNT_SID.')
  }

  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    return {
      accountSid: TWILIO_ACCOUNT_SID,
      username: TWILIO_API_KEY_SID,
      password: TWILIO_API_KEY_SECRET,
    }
  }

  if (TWILIO_AUTH_TOKEN) {
    return {
      accountSid: TWILIO_ACCOUNT_SID,
      username: TWILIO_ACCOUNT_SID,
      password: TWILIO_AUTH_TOKEN,
    }
  }

  throw new Error('Text delivery is not configured. Add TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.')
}

const normalizePhoneNumber = (phoneNumber) => {
  const trimmed = phoneNumber?.trim() || ''

  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    return trimmed
  }

  const digits = trimmed.replace(/\D/g, '')

  if (digits.length === 10) {
    return `+1${digits}`
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }

  if (digits.length < 10) {
    throw new Error('Cellphone number looks incomplete. Use 10 digits, like (925) 555-1234.')
  }

  if (digits.length > 11) {
    throw new Error('Cellphone number has too many digits. Use a US number like (925) 555-1234.')
  }

  throw new Error('Enter a valid US cellphone number. Example: (925) 555-1234.')
}

const normalizeEmailAddress = (email = '') => {
  const formatted = email.trim().toLowerCase()

  if (!formatted) {
    throw new Error('Enter the recipient email address.')
  }

  if (/\s/.test(formatted)) {
    throw new Error('Remove spaces from the email address.')
  }

  if (!formatted.includes('@')) {
    throw new Error('Email is missing the @ symbol. Example: jamie@example.com')
  }

  const [localPart, domainPart, ...extraParts] = formatted.split('@')

  if (!localPart || !domainPart || extraParts.length > 0) {
    throw new Error('Enter a complete email address. Example: jamie@example.com')
  }

  if (!domainPart.includes('.')) {
    throw new Error('Email domain is missing a period. Did you mean something like example.com?')
  }

  if (domainPart.startsWith('.') || domainPart.endsWith('.') || domainPart.includes('..')) {
    throw new Error('Check the email domain. Example: jamie@example.com')
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formatted)) {
    throw new Error('Enter a valid email address. Example: jamie@example.com')
  }

  const topLevelDomain = domainPart.split('.').at(-1) || ''

  if (topLevelDomain.length < 2) {
    throw new Error('Email ending looks incomplete. Did you mean .com, .net, or .org?')
  }

  return formatted
}

const sendTextDelivery = async ({ to, copy }) => {
  const { TWILIO_FROM_NUMBER } = process.env

  if (!TWILIO_FROM_NUMBER) {
    throw new Error('Text delivery is not configured. Add TWILIO_FROM_NUMBER.')
  }

  const twilioAuth = getTwilioAuthCredentials()
  const normalizedTo = normalizePhoneNumber(to)

  const form = new URLSearchParams({
    From: TWILIO_FROM_NUMBER,
    To: normalizedTo,
    Body: copy.text,
  })

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAuth.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${twilioAuth.username}:${twilioAuth.password}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Twilio could not send the card. ${errorText}`)
  }

  return normalizedTo
}

const generateJobTimeoutMs = 12 * 60 * 1000
const generateJobMaxAttempts = 3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const saveGenerateJob = async (job) => {
  const record = { ...job, updatedAt: Date.now() }
  jobStore.set(record.id, record)
  return record
}

const getGenerateJob = async (jobId) => jobStore.get(jobId) || null

const publicGenerateJob = (job) => {
  if (!job) {
    return null
  }

  return {
    jobId: job.id,
    status: job.status,
    error: job.error || undefined,
    message: job.result?.message,
    closing: job.result?.closing,
    selectedLength: job.result?.selectedLength,
    messageVariants: job.result?.messageVariants,
    imageUrl: job.result?.imageUrl,
  }
}

const failGenerateJob = async (job, error, details, photoCount) => {
  const message = publicGenerationError(error, 'Unable to generate the card. Please try again.', {
    hasPhotos: photoCount > 0,
    photoCount,
    details,
  })

  const failed = {
    ...job,
    status: 'failed',
    error: message,
    referenceImages: [],
    result: null,
  }

  try {
    return await saveGenerateJob(failed)
  } catch (saveError) {
    console.error(saveError)
    return { ...failed, updatedAt: Date.now() }
  }
}

const expireStuckGenerateJob = async (job) => {
  if (!job || job.status === 'complete' || job.status === 'failed') {
    return job
  }

  if (Date.now() - (job.updatedAt || job.createdAt || 0) < generateJobTimeoutMs) {
    return job
  }

  try {
    return await saveGenerateJob({
      ...job,
      status: 'failed',
      error: 'That card took too long. Please try generating again. Your credits are still in your account.',
      referenceImages: [],
      result: null,
    })
  } catch (error) {
    console.error(error)
    return {
      ...job,
      status: 'failed',
      error: 'That card took too long. Please try generating again. Your credits are still in your account.',
      referenceImages: [],
      result: null,
      updatedAt: Date.now(),
    }
  }
}

const processGenerateJob = async (jobInput) => {
  const jobId = typeof jobInput === 'string' ? jobInput : jobInput?.id
  let job = typeof jobInput === 'object' && jobInput ? jobInput : null

  try {
    job = (await getGenerateJob(jobId)) || job
  } catch (error) {
    if (!job) {
      throw error
    }

    console.error(error)
  }

  if (!job || job.status === 'complete' || job.status === 'failed') {
    return
  }

  job = await saveGenerateJob({ ...job, status: 'processing' })
  const details = job.details || {}
  const referenceImages = normalizeReferenceImages(job.referenceImages)
  let lastError

  for (let attempt = 1; attempt <= generateJobMaxAttempts; attempt += 1) {
    try {
      const openai = getOpenAI()
      const likenessBrief = await describeReferenceImages(openai, referenceImages)
      const [copy, imageUrl] = await Promise.all([
        generateCopyVariants(openai, details, likenessBrief),
        generateImage(openai, details, '', 'new', referenceImages, likenessBrief),
      ])

      if (!copy.message || !imageUrl) {
        throw new Error('OpenAI did not return both a message and an image.')
      }

      try {
        await saveGenerateJob({
          ...job,
          status: 'complete',
          error: '',
          referenceImages: [],
          result: {
            message: copy.message,
            closing: copy.closing,
            selectedLength: copy.selectedLength || 'medium',
            messageVariants: copy.messageVariants || undefined,
            imageUrl,
          },
        })
        return
      } catch (saveError) {
        console.error(saveError)
        const persistError = new Error(
          'The card was created, but we could not save it. Please try generating again.',
        )
        persistError.publicMessage = persistError.message
        throw persistError
      }
    } catch (error) {
      lastError = error
      console.error(error)

      if (!isTransientGenerationError(error) || attempt === generateJobMaxAttempts) {
        await failGenerateJob(job, error, details, referenceImages.length)
        return
      }

      await saveGenerateJob({ ...job, status: 'processing', attempt })
      await sleep(1500 * attempt)
    }
  }

  if (lastError) {
    await failGenerateJob(job, lastError, details, referenceImages.length)
  }
}

app.post('/api/generate-card', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const { referenceImages: rawReferenceImages, ...details } = req.body || {}
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details)

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(', ')}`,
    })
  }

  try {
    const job = await saveGenerateJob({
      id: createCardId(),
      status: 'queued',
      details,
      referenceImages,
      createdAt: Date.now(),
      attempt: 0,
      error: '',
      result: null,
    })

    res.status(202).json({ jobId: job.id, status: 'queued' })
    void processGenerateJob(job).catch(async (error) => {
      console.error(error)
      try {
        await failGenerateJob(job, error, details, referenceImages.length)
      } catch (failError) {
        console.error(failError)
      }
    })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Unable to start creating the card. Please try again.',
      })
    }
  }
})

app.get('/api/generate-jobs/:jobId', async (req, res) => {
  try {
    if (!req.params.jobId) {
      return res.status(400).json({ error: 'Missing card job.' })
    }

    let job = await getGenerateJob(req.params.jobId)

    if (!job) {
      return res.status(404).json({
        error: 'We could not find that card job. It may have expired. Please generate again.',
      })
    }

    job = await expireStuckGenerateJob(job)
    res.json(publicGenerateJob(job))
  } catch (error) {
    console.error(error)
    res.status(500).json({
      error: 'Unable to check on your card. Please try again.',
    })
  }
})

app.post('/api/refine-image', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const { details, refinement, imageMode, currentImageUrl, cardId, referenceImages: rawReferenceImages } =
    req.body
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(', ')}`,
    })
  }

  if (!refinement?.trim()) {
    return res.status(400).json({
      error: 'Tell us what to change about the cover image.',
    })
  }

  try {
    const openai = getOpenAI()
    const likenessBrief = await describeReferenceImages(openai, referenceImages)
    const imageUrl =
      imageMode === 'new'
        ? await generateImage(openai, details, refinement, 'new', referenceImages, likenessBrief)
        : await editImage(
            openai,
            details,
            refinement,
            currentImageUrl,
            referenceImages,
            likenessBrief,
            async () => {
              const id = typeof cardId === 'string' ? cardId.trim() : ''
              if (!id) {
                return ''
              }
              return cardStore.get(id)?.card?.imageUrl?.trim() || ''
            },
          )

    res.json({ imageUrl })
  } catch (error) {
    console.error(error)
    res.status(isSafetyRejection(error) ? 400 : 500).json({
      error: publicGenerationError(error, 'Unable to refine the image.', {
        hasPhotos: referenceImages.length > 0,
        photoCount: referenceImages.length,
        details: { ...details, refinement },
      }),
    })
  }
})

app.post('/api/auth/otp/start', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Sign-in is only available on the deployed API.' })
  }

  try {
    const phoneE164 = normalizePhoneNumber(req.body?.phone)
    console.log(`[local dev auth] Sign-in code for ${phoneE164}: ${localDevOtpCode}`)
    return res.json({
      ok: true,
      phoneE164,
      message: `Local dev: enter ${localDevOtpCode} (also printed in the API terminal). No text was sent.`,
    })
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to send a sign-in code.',
    })
  }
})

app.post('/api/auth/otp/verify', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Sign-in is only available on the deployed API.' })
  }

  try {
    const phoneE164 = normalizePhoneNumber(req.body?.phone)
    const cleanCode = String(req.body?.code || '')
      .replace(/\D/g, '')
      .padStart(6, '0')
      .slice(-6)

    if (cleanCode !== localDevOtpCode) {
      return res.status(400).json({ error: 'That code does not match. Check the API terminal for the local dev code.' })
    }

    const user = getLocalDevUser(phoneE164)
    user.lastLoginAt = Date.now()
    const token = crypto.randomUUID()
    localAccountSessions.set(token, { token, userId: user.id, phoneE164, createdAt: Date.now() })

    return res.json({
      ok: true,
      token,
      phoneE164,
      email: user.email || '',
      creditBalance: user.creditBalance,
      isNew: false,
      phoneVerifyBonusCredits: 0,
      message: 'Signed in for local testing.',
    })
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to confirm that code.',
    })
  }
})

app.get('/api/account', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Account is only available on the deployed API.' })
  }

  const token = readBearerToken(req)
  const session = token ? localAccountSessions.get(token) : null
  if (!session) {
    return res.status(401).json({ error: 'Confirm your mobile number before viewing your account.' })
  }

  const user = getLocalDevUser(session.phoneE164)
  return res.json({
    ok: true,
    phoneE164: session.phoneE164,
    email: user.email || '',
    creditBalance: user.creditBalance,
  })
})

app.get('/api/account/history', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Account history is only available on the deployed API.' })
  }

  const token = readBearerToken(req)
  const session = token ? localAccountSessions.get(token) : null
  if (!session) {
    return res.status(401).json({ error: 'Confirm your mobile number before viewing your account.' })
  }

  return res.json({
    ok: true,
    phoneE164: session.phoneE164,
    sends: [],
    creditEvents: [],
  })
})

app.post('/api/account/credits', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Account credits are only available on the deployed API.' })
  }

  const token = readBearerToken(req)
  const session = token ? localAccountSessions.get(token) : null
  if (!session) {
    return res.status(401).json({ error: 'Confirm your mobile number before changing credits.' })
  }

  const user = getLocalDevUser(session.phoneE164)
  const balance = Number(req.body?.balance)
  const add = Number(req.body?.add)
  if (Number.isFinite(balance)) {
    user.creditBalance = Math.max(0, balance)
  } else if (Number.isFinite(add)) {
    user.creditBalance = Math.max(0, user.creditBalance + add)
  }

  return res.json({ ok: true, creditBalance: user.creditBalance })
})

const localPacificDayKey = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

const buildLocalMetricsDayKeys = (period = '7d') => {
  const today = localPacificDayKey()
  const [year, month, day] = today.split('-').map((part) => Number(part))
  const normalized = String(period || '7d').trim().toLowerCase()
  let count = 7
  if (normalized === 'today') {
    count = 1
  } else if (normalized === '30d') {
    count = 30
  } else if (normalized === 'ytd') {
    const start = Date.UTC(year, 0, 1)
    const end = Date.UTC(year, month - 1, day)
    count = Math.max(1, Math.floor((end - start) / 86400000) + 1)
  }

  const keys = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const stamp = new Date(Date.UTC(year, month - 1, day - offset, 12, 0, 0))
    keys.push(localPacificDayKey(stamp))
  }
  return { today, period: normalized === 'today' || normalized === '30d' || normalized === 'ytd' ? normalized : '7d', dayKeysOldestFirst: keys }
}

const buildLocalZeroSeries = (dayKeysNewestFirst) => dayKeysNewestFirst.map((day) => ({ day, count: 0 }))

app.get('/api/admin/metrics', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Admin tools are only available on the deployed API.' })
  }

  const token = readBearerToken(req)
  const session = token ? localAccountSessions.get(token) : null
  if (!session || !localAdminPhones.has(session.phoneE164)) {
    return res.status(404).json({ error: 'Not found.' })
  }

  const resolved = buildLocalMetricsDayKeys(req.query?.period)
  const dayKeysNewestFirst = resolved.dayKeysOldestFirst.slice().reverse()
  const emptySeries = buildLocalZeroSeries(dayKeysNewestFirst)
  const zeroStats = {
    accounts: 0,
    cards: 0,
    sends: 0,
    thankYous: 0,
    testimonials: 0,
    logins: 0,
    creditsPurchased: 0,
    creditsSpent: 0,
    amountPaidCents: 0,
    amountPaid: 0,
  }

  return res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    today: resolved.today,
    period: resolved.period,
    timezone: 'America/Los_Angeles',
    days: resolved.dayKeysOldestFirst.length,
    rangeStart: resolved.dayKeysOldestFirst[0],
    rangeEnd: resolved.today,
    note: 'Local analytics stub — live metrics come from the deployed worker/D1.',
    totals: {
      ...zeroStats,
      failedSends: 0,
      testimonialsPending: 0,
      activeUsers7: 0,
      activeUsers30: 0,
    },
    todayStats: zeroStats,
    periodStats: zeroStats,
    daily: {
      accounts: emptySeries,
      cards: emptySeries,
      sends: emptySeries,
      thankYous: emptySeries,
      logins: emptySeries,
      testimonials: emptySeries,
      creditsPurchased: emptySeries,
      creditsSpent: emptySeries,
      amountPaidCents: emptySeries,
    },
  })
})

app.post('/api/admin/grant-credits', (req, res) => {
  if (!isLocalDevAuthRequest(req)) {
    return res.status(404).json({ error: 'Admin tools are only available on the deployed API.' })
  }

  const token = readBearerToken(req)
  const session = token ? localAccountSessions.get(token) : null
  if (!session || !localAdminPhones.has(session.phoneE164)) {
    return res.status(404).json({ error: 'Not found.' })
  }

  const rawPhone = String(req.body?.phone || req.body?.phoneE164 || '').trim()
  const amount = Math.floor(Number(req.body?.credits ?? req.body?.add))

  if (!rawPhone) {
    return res.status(400).json({ error: 'Enter the account cellphone number.' })
  }

  let phoneE164 = ''
  try {
    phoneE164 = normalizePhoneNumber(rawPhone)
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Enter a valid cellphone number.',
    })
  }

  if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
    return res.status(400).json({ error: 'Enter a credit amount between 1 and 500.' })
  }

  const user = localAccountUsers.get(phoneE164)
  if (!user) {
    return res.status(404).json({
      error: 'No Card Genie account found for that number. They need to confirm their phone first.',
    })
  }

  const previousBalance = user.creditBalance
  user.creditBalance = Math.max(0, user.creditBalance + amount)

  return res.json({
    ok: true,
    phoneE164,
    creditsAdded: amount,
    creditBalance: user.creditBalance,
    previousBalance,
    message: `Added ${amount} credits. New balance: ${user.creditBalance}.`,
  })
})

app.post('/api/refine-copy', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const { details, refinement, currentMessage, currentClosing, referenceImages: rawReferenceImages } = req.body
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(', ')}`,
    })
  }

  if (!refinement?.trim()) {
    return res.status(400).json({
      error: 'Tell us what to change about the inside message.',
    })
  }

  try {
    const openai = getOpenAI()
    const likenessBrief = await describeReferenceImages(openai, referenceImages)
    const copy = await generateCopy(
      openai,
      {
        ...details,
        keyDetails: `${details.keyDetails}\n\nCurrent inside message: ${currentMessage || ''}\nCurrent closing: ${currentClosing || ''}`,
      },
      refinement,
      referenceImages,
      likenessBrief,
    )
    res.json(copy)
  } catch (error) {
    console.error(error)
    res.status(isSafetyRejection(error) ? 400 : 500).json({
      error: publicGenerationError(error, 'Unable to refine the inside message.', {
        hasPhotos: referenceImages.length > 0,
        photoCount: referenceImages.length,
        details: { ...details, refinement },
      }),
    })
  }
})

app.listen(port, () => {
  console.log(`AI Card Buddy API listening on http://localhost:${port}`)
  if (localDevAuthEnabled) {
    console.log(`Local dev sign-in enabled. OTP code: ${localDevOtpCode} (override with LOCAL_DEV_OTP).`)
  }
})
