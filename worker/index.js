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

Strictly obey the selected Length word-count range for the message body only. Count the body copy words, not the greeting, closing, or signature. Do not exceed the maximum word count in the selected range.

Return strict JSON only, with this shape:
{
  "message": "Body copy only, split into 2-4 short logical paragraphs separated by blank lines. No salutation, closing, sender name, placeholder, or signature.",
  "closing": "A short closing phrase appropriate to the occasion, tone, and relationship — e.g. With love, / Cheers, / With gratitude, / Warmly, / Your friend, / Here's to you, etc. Never default to 'With all my love' unless it truly fits."
}

Do not include a salutation like "Dear..." and do not include the sender name, placeholder, or signature. The app will typeset the greeting, closing, and cursive signature separately.
Make the body warm, specific, natural, and suitable to appear inside a digital greeting card. Keep it concise enough to fit inside a 5x7 card with generous margins. Use natural paragraph breaks based on grammar and meaning.
`

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
- For "Comic book art", the entire cover must read as printed comic-book illustration: inked linework, color holds, screentone or halftone, and comic anatomy. If people are described from reference photos, they must appear as comic characters with a recognizable stylized likeness, never as photographed people.
- For other illustrated styles such as vector, storybook, watercolor, paper-cut, poster, collage, or 3D, make the medium unmistakable and consistent across the whole image.
- Include a small amount of tasteful cover text only if it improves the greeting card.
- If cover text is used, keep it short, legible, correctly spelled, and emotionally appropriate.
- Choose font style based on the card: elegant serif or script for heartfelt/elegant cards, playful lettering for funny/playful cards, clean modern type for simple or contemporary cards.
- Text should be large enough to read but never oversized, never crowded, and never close to an image edge.
- Prefer one concise phrase such as "Happy Birthday", "Thinking of You", "Thank You", or a short occasion-specific line. Avoid long sentences.
- Names and ages are allowed only when they fit naturally and remain well inside the central safe area.

Copyright and identity:
- Do not depict trademarked superheroes, movie characters, logos, brands, or celebrity likenesses even if they are mentioned in the personal context.
- If the sender mentions a copyrighted character or brand, translate it into original greeting-card imagery with the same feeling. For example, a heroic inventor in original red-and-gold armor rather than a trademarked superhero.
- Stay in the selected art style. Never output a photograph unless the selected style is photorealistic.

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

const describeReferenceImages = async (openai, env, referenceImages) => {
  if (!referenceImages.length) {
    return ''
  }

  const describe = async (images) => {
    const response = await openai.responses.create({
      model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
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

const createCardId = () => crypto.randomUUID()

const getPublicAppUrl = (request, env) => {
  const requestUrl = new URL(request.url)
  return (env.PUBLIC_APP_URL || request.headers.get('Origin') || requestUrl.origin).replace(/\/$/, '')
}

const getShareBaseUrl = (request, env) =>
  (env.SHARE_BASE_URL || env.PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, '')

const getShareUrl = (request, env, cardId) => `${getShareBaseUrl(request, env)}/c/${encodeURIComponent(cardId)}`

const getSharePathParts = (pathname) => {
  const match = pathname.match(/^\/c\/([^/]+)(?:\/(cover))?\/?$/)

  if (!match) {
    return null
  }

  return {
    cardId: decodeURIComponent(match[1]),
    isCover: match[2] === 'cover',
  }
}

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

  return { title, description, sender, occasion }
}

const parseDataImage = (imageUrl) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')

  if (!match) {
    return null
  }

  return {
    mimeType: match[1],
    bytes: base64ToUint8Array(match[2]),
  }
}

const buildSharePreviewHtml = (record, request, env) => {
  const { title, description } = buildSharePreviewCopy(record)
  const appUrl = `${getPublicAppUrl(request, env)}/?card=${encodeURIComponent(record.id)}`
  const imageUrl = `${getShareBaseUrl(request, env)}/c/${encodeURIComponent(record.id)}/cover`
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

const jobStoreKey = (jobId) => `job:${jobId}`
const generateJobTimeoutMs = 12 * 60 * 1000
const generateJobMaxAttempts = 3
const generateQueueMaxDeliveryAttempts = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isTransientGenerationError = (error) => {
  if (!error || isSafetyRejection(error) || error.publicMessage) {
    return false
  }

  return /timeout|timed out|429|500|502|503|504|524|rate.?limit|overloaded|econnreset|network|fetch failed|temporar|try again/i.test(
    getErrorText(error),
  )
}

const saveGenerateJob = async (env, job) => {
  const record = { ...job, updatedAt: Date.now() }

  if (env.CARD_STORE) {
    await env.CARD_STORE.put(jobStoreKey(record.id), JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24,
    })
    return record
  }

  fallbackCardStore.set(jobStoreKey(record.id), record)
  return record
}

const getGenerateJob = async (env, jobId) => {
  if (!jobId) {
    return null
  }

  if (env.CARD_STORE) {
    return (await env.CARD_STORE.get(jobStoreKey(jobId), 'json')) || null
  }

  return fallbackCardStore.get(jobStoreKey(jobId)) || null
}

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
    imageUrl: job.result?.imageUrl,
  }
}

const failGenerateJob = async (env, job, error, details, photoCount) => {
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
    return await saveGenerateJob(env, failed)
  } catch (saveError) {
    console.error(saveError)
    return { ...failed, updatedAt: Date.now() }
  }
}

const expireStuckGenerateJob = async (env, job) => {
  if (!job || job.status === 'complete' || job.status === 'failed') {
    return job
  }

  if (Date.now() - (job.updatedAt || job.createdAt || 0) < generateJobTimeoutMs) {
    return job
  }

  try {
    return await saveGenerateJob(env, {
      ...job,
      status: 'failed',
      error:
        'That card took too long. Please try generating again. Your credits are still in the lamp.',
      referenceImages: [],
      result: null,
    })
  } catch (error) {
    console.error(error)
    return {
      ...job,
      status: 'failed',
      error:
        'That card took too long. Please try generating again. Your credits are still in the lamp.',
      referenceImages: [],
      result: null,
      updatedAt: Date.now(),
    }
  }
}

const processGenerateJob = async (env, jobInput) => {
  const jobId = typeof jobInput === 'string' ? jobInput : jobInput?.id
  let job = typeof jobInput === 'object' && jobInput ? jobInput : null

  try {
    job = (await getGenerateJob(env, jobId)) || job
  } catch (error) {
    if (!job) {
      throw error
    }

    console.error(error)
  }

  if (!job && jobId) {
    for (let wait = 1; wait <= 4 && !job; wait += 1) {
      await sleep(400 * wait)
      job = await getGenerateJob(env, jobId)
    }
  }

  if (!job || job.status === 'complete' || job.status === 'failed') {
    if (!job) {
      const missing = new Error(
        'We could not find that card job. It may have expired. Please generate again.',
      )
      missing.publicMessage = missing.message
      throw missing
    }

    return
  }

  job = await saveGenerateJob(env, { ...job, status: 'processing' })
  const details = job.details || {}
  const referenceImages = normalizeReferenceImages(job.referenceImages)
  let lastError

  for (let attempt = 1; attempt <= generateJobMaxAttempts; attempt += 1) {
    try {
      const openai = getOpenAI(env)
      const likenessBrief = await describeReferenceImages(openai, env, referenceImages)
      const [copy, imageUrl] = await Promise.all([
        generateCopy(openai, env, details, '', referenceImages, likenessBrief),
        generateImage(openai, env, details, '', 'new', referenceImages, likenessBrief),
      ])

      if (!copy.message || !imageUrl) {
        throw new Error('OpenAI did not return both a message and an image.')
      }

      try {
        await saveGenerateJob(env, {
          ...job,
          status: 'complete',
          error: '',
          referenceImages: [],
          result: {
            message: copy.message,
            closing: copy.closing,
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
        await failGenerateJob(env, job, error, details, referenceImages.length)
        return
      }

      await saveGenerateJob(env, { ...job, status: 'processing', attempt })
      await sleep(1500 * attempt)
    }
  }

  if (lastError) {
    await failGenerateJob(env, job, lastError, details, referenceImages.length)
  }
}

const getCardSummary = (record, request, env) => ({
  ...record,
  shareUrl: getShareUrl(request, env, record.id),
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

const sendSendGridEmailDelivery = async ({ env, to, copy }) => {
  if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: to }],
          subject: copy.subject,
        },
      ],
      from: parseEmailSender(env.EMAIL_FROM),
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

const sendPostmarkEmailDelivery = async ({ env, to, copy }) => {
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

  return to
}

const sendEmailDelivery = async ({ env, to, copy }) => {
  if (env.SENDGRID_API_KEY) {
    return sendSendGridEmailDelivery({ env, to, copy })
  }

  if (env.POSTMARK_SERVER_TOKEN) {
    return sendPostmarkEmailDelivery({ env, to, copy })
  }

  throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
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

const sendTextDelivery = async ({ env, to, copy }) => {
  if (!env.TWILIO_FROM_NUMBER) {
    throw new Error('Text delivery is not configured. Add TWILIO_FROM_NUMBER.')
  }

  const twilioAuth = getTwilioAuthCredentials(env)
  const normalizedTo = normalizePhoneNumber(to)

  const form = new URLSearchParams({
    From: env.TWILIO_FROM_NUMBER,
    To: normalizedTo,
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

  return normalizedTo
}

const fitCopyToLength = async (openai, env, details, copy) => {
  const range = getLengthRange(details.length)

  if (!range || countWords(copy.message) <= range.max) {
    return copy
  }

  const rewriteResponse = await openai.responses.create({
    model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
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

const generateCopy = async (openai, env, details, refinement = '', _referenceImages = [], likenessBrief = '') => {
  const prompt = `${buildCopyPrompt(details, refinement)}${buildLikenessBriefSection(likenessBrief)}
