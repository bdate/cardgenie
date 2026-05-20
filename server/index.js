import 'dotenv/config'

import express from 'express'
import OpenAI, { toFile } from 'openai'

const app = express()
const port = process.env.PORT || 8787
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

Return strict JSON only, with this shape:
{
  "message": "Body copy only, split into 2-4 short logical paragraphs separated by blank lines. No salutation, closing, sender name, placeholder, or signature.",
  "closing": "A short closing phrase, such as With all my love,"
}

Do not include a salutation like "Dear..." and do not include the sender name, placeholder, or signature. The app will typeset the greeting, closing, and cursive signature separately.
Make the body warm, specific, natural, and suitable to appear inside a digital greeting card. Keep it concise enough to fit inside a 5x7 card with generous margins. Use natural paragraph breaks based on grammar and meaning.
`

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

const generateCopy = async (openai, details, refinement = '') => {
  const copyResponse = await openai.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: buildCopyPrompt(details, refinement),
  })

  return parseCopyResponse(copyResponse)
}

const generateImage = async (openai, details, refinement = '', imageMode = 'new') => {
  const imageResponse = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    prompt: buildImagePrompt(details, refinement, imageMode),
    size: '1024x1536',
    quality: 'medium',
  })

  const imageBase64 = imageResponse.data?.[0]?.b64_json
  const imageUrl = imageBase64
    ? `data:image/png;base64,${imageBase64}`
    : imageResponse.data?.[0]?.url

  if (!imageUrl) {
    throw new Error('OpenAI did not return an image.')
  }

  return imageUrl
}

const imageUrlToFile = async (imageUrl) => {
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')

  if (dataUrlMatch) {
    const [, mimeType, imageBase64] = dataUrlMatch
    return toFile(Buffer.from(imageBase64, 'base64'), 'current-cover.png', { type: mimeType })
  }

  if (/^https?:\/\//.test(imageUrl || '')) {
    const response = await fetch(imageUrl)

    if (!response.ok) {
      throw new Error('Unable to load the current cover image for editing.')
    }

    const contentType = response.headers.get('content-type') || 'image/png'
    const imageBuffer = Buffer.from(await response.arrayBuffer())
    return toFile(imageBuffer, 'current-cover.png', { type: contentType })
  }

  throw new Error('Unable to edit the cover because the current image is missing or invalid.')
}

const editImage = async (openai, details, refinement, currentImageUrl) => {
  const currentImage = await imageUrlToFile(currentImageUrl)
  const imageResponse = await openai.images.edit({
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    image: currentImage,
    prompt: buildImageEditPrompt(details, refinement),
    size: '1024x1536',
    quality: 'medium',
  })

  const imageBase64 = imageResponse.data?.[0]?.b64_json
  const imageUrl = imageBase64
    ? `data:image/png;base64,${imageBase64}`
    : imageResponse.data?.[0]?.url

  if (!imageUrl) {
    throw new Error('OpenAI did not return an edited image.')
  }

  return imageUrl
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

const parseCopyResponse = (response) => {
  const text = getMessageText(response)

  try {
    const parsed = JSON.parse(text)
    return {
      message: parsed.message?.trim() || text,
      closing: parsed.closing?.trim() || 'With love,',
    }
  } catch {
    return {
      message: text,
      closing: 'With love,',
    }
  }
}

app.post('/api/generate-card', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const details = req.body
  const missingFields = validateDetails(details)

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(', ')}`,
    })
  }

  try {
    const openai = getOpenAI()

    const [copy, imageUrl] = await Promise.all([generateCopy(openai, details), generateImage(openai, details)])

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
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to generate the card.',
    })
  }
})

app.post('/api/refine-image', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const { details, refinement, imageMode, currentImageUrl } = req.body
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
    const imageUrl =
      imageMode === 'new'
        ? await generateImage(openai, details, refinement, 'new')
        : await editImage(openai, details, refinement, currentImageUrl)

    res.json({ imageUrl })
  } catch (error) {
    console.error(error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to refine the image.',
    })
  }
})

app.post('/api/refine-copy', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Missing OPENAI_API_KEY. Add it to a local .env file and restart the dev server.',
    })
  }

  const { details, refinement, currentMessage, currentClosing } = req.body
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
    const copy = await generateCopy(
      getOpenAI(),
      {
        ...details,
        keyDetails: `${details.keyDetails}\n\nCurrent inside message: ${currentMessage || ''}\nCurrent closing: ${currentClosing || ''}`,
      },
      refinement,
    )
    res.json(copy)
  } catch (error) {
    console.error(error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to refine the inside message.',
    })
  }
})

app.listen(port, () => {
  console.log(`AI Card Buddy API listening on http://localhost:${port}`)
})
