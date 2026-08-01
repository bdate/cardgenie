import OpenAI from 'openai'

const defaultAllowedOrigins =
  'http://localhost:5173,http://127.0.0.1:5173,https://card-genie.com,https://www.card-genie.com'
const fallbackCardStore = new Map()

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

const getAllowedOrigins = (env) =>
  (env.ALLOWED_ORIGINS || defaultAllowedOrigins)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

const getCorsHeaders = (request, env) => {
  const origin = request.headers.get('Origin')
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  if (origin && getAllowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }

  return headers
}

const jsonResponse = (request, env, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    },
  })

const validateDetails = (details) => {
  const requiredFields = ['recipientType', 'senderName', 'occasion', 'tone', 'length', 'keyDetails']
  return requiredFields.filter((field) => !details[field]?.trim())
}

const getOpenAI = (env) =>
  new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  })

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

const createCardId = () => crypto.randomUUID()

const getPublicAppUrl = (request, env) => {
  const requestUrl = new URL(request.url)
  return (env.PUBLIC_APP_URL || request.headers.get('Origin') || requestUrl.origin).replace(/\/$/, '')
}

const getShareUrl = (request, env, cardId) => `${getPublicAppUrl(request, env)}/?card=${encodeURIComponent(cardId)}`

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
    greeting: payload?.greeting?.trim() || `Dear ${details.recipientName || details.recipientType || 'Someone special'},`,
    signature: payload?.signature?.trim() || details.senderName?.trim() || 'Your Name',
  }
}

const saveCardRecord = async (env, record) => {
  if (env.CARD_STORE) {
    await env.CARD_STORE.put(record.id, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 })
    return
  }

  fallbackCardStore.set(record.id, record)
}

const getCardRecord = async (env, cardId) => {
  if (env.CARD_STORE) {
    const record = await env.CARD_STORE.get(cardId, 'json')
    return record || null
  }

  return fallbackCardStore.get(cardId) || null
}

const getCardSummary = (record, request, env) => ({
  ...record,
  shareUrl: getShareUrl(request, env, record.id),
})

const buildDeliveryCopy = (record, shareUrl) => {
  const recipient = record.details.recipientName || record.details.recipientType || 'you'
  const sender = record.signature || record.details.senderName || 'Someone special'
  const occasion = record.details.occasion || 'card'

  return {
    subject: `${sender} sent you a ${occasion} card`,
    text: `${sender} made a card for ${recipient}. Open it here: ${shareUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #302632; line-height: 1.5;">
        <h1 style="margin: 0 0 12px;">${sender} sent you a card</h1>
        <p>Open your personalized ${occasion} card from ${sender}.</p>
        <p><a href="${shareUrl}" style="display:inline-block;padding:12px 18px;background:#f59e33;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Open your card</a></p>
        <p>If the button does not work, copy and paste this link: <br /><a href="${shareUrl}">${shareUrl}</a></p>
      </div>
    `,
  }
}

const sendEmailDelivery = async ({ env, to, copy }) => {
  if (!env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add POSTMARK_SERVER_TOKEN and EMAIL_FROM.')
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: env.EMAIL_FROM,
      To: to,
      Subject: copy.subject,
      TextBody: copy.text,
      HtmlBody: copy.html,
      MessageStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Postmark could not send the card. ${errorText}`)
  }
}

const getTwilioAuthCredentials = (env) => {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new Error('Text delivery is not configured. Add TWILIO_ACCOUNT_SID.')
  }

  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return {
      accountSid: env.TWILIO_ACCOUNT_SID,
      username: env.TWILIO_API_KEY_SID,
      password: env.TWILIO_API_KEY_SECRET,
    }
  }

  if (env.TWILIO_AUTH_TOKEN) {
    return {
      accountSid: env.TWILIO_ACCOUNT_SID,
      username: env.TWILIO_ACCOUNT_SID,
      password: env.TWILIO_AUTH_TOKEN,
    }
  }

  throw new Error('Text delivery is not configured. Add TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.')
}

const sendTextDelivery = async ({ env, to, copy }) => {
  if (!env.TWILIO_FROM_NUMBER) {
    throw new Error('Text delivery is not configured. Add TWILIO_FROM_NUMBER.')
  }

  const twilioAuth = getTwilioAuthCredentials(env)

  const form = new URLSearchParams({
    From: env.TWILIO_FROM_NUMBER,
    To: to,
    Body: copy.text,
  })

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAuth.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${twilioAuth.username}:${twilioAuth.password}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Twilio could not send the card. ${errorText}`)
  }
}