If a likeness brief is provided, keep the message consistent with those people and details. Do not mention photos or that you saw pictures.`

  const copyResponse = await openai.responses.create({
    model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: prompt,
  })

  return fitCopyToLength(openai, env, details, parseCopyResponse(copyResponse))
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

const generateImage = async (
  openai,
  env,
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
    return editImageWithFiles(openai, env, prompt, referenceFiles)
  }

  const imageResponse = await openai.images.generate({
    model: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    prompt,
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

const imageUrlToFile = async (imageUrl, fileName = 'current-cover.png') => {
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageUrl || '')

  if (dataUrlMatch) {
    const [, mimeType, imageBase64] = dataUrlMatch
    return new File([base64ToUint8Array(imageBase64)], fileName, { type: mimeType })
  }

  if (/^https?:\/\//.test(imageUrl || '')) {
    const response = await fetch(imageUrl)

    if (!response.ok) {
      throw new Error('Unable to load the current cover image for editing.')
    }

    const contentType = response.headers.get('content-type') || 'image/png'
    return new File([await response.arrayBuffer()], fileName, { type: contentType })
  }

  throw new Error('Unable to edit the cover because the current image is missing or invalid.')
}

const referenceImagesToFiles = (referenceImages) =>
  Promise.all(referenceImages.map((imageUrl, index) => imageUrlToFile(imageUrl, `reference-${index + 1}.jpg`)))

const editImageWithFiles = async (openai, env, prompt, imageFiles) => {
  const imageResponse = await openai.images.edit({
    model: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    image: imageFiles,
    prompt,
    size: '1024x1536',
    quality: 'medium',
  })

  return getImageUrl(imageResponse, 'OpenAI did not return an edited image.')
}

const editImage = async (
  openai,
  env,
  details,
  refinement,
  currentImageUrl,
  referenceImages = [],
  likenessBrief = '',
) => {
  const currentImage = await imageUrlToFile(currentImageUrl)
  const referenceFiles = await referenceImagesToFiles(referenceImages)
  const prompt = `${buildImageEditPrompt(details, refinement)}${buildReferenceImageGuidance(referenceFiles.length > 0, details.imageStyle)}${buildLikenessBriefSection(likenessBrief, details.imageStyle)}
