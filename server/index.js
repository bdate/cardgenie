import 'dotenv/config'

import crypto from 'node:crypto'
import express from 'express'
import OpenAI, { toFile } from 'openai'

const app = express()
const port = process.env.PORT || 8787
const cardStore = new Map()
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

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

app.post('/api/deliver-card', async (req, res) => {
  const { cardId, method, destination, recipientConsentConfirmed } = req.body || {}
  const record = cardStore.get(cardId)
  const cleanDestination = destination?.trim()

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

  if (!cleanDestination) {
    return res.status(400).json({
      error: method === 'email' ? 'Enter the recipient email address.' : 'Enter the recipient cellphone number.',
    })
  }

  if (method === 'text' && recipientConsentConfirmed !== true) {
    return res.status(400).json({
      error: 'Confirm the recipient agreed to receive this one-time card delivery text.',
    })
  }

  try {
    const shareUrl = getShareUrl(req, record.id)
    const copy = buildDeliveryCopy(record, shareUrl)

    const deliveredTo =
      method === 'email'
        ? await sendEmailDelivery({ to: normalizeEmailAddress(cleanDestination), copy })
        : await sendTextDelivery({ to: cleanDestination, copy })

    res.json({
      ok: true,
      shareUrl,
      deliveredTo,
      message: method === 'email' ? 'Card email sent.' : 'Card text sent.',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to deliver the card.'
    const isValidationError =
      /email|cellphone|phone|@|period|\.com|digits|incomplete|spaces/i.test(message) &&
      !/SendGrid|Postmark|Twilio|configured/i.test(message)

    res.status(isValidationError ? 400 : 500).json({
      error: message,
    })
  }
})

const buildCopyPrompt = (details, refinement = '') => `
Write the inside message for a personalized greeting card.

Recipient: ${details.recipientName || details.recipientType}
Recipient type or relationship: ${details.recipientType}
Sender: ${details.senderName}
Occasion: ${details.occasion}
Tone: ${details.tone}
Length: ${details.length}
Personal details to include: ${details.keyDetails}
${refinement ? `\nUser refinement request: ${refinement}` : ''}

Strictly obey the selected Length word-count range for the message body only. Count the body copy words, not the greeting, closing, or signature. Do not exceed the maximum word count in the selected range.

Return strict JSON only, with this shape:
{
  "message": "Body copy only, split into 2-4 short logical paragraphs separated by blank lines. No salutation, closing, sender name, placeholder, or signature.",
  "closing": "A short closing phrase, such as With all my love,"
}

Do not include a salutation like "Dear..." and do not include the sender name, placeholder, or signature. The app will typeset the greeting, closing, and cursive signature separately.
Make the body warm, specific, natural, and suitable to appear inside a digital greeting card. Keep it concise enough to fit inside a 5x7 card with generous margins. Use natural paragraph breaks based on grammar and meaning.
`

const buildReferenceImageGuidance = (hasReferenceImages) => {
  if (!hasReferenceImages) {
    return ''
  }

  return `
The attached images are likeness references of the actual people and animals for this card.
Create original greeting-card artwork in the requested visual style that clearly resembles them.
Match their ages, faces, hair, body types, clothing cues, and any pet's size and coat color from the photos.
Relationship words such as daughter, son, kids, mom, or dad must not change their ages if the photos show something different. If the photos show adults, draw adults, not children.
The people and animals from the photos should appear on the cover unless the user asked for a symbolic scene instead.
Do not copy the photographs onto the card as printed pictures, Polaroids, frames, phone screens, or collages.
If children appear, depict them fully and modestly clothed as they would on a family greeting card. Never depict nudity.
`
}

const buildLikenessBriefSection = (likenessBrief) => {
  if (!likenessBrief) {
    return ''
  }

  return `
LIKENESS BRIEF FROM THE SENDER'S REFERENCE PHOTOS (highest priority, overrides guesses from names or words like daughter, son, or kids):
${likenessBrief}

Follow this brief exactly for ages, faces, hair, complexion, distinctive features, and any pet coloring. Recreate them in the requested art style as original greeting-card artwork. Do not paste the original photographs onto the card.
If children are included, they must be fully and modestly clothed.
`
}

const referenceImageDescriptionPrompt = `These are private family photos for a wholesome greeting card. Write a concise likeness brief an illustrator must follow.

For each person, include: approximate age band (child, teen, young adult, adult, or older adult), hair, complexion, distinctive features, and the clothing they should wear on a greeting card.
If several people appear together, describe them left to right.
For animals, include species, size, coat color, and distinctive markings.
Mention setting only if it should inspire the card.

Be specific about age. If people look like adults, say they are adults, not children.
If a child appears in a bath or is not fully clothed, describe them as a clothed child of that age. Do not mention nudity, baths, or unclothed states.
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
  ]
    .filter(Boolean)
    .join(' ')
}

const isSafetyRejection = (error) =>
  /safety|moderation|safety_violations|rejected by the safety system/i.test(getErrorText(error))

const publicGenerationError = (error, fallbackMessage) => {
  if (isSafetyRejection(error)) {
    return 'One of the photos could not be used to create the cover. Try another photo, or generate without that image.'
  }

  return error instanceof Error ? error.message : fallbackMessage
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

The generated image must be portrait artwork at 1024px wide by 1536px tall, composed for a 5x7 greeting-card cover. The app will place this image inside a separate card frame, so do not add paper edges, borders, shadows, mockups, envelopes, UI, or folded-card effects.

Occasion: ${details.occasion}
Recipient: ${details.recipientName || details.recipientType}
Relationship: ${details.recipientType}
Tone: ${details.tone}
Visual style: ${details.imageStyle || 'AI chooses the best style for this card'}
Important personal context: ${details.keyDetails}
Name and relationship context: the recipient is named "${details.recipientName || 'the recipient'}" and is described by the sender as "${details.recipientType}". The sender is named "${details.senderName || 'the sender'}". Use these names and relationship clues only as soft visual context for age, relationship, and casting when they are obvious. Do not add gender questions, do not stereotype, and do not force a photorealistic person if a symbolic or illustrative scene would work better.
${refinement ? `\nUser refinement request: ${refinement}` : ''}

Revision mode:
${
  imageMode === 'revise'
    ? '- Treat the user refinement as an edit direction, not a request for a brand-new card. Preserve the same overall concept, subject matter, mood, composition, visual style, color palette, and emotional intent as much as possible. Only change the specific things the user requested. If the request is small, keep the result close to the prior concept.'
    : '- Create a fresh cover concept from the card details and user direction. You may change the composition, subject matter, style, and overall concept if it better satisfies the request.'
}

Composition requirements:
- Portrait artwork composed for a 5x7 greeting-card cover.
- Treat the outer 20% on every side as a protected safe margin.
- Main subject centered with generous visual breathing room on all sides.
- No important faces, hands, objects, props, symbols, or details within 20% of any image edge.
- Any cover text must stay fully inside the central 60% safe area. No letters, numbers, words, or decorative text-like shapes may appear in the outer 20% safe margin.
- Background should extend naturally to the edges so the app can crop it cleanly.
- Focus on an emotionally warm scene or symbolic illustration inspired by the personal context.
- It should feel like premium editorial or storybook artwork made for a finished greeting-card cover.

Cover text direction:
- Use judgment based on the occasion, tone, recipient, and personal context.
- Use the selected visual style as the primary art direction. If the style is "AI chooses the best style for this card", choose the medium that best fits the occasion and tone.
- For photorealistic styles, make it look like a natural, real photographed greeting-card cover scene with believable lighting, skin texture, fabric, and imperfections.
- For comic, vector, storybook, watercolor, paper-cut, poster, collage, or 3D styles, make the medium unmistakable and consistent across the whole image.
- Include a small amount of tasteful cover text only if it improves the greeting card.
- If cover text is used, keep it short, legible, correctly spelled, and emotionally appropriate.
- Choose font style based on the card: elegant serif or script for heartfelt/elegant cards, playful lettering for funny/playful cards, clean modern type for simple or contemporary cards.
- Text should be large enough to read but never oversized, never crowded, and never close to an image edge.
- Prefer one concise phrase such as "Happy Birthday", "Thinking of You", "Thank You", or a short occasion-specific line. Avoid long sentences.
- Names and ages are allowed only when they fit naturally and remain well inside the central safe area.

Negative requirements:
- No text, letters, numbers, captions, signs, banners, labels, posters, plaques, handwriting, or decorative typography within the outer 20% safe margin.
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

Keep the output as portrait artwork composed for a 5x7 greeting-card cover. Do not add borders, paper edges, frames, mockups, envelopes, UI, or new text near the image edges.
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

const generateCopy = async (openai, details, refinement = '', referenceImages = [], likenessBrief = '') => {
  const prompt = `${buildCopyPrompt(details, refinement)}${buildReferenceImageGuidance(referenceImages.length > 0)}${buildLikenessBriefSection(likenessBrief)}
If a likeness brief is provided, keep the message consistent with those people and details. Do not mention photos or that you saw pictures.`
  const requestCopy = async (images) => {
    const input =
      images.length > 0
        ? [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: prompt },
                ...images.map((imageUrl) => ({
                  type: 'input_image',
                  image_url: imageUrl,
                  detail: 'high',
                })),
              ],
            },
          ]
        : prompt

    const copyResponse = await openai.responses.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      input,
    })

    return fitCopyToLength(openai, details, parseCopyResponse(copyResponse))
  }

  try {
    return await requestCopy(referenceImages)
  } catch (error) {
    if (!isSafetyRejection(error) || referenceImages.length === 0) {
      throw error
    }

    return requestCopy([])
  }
}

const generateImageFromPrompt = async (openai, prompt) => {
  const imageResponse = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    prompt,
    size: '1024x1536',
    quality: 'medium',
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
  const prompt = `${buildImagePrompt(details, refinement, imageMode)}${buildReferenceImageGuidance(referenceImages.length > 0)}${buildLikenessBriefSection(likenessBrief)}`

  if (referenceImages.length > 0) {
    try {
      return await editImageWithFiles(openai, prompt, await referenceImagesToFiles(referenceImages))
    } catch (error) {
      if (!isSafetyRejection(error)) {
        throw error
      }
    }
  }

  return generateImageFromPrompt(
    openai,
    `${buildImagePrompt(details, refinement, imageMode)}${buildLikenessBriefSection(likenessBrief)}`,
  )
}

const getGeneratedImageUrl = (imageResponse, fallbackMessage) => {
  const imageBase64 = imageResponse.data?.[0]?.b64_json
  const imageUrl = imageBase64
    ? `data:image/png;base64,${imageBase64}`
    : imageResponse.data?.[0]?.url

  if (!imageUrl) {
    throw new Error(fallbackMessage)
  }

  return imageUrl
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
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    image: imageFiles,
    prompt,
    size: '1024x1536',
    quality: 'medium',
  })

  return getGeneratedImageUrl(imageResponse, 'OpenAI did not return an edited image.')
}

const editImage = async (openai, details, refinement, currentImageUrl, referenceImages = [], likenessBrief = '') => {
  const currentImage = await imageUrlToFile(currentImageUrl)
  const referenceFiles = await referenceImagesToFiles(referenceImages)
  const prompt = `${buildImageEditPrompt(details, refinement)}${buildReferenceImageGuidance(referenceFiles.length > 0)}${buildLikenessBriefSection(likenessBrief)}
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
      `${buildImageEditPrompt(details, refinement)}${buildLikenessBriefSection(likenessBrief)}`,
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
    }
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

const getPublicAppUrl = (req) =>
  (process.env.PUBLIC_APP_URL || req.headers.origin || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')

const getShareBaseUrl = (req) =>
  (process.env.SHARE_BASE_URL || process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(
    /\/$/,
    '',
  )

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
    ? `${recipientFirstName}, open your personalized ${occasion} card from ${sender}.`
    : `Open your personalized ${occasion} card from ${sender}.`

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

const buildDeliveryCopy = (record, shareUrl) => {
  const recipientFirstName = (record.details.recipientName || '').trim().split(/\s+/).filter(Boolean)[0] || ''
  const sender = record.signature || record.details.senderName || 'Someone special'
  const occasion = record.details.occasion || 'card'
  const openLine = recipientFirstName
    ? `${recipientFirstName}, open your personalized ${occasion} card from ${sender}.`
    : `Open your personalized ${occasion} card from ${sender}.`

  return {
    subject: `${sender} sent you a ${occasion} card`,
    text: `${openLine} ${shareUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #302632; line-height: 1.5;">
        <h1 style="margin: 0 0 12px;">${sender} sent you a card</h1>
        <p>${openLine}</p>
        <p><a href="${shareUrl}" style="display:inline-block;padding:12px 18px;background:#f59e33;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Open your card</a></p>
        <p>If the button does not work, copy and paste this link: <br /><a href="${shareUrl}">${shareUrl}</a></p>
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

const sendSendGridEmailDelivery = async ({ to, copy }) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
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
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`SendGrid could not send the card. ${errorText}`)
  }

  return to
}

const sendPostmarkEmailDelivery = async ({ to, copy }) => {
  if (!process.env.POSTMARK_SERVER_TOKEN || !process.env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add POSTMARK_SERVER_TOKEN and EMAIL_FROM.')
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: process.env.EMAIL_FROM,
      To: to,
      Subject: copy.subject,
      TextBody: copy.text,
      HtmlBody: copy.html,
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Postmark could not send the card. ${errorText}`)
  }

  return to
}

const sendEmailDelivery = async ({ to, copy }) => {
  if (process.env.SENDGRID_API_KEY) {
    return sendSendGridEmailDelivery({ to, copy })
  }

  if (process.env.POSTMARK_SERVER_TOKEN) {
    return sendPostmarkEmailDelivery({ to, copy })
  }

  throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
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
    const openai = getOpenAI()
    const likenessBrief = await describeReferenceImages(openai, referenceImages)
    const [copy, imageUrl] = await Promise.all([
      generateCopy(openai, details, '', referenceImages, likenessBrief),
      generateImage(openai, details, '', 'new', referenceImages, likenessBrief),
    ])

    if (!copy.message || !imageUrl) {
      throw new Error('OpenAI did not return both a message and an image.')
    }

    res.json({
      message: copy.message,
      closing: copy.closing,
      imageUrl,
    })
  } catch (error) {
    console.error(error)
    res.status(isSafetyRejection(error) ? 400 : 500).json({
      error: publicGenerationError(error, 'Unable to generate the card.'),
    })
  }
})

app.post('/api/refine-image', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const { details, refinement, imageMode, currentImageUrl, referenceImages: rawReferenceImages } = req.body
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
        : await editImage(openai, details, refinement, currentImageUrl, referenceImages, likenessBrief)

    res.json({ imageUrl })
  } catch (error) {
    console.error(error)
    res.status(isSafetyRejection(error) ? 400 : 500).json({
      error: publicGenerationError(error, 'Unable to refine the image.'),
    })
  }
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
      error: publicGenerationError(error, 'Unable to refine the inside message.'),
    })
  }
})

app.listen(port, () => {
  console.log(`AI Card Buddy API listening on http://localhost:${port}`)
})