const generateCopy = async (openai, env, details, refinement = '') => {
  const copyResponse = await openai.responses.create({
    model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: buildCopyPrompt(details, refinement),
  })

  return parseCopyResponse(copyResponse)
}

const getImageUrl = (imageResponse, fallbackMessage) => {
  const imageBase64 = imageResponse.data?.[0]?.b64_json
  const imageUrl = imageBase64
    ? `data:image/png;base64,${imageBase64}`
    : imageResponse.data?.[0]?.url

  if (!imageUrl) {
    throw new Error(fallbackMessage)
  }

  return imageUrl
}

const generateImage = async (openai, env, details, refinement = '', imageMode = 'new') => {
  const imageResponse = await openai.images.generate({
    model: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    prompt: buildImagePrompt(details, refinement, imageMode),
    size: '1024x1536',
    quality: 'medium',
  })

  return getImageUrl(imageResponse, 'OpenAI did not return an image.')
}

const base64ToUint8Array = (imageBase64) => {
  const binary = atob(imageBase64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const imageUrlToFile = async (imageUrl) => {
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')

  if (dataUrlMatch) {
    const [, mimeType, imageBase64] = dataUrlMatch
    return new File([base64ToUint8Array(imageBase64)], 'current-cover.png', { type: mimeType })
  }

  if (/^https?:\/\//.test(imageUrl || '')) {
    const response = await fetch(imageUrl)

    if (!response.ok) {
      throw new Error('Unable to load the current cover image for editing.')
    }

    const contentType = response.headers.get('content-type') || 'image/png'
    return new File([await response.arrayBuffer()], 'current-cover.png', { type: contentType })
  }

  throw new Error('Unable to edit the cover because the current image is missing or invalid.')
}

const editImage = async (openai, env, details, refinement, currentImageUrl) => {
  const currentImage = await imageUrlToFile(currentImageUrl)
  const imageResponse = await openai.images.edit({
    model: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    image: currentImage,
    prompt: buildImageEditPrompt(details, refinement),
    size: '1024x1536',
    quality: 'medium',
  })

  return getImageUrl(imageResponse, 'OpenAI did not return an edited image.')
}

const requireOpenAIKey = (request, env) => {
  if (env.OPENAI_API_KEY) {
    return null
  }

  return jsonResponse(
    request,
    env,
    { error: 'Missing OPENAI_API_KEY. Add it as a Cloudflare Worker secret.' },
    500,
  )
}

const readJson = async (request) => {
  try {
    return await request.json()
  } catch {
    return null
  }
}

const handleSaveCard = async (request, env) => {
  try {
    const record = buildCardRecord(await readJson(request))
    await saveCardRecord(env, record)

    return jsonResponse(request, env, getCardSummary(record, request, env), 201)
  } catch (error) {
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to save the card.' }, 400)
  }
}

const handleGetCard = async (request, env, cardId) => {
  const record = await getCardRecord(env, cardId)

  if (!record) {
    return jsonResponse(request, env, { error: 'Card not found.' }, 404)
  }

  return jsonResponse(request, env, getCardSummary(record, request, env))
}

const handleDeliverCard = async (request, env) => {
  const { cardId, method, destination, recipientConsentConfirmed } = (await readJson(request)) || {}
  const record = await getCardRecord(env, cardId)
  const cleanDestination = destination?.trim()

  if (!record) {
    return jsonResponse(request, env, { error: 'Save the card before delivering it.' }, 404)
  }

  if (!['email', 'text'].includes(method)) {
    return jsonResponse(request, env, { error: 'Choose email or text delivery.' }, 400)
  }

  if (!cleanDestination) {
    return jsonResponse(
      request,
      env,
      { error: method === 'email' ? 'Enter the recipient email address.' : 'Enter the recipient cellphone number.' },
      400,
    )
  }

  if (method === 'text' && recipientConsentConfirmed !== true) {
    return jsonResponse(
      request,
      env,
      { error: 'Confirm the recipient agreed to receive this one-time card delivery text.' },
      400,
    )
  }

  try {
    const shareUrl = getShareUrl(request, env, record.id)
    const copy = buildDeliveryCopy(record, shareUrl)

    if (method === 'email') {
      await sendEmailDelivery({ env, to: cleanDestination, copy })
    } else {
      await sendTextDelivery({ env, to: cleanDestination, copy })
    }

    return jsonResponse(request, env, {
      ok: true,
      shareUrl,
      message: method === 'email' ? 'Card email sent.' : 'Card text sent.',
    })
  } catch (error) {
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to deliver the card.' },
      500,
    )
  }
}

const handleGenerateCard = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const details = await readJson(request)
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: `Missing required fields: ${missingFields.join(', ')}` }, 400)
  }

  try {
    const openai = getOpenAI(env)
    const [copy, imageUrl] = await Promise.all([
      generateCopy(openai, env, details),
      generateImage(openai, env, details),
    ])

    if (!copy.message || !imageUrl) {
      throw new Error('OpenAI did not return both a message and an image.')
    }

    return jsonResponse(request, env, {
      message: copy.message,
      closing: copy.closing,
      imageUrl,
    })
  } catch (error) {
    console.error(error)
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to generate the card.' }, 500)
  }
}