If additional reference photos are attached after the current cover, use them only for likeness and personal context. Edit the current cover image, not the reference photos.`

  try {
    return await editImageWithFiles(
      openai,
      env,
      prompt,
      referenceFiles.length > 0 ? [currentImage, ...referenceFiles] : [currentImage],
    )
  } catch (error) {
    if (!isSafetyRejection(error) || referenceFiles.length === 0) {
      throw error
    }

    return editImageWithFiles(
      openai,
      env,
      `${buildImageEditPrompt(details, refinement)}${buildLikenessBriefSection(likenessBrief, details.imageStyle)}`,
      [currentImage],
    )
  }
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

const handleSharePreview = async (request, env, cardId) => {
  const record = await getCardRecord(env, cardId)

  if (!record) {
    return jsonResponse(request, env, { error: 'Card not found.' }, 404)
  }

  return new Response(buildSharePreviewHtml(record, request, env), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...getCorsHeaders(request, env),
    },
  })
}

const handleShareCover = async (request, env, cardId) => {
  const record = await getCardRecord(env, cardId)
  const imageUrl = record?.card?.imageUrl

  if (!imageUrl) {
    return jsonResponse(request, env, { error: 'Card not found.' }, 404)
  }

  const parsed = parseDataImage(imageUrl)

  if (parsed) {
    return new Response(parsed.bytes, {
      status: 200,
      headers: {
        'Content-Type': parsed.mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  }

  if (/^https?:\/\//.test(imageUrl)) {
    return Response.redirect(imageUrl, 302)
  }

  return jsonResponse(request, env, { error: 'Card cover is unavailable.' }, 404)
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

    const deliveredTo =
      method === 'email'
        ? await sendEmailDelivery({ env, to: normalizeEmailAddress(cleanDestination), copy })
        : await sendTextDelivery({ env, to: cleanDestination, copy })

    return jsonResponse(request, env, {
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

    return jsonResponse(request, env, { error: message }, isValidationError ? 400 : 500)
  }
}

const handleGenerateCard = async (request, env, ctx) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  let payload

  try {
    payload = await readJson(request)
  } catch {
    return jsonResponse(
      request,
      env,
      { error: 'The card request was incomplete. Please try generating again.' },
      400,
    )
  }

  const { referenceImages: rawReferenceImages, ...details } = payload || {}
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: `Missing required fields: ${missingFields.join(', ')}` }, 400)
  }

  let job

  try {
    job = await saveGenerateJob(env, {
      id: createCardId(),
      status: 'queued',
      details,
      referenceImages,
      createdAt: Date.now(),
      attempt: 0,
      error: '',
      result: null,
    })
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: 'Unable to start creating the card. Please try again.' },
      500,
    )
  }

  try {
    if (!env.GENERATE_QUEUE || typeof env.GENERATE_QUEUE.send !== 'function') {
      throw new Error('Generate queue is not configured.')
    }

    await env.GENERATE_QUEUE.send({ jobId: job.id })
  } catch (error) {
    console.error(error)
    try {
      await failGenerateJob(
        env,
        job,
        new Error('Unable to start creating the card. Please try again.'),
        details,
        referenceImages.length,
      )
    } catch (failError) {
      console.error(failError)
    }

    return jsonResponse(
      request,
      env,
      { error: 'Unable to start creating the card. Please try again.' },
      500,
    )
  }

  return jsonResponse(request, env, { jobId: job.id, status: 'queued' }, 202)
}

const handleGetGenerateJob = async (request, env, jobId) => {
  if (!jobId) {
    return jsonResponse(request, env, { error: 'Missing card job.' }, 400)
  }

  try {
    let job = await getGenerateJob(env, jobId)

    if (!job) {
      return jsonResponse(
        request,
        env,
        { error: 'We could not find that card job. It may have expired. Please generate again.' },
        404,
      )
    }

    job = await expireStuckGenerateJob(env, job)
    return jsonResponse(request, env, publicGenerateJob(job))
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: 'Unable to check on your card. Please try again.' },
      500,
    )
  }
}

const handleRefineImage = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const { details, refinement, imageMode, currentImageUrl, referenceImages: rawReferenceImages } =
    (await readJson(request)) || {}
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: `Missing required fields: ${missingFields.join(', ')}` }, 400)
  }

  if (!refinement?.trim()) {
    return jsonResponse(request, env, { error: 'Tell us what to change about the cover image.' }, 400)
  }

  try {
    const openai = getOpenAI(env)
    const likenessBrief = await describeReferenceImages(openai, env, referenceImages)
    const imageUrl =
      imageMode === 'new'
        ? await generateImage(openai, env, details, refinement, 'new', referenceImages, likenessBrief)
        : await editImage(openai, env, details, refinement, currentImageUrl, referenceImages, likenessBrief)

    return jsonResponse(request, env, { imageUrl })
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      {
        error: publicGenerationError(error, 'Unable to refine the image.', {
          hasPhotos: referenceImages.length > 0,
          photoCount: referenceImages.length,
          details: { ...details, refinement },
        }),
      },
      isSafetyRejection(error) ? 400 : 500,
    )
  }
}

const handleRefineCopy = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const { details, refinement, currentMessage, currentClosing, referenceImages: rawReferenceImages } =
    (await readJson(request)) || {}
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details || {})

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: `Missing required fields: ${missingFields.join(', ')}` }, 400)
  }

  if (!refinement?.trim()) {
    return jsonResponse(request, env, { error: 'Tell us what to change about the inside message.' }, 400)
  }

  try {
    const openai = getOpenAI(env)
    const likenessBrief = await describeReferenceImages(openai, env, referenceImages)
    const copy = await generateCopy(
      openai,
      env,
      {
        ...details,
        keyDetails: `${details.keyDetails}\n\nCurrent inside message: ${currentMessage || ''}\nCurrent closing: ${currentClosing || ''}`,
      },
      refinement,
      referenceImages,
      likenessBrief,
    )

    return jsonResponse(request, env, copy)
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      {
        error: publicGenerationError(error, 'Unable to refine the inside message.', {
          hasPhotos: referenceImages.length > 0,
          photoCount: referenceImages.length,
          details: { ...details, refinement },
        }),
      },
      isSafetyRejection(error) ? 400 : 500,
    )
  }
}

const handleRequest = async (request, env, ctx) => {
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

  const sharePath = request.method === 'GET' ? getSharePathParts(url.pathname) : null

  if (sharePath?.isCover) {
    return handleShareCover(request, env, sharePath.cardId)
  }

  if (sharePath) {
    return handleSharePreview(request, env, sharePath.cardId)
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
    return handleGenerateCard(request, env, ctx)
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/generate-jobs/')) {
    return handleGetGenerateJob(
      request,
      env,
      decodeURIComponent(url.pathname.replace('/api/generate-jobs/', '')),
    )
  }

  if (request.method === 'POST' && url.pathname === '/api/refine-image') {
    return handleRefineImage(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/refine-copy') {
    return handleRefineCopy(request, env)
  }

  return jsonResponse(request, env, { error: 'Not found' }, 404)
}

const handleGenerateQueue = async (batch, env) => {
  for (const message of batch.messages) {
    const jobId = message.body?.jobId

    if (!jobId) {
      console.error('Generate queue message was missing a job id.')
      message.ack()
      continue
    }

    try {
      await processGenerateJob(env, jobId)
      message.ack()
    } catch (error) {
      console.error(error)

      let job = null
      try {
        job = await getGenerateJob(env, jobId)
      } catch (lookupError) {
        console.error(lookupError)
      }

      if (job?.status === 'complete' || job?.status === 'failed') {
        message.ack()
        continue
      }

      const attempts = Number(message.attempts) || 1

      if (attempts >= generateQueueMaxDeliveryAttempts) {
        if (job) {
          try {
            await failGenerateJob(
              env,
              job,
              error,
              job.details || {},
              Array.isArray(job.referenceImages) ? job.referenceImages.length : 0,
            )
          } catch (failError) {
            console.error(failError)
          }
        }

        message.ack()
        continue
      }

      message.retry()
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx)
    } catch (error) {
      console.error(error)
      return jsonResponse(
        request,
        env,
        { error: publicGenerationError(error, 'Unable to complete that request. Please try again.') },
        isSafetyRejection(error) ? 400 : 500,
      )
    }
  },
  async queue(batch, env) {
    await handleGenerateQueue(batch, env)
  },
}