const handleRefineImage = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const { details, refinement, imageMode, currentImageUrl } = (await readJson(request)) || {}
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: `Missing required fields: ${missingFields.join(', ')}` }, 400)
  }

  if (!refinement?.trim()) {
    return jsonResponse(request, env, { error: 'Tell us what to change about the cover image.' }, 400)
  }

  try {
    const openai = getOpenAI(env)
    const imageUrl =
      imageMode === 'new'
        ? await generateImage(openai, env, details, refinement, 'new')
        : await editImage(openai, env, details, refinement, currentImageUrl)

    return jsonResponse(request, env, { imageUrl })
  } catch (error) {
    console.error(error)
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to refine the image.' }, 500)
  }
}

const handleRefineCopy = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const { details, refinement, currentMessage, currentClosing } = (await readJson(request)) || {}
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: `Missing required fields: ${missingFields.join(', ')}` }, 400)
  }

  if (!refinement?.trim()) {
    return jsonResponse(request, env, { error: 'Tell us what to change about the inside message.' }, 400)
  }

  try {
    const copy = await generateCopy(
      getOpenAI(env),
      env,
      {
        ...details,
        keyDetails: `${details.keyDetails}\n\nCurrent inside message: ${currentMessage || ''}\nCurrent closing: ${currentClosing || ''}`,
      },
      refinement,
    )

    return jsonResponse(request, env, copy)
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to refine the inside message.' },
      500,
    )
  }
}

const handleRequest = async (request, env) => {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request, env),
    })
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return jsonResponse(request, env, { ok: true })
  }

  if (request.method === 'POST' && url.pathname === '/api/cards') {
    return handleSaveCard(request, env)
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/cards/')) {
    return handleGetCard(request, env, decodeURIComponent(url.pathname.replace('/api/cards/', '')))
  }

  if (request.method === 'POST' && url.pathname === '/api/deliver-card') {
    return handleDeliverCard(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/generate-card') {
    return handleGenerateCard(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/refine-image') {
    return handleRefineImage(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/refine-copy') {
    return handleRefineCopy(request, env)
  }

  return jsonResponse(request, env, { error: 'Not found' }, 404)
}

export default {
  fetch: handleRequest,
}
