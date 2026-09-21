import OpenAI from 'openai'
import Stripe from 'stripe'
import {
  accountDbReady,
  applyCreditChange,
  createTestimonial,
  ensureAccountUser,
  findUserByPhone,
  getAccountForSession,
  getAccountHistory,
  getAdminMetrics,
  getSenderContactForCard,
  getThankYouForCard,
  isAdminPhone,
  listTestimonials,
  recordFailedDelivery,
  recordStripeCreditPurchase,
  recordSuccessfulDelivery,
  recordThankYou,
  createPrintOrder,
  saveAccountEmail,
  saveAccountMailingAddress,
  updateAccountProfile,
  updateTestimonialStatus,
  upsertUserOnLogin,
} from './account-db.js'
import {
  ensureCoverThumbForRecord,
  getCoverThumbBytes,
  getCoverThumbUrl,
  hasCoverThumb,
  putCoverThumbFromDataUrl,
} from './cover-thumbs.js'
import {
  appendCoverRevision,
  getCoverRevisionBytes,
  listCoverRevisions,
} from './cover-revisions.js'

const defaultAllowedOrigins =
  'http://localhost:5173,http://127.0.0.1:5173,https://card-genie.com,https://www.card-genie.com'
const fallbackCardStore = new Map()

const COVER_IMAGE_SIZE = '1056x1472'
const COVER_IMAGE_WIDTH = 1056
const COVER_IMAGE_HEIGHT = 1472
/** Outer band kept clear of essential content for print trim (15% ≈ 226px at 1504 print width). */
const COVER_SAFE_MARGIN_PERCENT = 15

/** Live Stripe Price IDs for credit packs. */
const creditPacks = [
  { id: '10', credits: 10, price: 5, priceId: 'price_1UFlLJ1GfvmAXQBhxxvROUc7' },
  { id: '25', credits: 25, price: 10, priceId: 'price_1UFlL11GfvmAXQBhBGbdzji0' },
  { id: '60', credits: 60, price: 20, priceId: 'price_1UFlKl1GfvmAXQBho0xWW6JO' },
]

const creditPackById = new Map(creditPacks.map((pack) => [pack.id, pack]))
const creditPackByPriceId = new Map(creditPacks.map((pack) => [pack.priceId, pack]))

const stripeApiVersion = '2026-08-26.dahlia'

const getStripe = (env) => {
  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim()
  if (!secretKey) {
    return null
  }

  return new Stripe(secretKey, {
    apiVersion: stripeApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
  })
}

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
const aiChoosesStyleLabel = 'AI chooses the best style for this card'
const aiChoosesIllustratedStyles = [
  'Watercolor greeting card illustration',
  'Whimsical storybook illustration',
  'Elegant botanical paper-cut style',
  'Minimal modern flat vector art',
  'Soft pastel nursery-book illustration',
  'Premium editorial illustration',
]

const normalizeReferenceImages = (value) => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item) => typeof item === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(item))
    .slice(0, maxReferenceImages)
}

const isAiChoosesImageStyle = (imageStyle = '') => {
  const style = String(imageStyle || '').trim()
  return !style || /AI chooses the best style/i.test(style)
}

const buildAiChoosesStyleGuidance = (imageStyle = '', hasReferenceImages = false) => {
  if (!isAiChoosesImageStyle(imageStyle)) {
    return `- Use the selected visual style as the primary art direction: "${String(imageStyle).trim()}".`
  }

  if (hasReferenceImages) {
    return `- The shopper left style as "${aiChoosesStyleLabel}" and provided people photos. Prefer "Photorealistic warm portrait photography" so likeness reads clearly. You may instead choose one illustrated medium from this list if it clearly fits better: ${aiChoosesIllustratedStyles.join('; ')}.`
  }

  return `- The shopper left style as "${aiChoosesStyleLabel}" and did not provide people photos. You MUST choose exactly one illustrated medium from this list: ${aiChoosesIllustratedStyles.join('; ')}. Do NOT use photorealistic or photographic styles.`
}

const buildImagePrompt = (details, refinement = '', imageMode = 'new', hasReferenceImages = false) => `
${imageMode === 'revise' ? 'Create a revised version of the existing front cover concept for a personalized greeting card.' : 'Create the front cover artwork for a personalized greeting card.'}

The generated image must be portrait artwork at ${COVER_IMAGE_WIDTH}px wide by ${COVER_IMAGE_HEIGHT}px tall, composed for a greeting-card cover in standard 5x7 proportions. The app will place this image inside a separate card frame, so do not add paper edges, borders, shadows, mockups, envelopes, UI, or folded-card effects.

Occasion: ${details.occasion}
Recipient: ${details.recipientName || details.recipientType}
Relationship: ${details.recipientType}
Tone: ${details.tone}
Visual style: ${details.imageStyle || aiChoosesStyleLabel}
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
${buildAiChoosesStyleGuidance(details.imageStyle, hasReferenceImages)}
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
- Stay in the selected art style. Never output a photograph unless the selected style is photorealistic${
  hasReferenceImages ? '' : ' (and never when no people photos were provided and style was left to AI)'
}.

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

const getAllowedOrigins = (env) =>
  (env.ALLOWED_ORIGINS || defaultAllowedOrigins)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

const getCorsHeaders = (request, env) => {
  const origin = request.headers.get('Origin')
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

const getCheckoutReturnBaseUrl = (request, env) => {
  const origin = request.headers.get('Origin')
  if (origin && getAllowedOrigins(env).includes(origin)) {
    return origin.replace(/\/$/, '')
  }
  return getPublicAppUrl(request, env)
}

const getShareBaseUrl = (request, env) =>
  (env.SHARE_BASE_URL || env.PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, '')

const getShareUrl = (request, env, cardId) => `${getShareBaseUrl(request, env)}/c/${encodeURIComponent(cardId)}`

const getSharePathParts = (pathname) => {
  const match = pathname.match(/^\/c\/([^/]+)(?:\/(cover|thumb))?\/?$/)

  if (!match) {
    return null
  }

  return {
    cardId: decodeURIComponent(match[1]),
    isCover: match[2] === 'cover',
    isThumb: match[2] === 'thumb',
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
    ? `${recipientFirstName}, open your personalized card from ${sender}.`
    : `Open your personalized card from ${sender}.`

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

  const existingId = typeof payload?.cardId === 'string' ? payload.cardId.trim() : ''

  return {
    id: existingId || createCardId(),
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

const saveCardRecord = async (env, record, { coverThumbDataUrl, revisionSource = 'save', refinement = '' } = {}) => {
  if (env.CARD_STORE) {
    await env.CARD_STORE.put(record.id, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 })
  } else {
    fallbackCardStore.set(record.id, record)
  }

  try {
    if (coverThumbDataUrl) {
      await putCoverThumbFromDataUrl(env, record.id, coverThumbDataUrl)
    } else {
      await ensureCoverThumbForRecord(env, record)
    }
  } catch (error) {
    console.error('Unable to save cover thumbnail.', error)
  }

  try {
    await appendCoverRevision(env, {
      cardId: record.id,
      imageUrl: record?.card?.imageUrl,
      source: revisionSource,
      refinement,
      details: record?.details || null,
    })
  } catch (error) {
    console.error('Unable to save cover revision snapshot.', error)
  }
}

const updateCardCoverImage = async (
  env,
  cardId,
  imageUrl,
  { coverThumbDataUrl, revisionSource = 'revise', refinement = '', details = null } = {},
) => {
  const existing = await getCardRecord(env, cardId)
  if (!existing?.card) {
    return null
  }

  const next = {
    ...existing,
    updatedAt: new Date().toISOString(),
    details: details
      ? {
          recipientName: details.recipientName?.trim() || existing.details?.recipientName || '',
          recipientType: details.recipientType?.trim() || existing.details?.recipientType || '',
          senderName: details.senderName?.trim() || existing.details?.senderName || '',
          occasion: details.occasion?.trim() || existing.details?.occasion || '',
        }
      : existing.details,
    card: {
      ...existing.card,
      imageUrl,
    },
  }

  await saveCardRecord(env, next, {
    coverThumbDataUrl,
    revisionSource,
    refinement,
  })
  return next
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
    selectedLength: job.result?.selectedLength,
    messageVariants: job.result?.messageVariants,
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
        'That card took too long. Please try generating again. Your credits are still in your account.',
      referenceImages: [],
      result: null,
    })
  } catch (error) {
    console.error(error)
    return {
      ...job,
      status: 'failed',
      error:
        'That card took too long. Please try generating again. Your credits are still in your account.',
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
        generateCopyVariants(openai, env, details, likenessBrief),
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

const getEmailCoverUrl = (request, cardId) =>
  `${new URL(request.url).origin}/c/${encodeURIComponent(cardId)}/cover`

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

const sendSendGridEmailDelivery = async ({ env, to, copy, attachments = [] }) => {
  if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
  }

  const payload = {
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
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
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

const sendPostmarkEmailDelivery = async ({ env, to, copy, attachments = [] }) => {
  if (!env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM) {
    throw new Error('Email delivery is not configured. Add POSTMARK_SERVER_TOKEN and EMAIL_FROM.')
  }

  const payload = {
    From: env.EMAIL_FROM,
    To: to,
    Subject: copy.subject,
    TextBody: copy.text,
    HtmlBody: copy.html,
    MessageStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
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
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Postmark could not send the card. ${errorText}`)
  }

  return to
}

const sendEmailDelivery = async ({ env, to, copy, attachments = [] }) => {
  if (env.SENDGRID_API_KEY) {
    return sendSendGridEmailDelivery({ env, to, copy, attachments })
  }

  if (env.POSTMARK_SERVER_TOKEN) {
    return sendPostmarkEmailDelivery({ env, to, copy, attachments })
  }

  throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
}

const PRINT_ORDER_SUPPORT_EMAIL = 'support@card-genie.com'
const PRINT_CARD_CREDIT_COST = 10

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
  const subject = `Genie card order · ${orderCode} · ${shipTo.name}`
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
  const deliveryNote =
    'There is no tracking available on your order. It is mailed out in a regular envelope with a postage stamp.'
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
    'Delivery Note:',
    deliveryNote,
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
      <p style="margin: 0 0 12px;">${deliveryCopy}</p>
      <p style="margin: 0 0 4px;"><strong>Delivery Note:</strong></p>
      <p style="margin: 0 0 16px;">${deliveryNote}</p>
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

const generateCopy = async (openai, env, details, refinement = '', _referenceImages = [], likenessBrief = '') => {
  const messageKeyDetails = extractMessageKeyDetails(getOriginalKeyDetails(details))
  const prompt = `${buildCopyPrompt(details, refinement, messageKeyDetails)}${buildLikenessBriefSection(likenessBrief)}
If a likeness brief is provided, you may use it to know who the card is about, but do not describe anyone's physical appearance in the message. Do not mention photos or that you saw pictures.`

  const copyResponse = await openai.responses.create({
    model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    input: prompt,
  })

  const copy = await fitCopyToLength(openai, env, details, parseCopyResponse(copyResponse))

  return {
    ...copy,
    message: stripAppearanceFromMessage(copy.message),
  }
}

const generateCopyVariants = async (openai, env, details, likenessBrief = '') => {
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
    model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
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

  // Fall back to a single generateCopy pass if the multi-length JSON was incomplete.
  if (!variants.short || !variants.medium || !variants.long) {
    const fallback = await generateCopy(openai, env, { ...details, length: 'Medium, 20-40 words' }, '', [], likenessBrief)
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

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

const isGptImageModel = (model) => /gpt-image/i.test(String(model || ''))

const buildImageModelParams = (env) => {
  const model = env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare'
  const params = {
    model,
    size: COVER_IMAGE_SIZE,
    quality: 'medium',
  }

  // DALL·E defaults to temporary URLs — force base64. GPT Image already returns b64_json.
  if (!isGptImageModel(model)) {
    params.response_format = 'b64_json'
  }

  return params
}

/** Always return a data URL so browsers never depend on expiring/CORS-blocked OpenAI URLs. */
const getImageUrl = async (imageResponse, fallbackMessage) => {
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
    const base64 = arrayBufferToBase64(await response.arrayBuffer())
    return `data:${contentType};base64,${base64}`
  }

  throw new Error(fallbackMessage)
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
  const prompt = `${buildImagePrompt(details, refinement, imageMode, referenceImages.length > 0)}${photoGuidance}${likenessSection}`
  const referenceFiles = referenceImages.length > 0 ? await referenceImagesToFiles(referenceImages) : []

  if (referenceFiles.length > 0) {
    return editImageWithFiles(openai, env, prompt, referenceFiles)
  }

  const imageResponse = await openai.images.generate({
    ...buildImageModelParams(env),
    prompt,
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
    ...buildImageModelParams(env),
    image: imageFiles,
    prompt,
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
  cardId = '',
) => {
  let sourceUrl = typeof currentImageUrl === 'string' ? currentImageUrl.trim() : ''

  if ((!sourceUrl || sourceUrl.length < 64) && cardId) {
    const record = await getCardRecord(env, cardId)
    sourceUrl = record?.card?.imageUrl?.trim() || ''
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
    const payload = await readJson(request)
    const requestedId = typeof payload?.cardId === 'string' ? payload.cardId.trim() : ''
    const existing = requestedId ? await getCardRecord(env, requestedId) : null
    const record = buildCardRecord({
      ...payload,
      // Only reuse an id that already exists — prevents spoofing new ids.
      cardId: existing ? requestedId : '',
    })
    if (existing?.createdAt) {
      record.createdAt = existing.createdAt
      record.updatedAt = new Date().toISOString()
    }
    await saveCardRecord(env, record, {
      coverThumbDataUrl: payload?.coverThumb,
      revisionSource: 'save',
    })

    return jsonResponse(request, env, getCardSummary(record, request, env), existing ? 200 : 201)
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

const handleListCardCoverRevisions = async (request, env, cardId) => {
  const revisions = await listCoverRevisions(env, cardId)
  const requestOrigin = new URL(request.url).origin
  return jsonResponse(request, env, {
    cardId,
    retentionDays: 7,
    revisions: revisions.map((entry) => ({
      ...entry,
      imageUrl: `${requestOrigin}/api/cards/${encodeURIComponent(cardId)}/revisions/${encodeURIComponent(entry.id)}/image`,
    })),
  })
}

const handleGetCardCoverRevisionImage = async (request, env, cardId, revisionId) => {
  const revisions = await listCoverRevisions(env, cardId)
  const meta = revisions.find((entry) => entry.id === revisionId)
  const image = await getCoverRevisionBytes(env, revisionId)

  if (!meta || !image?.bytes?.byteLength) {
    return jsonResponse(request, env, { error: 'Cover revision not found or expired.' }, 404)
  }

  return new Response(image.bytes, {
    status: 200,
    headers: {
      'Content-Type': image.contentType || meta.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

const thankYouPresets = [
  {
    id: 'thank_you',
    label: 'Thank you for the beautiful card!',
    message: 'Thank you for the beautiful card!',
  },
  {
    id: 'made_my_day',
    label: 'This made my day.',
    message: 'This made my day. Thank you for the card!',
  },
  {
    id: 'custom',
    label: 'Write your own',
    message: '',
    allowsCustom: true,
  },
]

const thankYouCustomMaxLength = 180

const getThankYouPreset = (presetId) => thankYouPresets.find((preset) => preset.id === presetId) || null

const normalizeThankYouMessage = (value = '') =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

const resolveThankYouMessage = (preset, customMessage) => {
  if (preset.allowsCustom) {
    const message = normalizeThankYouMessage(customMessage)
    if (!message) {
      throw new Error('Write a short thank-you message.')
    }
    if (message.length > thankYouCustomMaxLength) {
      throw new Error(`Keep your thank-you under ${thankYouCustomMaxLength} characters.`)
    }
    return message
  }

  return preset.message
}

const buildThankYouDeliveryCopy = ({ recipientName, senderName, message }) => {
  const fromName = recipientName?.trim() || 'Someone'
  const toName = senderName?.trim() || 'there'
  const subject = `${fromName} said thank you for your card`
  const text = `Hi ${toName},

${fromName} opened your Card Genie card and wanted to say:

"${message}"

— Card Genie`
  const html = `<p>Hi ${escapeHtml(toName)},</p>
<p><strong>${escapeHtml(fromName)}</strong> opened your Card Genie card and wanted to say:</p>
<p>“${escapeHtml(message)}”</p>
<p>— Card Genie</p>`

  return { subject, text, html }
}

const handleGetThankYouStatus = async (request, env, cardId) => {
  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { available: false, alreadySent: false, presets: thankYouPresets })
  }

  const existing = await getThankYouForCard(env, cardId)
  if (existing) {
    return jsonResponse(request, env, {
      available: false,
      alreadySent: true,
      presets: thankYouPresets,
    })
  }

  const sender = await getSenderContactForCard(env, cardId)
  return jsonResponse(request, env, {
    available: Boolean(sender?.phoneE164 || sender?.email),
    alreadySent: false,
    presets: thankYouPresets,
  })
}

const handleSendThankYou = async (request, env, cardId) => {
  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Thank-you messaging is not available right now.' }, 503)
  }

  const body = (await readJson(request)) || {}
  const preset = getThankYouPreset(body.presetId)
  if (!preset) {
    return jsonResponse(request, env, { error: 'Choose a thank-you message.' }, 400)
  }

  let message = ''
  try {
    message = resolveThankYouMessage(preset, body.message)
  } catch (error) {
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Choose a thank-you message.' }, 400)
  }

  const existing = await getThankYouForCard(env, cardId)
  if (existing) {
    return jsonResponse(request, env, { error: 'A thank-you was already sent for this card.' }, 409)
  }

  const kvCard = await getCardRecord(env, cardId)
  const sender = await getSenderContactForCard(env, cardId)
  if (!sender) {
    return jsonResponse(
      request,
      env,
      { error: 'This card can’t receive a thank-you yet. The sender may only have shared a link.' },
      400,
    )
  }

  const recipientName =
    kvCard?.details?.recipientName?.trim() ||
    sender.recipientName ||
    kvCard?.signature ||
    'Someone'
  const senderName = kvCard?.details?.senderName?.trim() || sender.senderName || 'there'
  const copy = buildThankYouDeliveryCopy({
    recipientName,
    senderName,
    message,
  })

  try {
    let method = 'text'
    let destination = sender.phoneE164

    if (sender.phoneE164) {
      destination = await sendTextDelivery({ env, to: sender.phoneE164, copy })
      method = 'text'
    } else if (sender.email) {
      destination = await sendEmailDelivery({ env, to: normalizeEmailAddress(sender.email), copy })
      method = 'email'
    } else {
      return jsonResponse(request, env, { error: 'The sender has no contact method on file.' }, 400)
    }

    await recordThankYou(env, {
      cardId,
      userId: sender.userId,
      presetId: preset.id,
      message,
      method,
      destination,
      recipientName,
    })

    return jsonResponse(request, env, {
      ok: true,
      method,
      message: 'Your thank-you is on its way to the sender.',
    })
  } catch (error) {
    if (error?.code === 'already_sent') {
      return jsonResponse(request, env, { error: error.message }, 409)
    }
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to send the thank-you right now.' },
      400,
    )
  }
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
        // Covers change on revise; avoid shipping a stale cached original after edits.
        'Cache-Control': 'public, max-age=60, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  if (/^https?:\/\//.test(imageUrl)) {
    return Response.redirect(imageUrl, 302)
  }

  return jsonResponse(request, env, { error: 'Card cover is unavailable.' }, 404)
}

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

const accountSessionTtlSeconds = 60 * 60 * 24 * 30
const otpTtlSeconds = 60 * 10

const hashSecret = async (value) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const sendAccountSms = async ({ env, to, body }) => {
  if (!env.TWILIO_FROM_NUMBER) {
    throw new Error('Text delivery is not configured. Add TWILIO_FROM_NUMBER.')
  }

  const twilioAuth = getTwilioAuthCredentials(env)
  const form = new URLSearchParams({
    From: env.TWILIO_FROM_NUMBER,
    To: to,
    Body: body,
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
    throw new Error(`Twilio could not send the sign-in code. ${errorText}`)
  }
}

const readAccountToken = (request) => {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

const getAccountSession = async (env, token) => {
  if (!token || !env.CARD_STORE) {
    return null
  }

  return (await env.CARD_STORE.get(`session:${token}`, 'json')) || null
}

const handleStartAccountOtp = async (request, env) => {
  try {
    const { phone } = (await readJson(request)) || {}
    const phoneE164 = normalizePhoneNumber(phone)

    if (!env.CARD_STORE) {
      return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
    }

    const existing = (await env.CARD_STORE.get(`otp:${phoneE164}`, 'json')) || null
    if (existing?.sentAt && Date.now() - existing.sentAt < 30 * 1000) {
      return jsonResponse(request, env, { error: 'Please wait a moment before requesting another code.' }, 429)
    }

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
    await env.CARD_STORE.put(
      `otp:${phoneE164}`,
      JSON.stringify({
        codeHash: await hashSecret(code),
        attempts: 0,
        sentAt: Date.now(),
      }),
      { expirationTtl: otpTtlSeconds },
    )
    await sendAccountSms({
      env,
      to: phoneE164,
      body: `Your Card Genie code is ${code}. It expires in 10 minutes.`,
    })

    return jsonResponse(request, env, {
      ok: true,
      phoneE164,
      message: 'We texted you a 6-digit code.',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to send a sign-in code.'
    return jsonResponse(request, env, { error: message }, 400)
  }
}

const handleVerifyAccountOtp = async (request, env) => {
  try {
    const { phone, code } = (await readJson(request)) || {}
    const phoneE164 = normalizePhoneNumber(phone)
    const cleanCode = String(code || '').replace(/\D/g, '')

    if (!env.CARD_STORE) {
      return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
    }

    if (cleanCode.length !== 6) {
      return jsonResponse(request, env, { error: 'Enter the 6-digit code from the text message.' }, 400)
    }

    const challenge = await env.CARD_STORE.get(`otp:${phoneE164}`, 'json')
    if (!challenge) {
      return jsonResponse(request, env, { error: 'That code expired. Request a new one.' }, 400)
    }

    if ((challenge.attempts || 0) >= 5) {
      return jsonResponse(request, env, { error: 'Too many tries. Request a new code.' }, 400)
    }

    if ((await hashSecret(cleanCode)) !== challenge.codeHash) {
      await env.CARD_STORE.put(
        `otp:${phoneE164}`,
        JSON.stringify({ ...challenge, attempts: (challenge.attempts || 0) + 1 }),
        { expirationTtl: otpTtlSeconds },
      )
      return jsonResponse(request, env, { error: 'That code does not match. Try again.' }, 400)
    }

    const userKey = `user:phone:${phoneE164}`
    const existingUser = (await env.CARD_STORE.get(userKey, 'json')) || null
    const account = await upsertUserOnLogin(env, {
      phoneE164,
      request,
      existingUserId: existingUser?.id,
    })
    const user = {
      id: account?.id || existingUser?.id || crypto.randomUUID(),
      phoneE164,
      email: account?.email || existingUser?.email || '',
      creditBalance: account?.creditBalance ?? existingUser?.creditBalance ?? 2,
      createdAt: existingUser?.createdAt || Date.now(),
      lastLoginAt: Date.now(),
    }
    await env.CARD_STORE.put(userKey, JSON.stringify(user))

    const token = crypto.randomUUID()
    await env.CARD_STORE.put(
      `session:${token}`,
      JSON.stringify({
        token,
        userId: user.id,
        phoneE164,
        createdAt: Date.now(),
      }),
      { expirationTtl: accountSessionTtlSeconds },
    )
    await env.CARD_STORE.delete(`otp:${phoneE164}`)

    return jsonResponse(request, env, {
      ok: true,
      token,
      phoneE164,
      email: user.email || '',
      preferredName: user.preferredName || '',
      creditBalance: user.creditBalance ?? 2,
      isNew: account?.isNew === true,
      phoneVerifyBonusCredits: account?.isNew ? account.phoneVerifyBonusCredits || 2 : 0,
      message:
        account?.isNew === true
          ? 'Your number is confirmed. We added 2 credits for registering.'
          : existingUser || account?.isNew === false
            ? 'Welcome back.'
            : 'Your account is ready.',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to confirm that code.'
    return jsonResponse(request, env, { error: message }, 400)
  }
}

const handleAdjustAccountCredits = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number before changing credits.' }, 401)
  }

  const { balance, add, reason } = (await readJson(request)) || {}
  const reasonKey = String(reason || 'adjustment')
  const addAmount = Number(add)
  const isPurchaseGrant = Number.isFinite(addAmount) && addAmount > 0
  const isDevSet = reasonKey === 'dev_set' || reasonKey === 'demo_purchase'
  if ((isPurchaseGrant || isDevSet) && !isAdminPhone(session.phoneE164)) {
    return jsonResponse(request, env, { error: 'Use Buy more credits to purchase a pack.' }, 403)
  }

  const nextBalance = await applyCreditChange(env, {
    userId: session.userId,
    phoneE164: session.phoneE164,
    balance: Number.isFinite(Number(balance)) ? Number(balance) : undefined,
    delta: Number.isFinite(addAmount) ? addAmount : undefined,
    reason: reasonKey,
    kind: isPurchaseGrant ? 'purchase' : 'adjustment',
    note: isDevSet ? 'Demo credit change. No payment was taken.' : '',
  })

  if (nextBalance === null) {
    return jsonResponse(request, env, { error: 'Unable to update credits for this account.' }, 400)
  }

  return jsonResponse(request, env, { ok: true, creditBalance: nextBalance })
}

const resolveCreditPack = ({ packId, priceId } = {}) => {
  if (priceId && creditPackByPriceId.has(String(priceId))) {
    return creditPackByPriceId.get(String(priceId))
  }
  if (packId && creditPackById.has(String(packId))) {
    return creditPackById.get(String(packId))
  }
  return null
}

const handleCreateCheckoutSession = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number before buying credits.' }, 401)
  }

  const stripe = getStripe(env)
  if (!stripe) {
    return jsonResponse(request, env, { error: 'Checkout is not configured yet.' }, 503)
  }

  const body = (await readJson(request)) || {}
  const pack = resolveCreditPack(body)
  if (!pack) {
    return jsonResponse(request, env, { error: 'Choose a valid credit pack.' }, 400)
  }

  const appUrl = getCheckoutReturnBaseUrl(request, env)
  const integrationSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const resumeCardId = String(body.resumeCardId || '').trim()
  const resumeQuery =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeCardId)
      ? `&resume=${encodeURIComponent(resumeCardId)}`
      : ''

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: pack.priceId, quantity: 1 }],
      success_url: `${appUrl}/?billing=success${resumeQuery}`,
      cancel_url: `${appUrl}/?billing=cancel${resumeQuery}`,
      client_reference_id: session.userId,
      metadata: {
        userId: session.userId,
        phoneE164: session.phoneE164 || '',
        credits: String(pack.credits),
        packId: pack.id,
        priceId: pack.priceId,
        ...(resumeQuery ? { resumeCardId } : {}),
      },
      integration_identifier: `card-genie-credits-${integrationSuffix}`,
    })

    if (!checkoutSession.url) {
      return jsonResponse(request, env, { error: 'Unable to start Stripe Checkout.' }, 500)
    }

    return jsonResponse(request, env, {
      ok: true,
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    })
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to start Stripe Checkout.' },
      500,
    )
  }
}

const grantCreditsFromCheckoutSession = async (env, checkoutSession) => {
  const metadata = checkoutSession?.metadata || {}
  const pack =
    resolveCreditPack({
      packId: metadata.packId,
      priceId: metadata.priceId || checkoutSession?.metadata?.priceId,
    }) ||
    resolveCreditPack({
      priceId: checkoutSession?.line_items?.data?.[0]?.price?.id,
    })

  const userId = String(metadata.userId || checkoutSession.client_reference_id || '').trim()
  const phoneE164 = String(metadata.phoneE164 || '').trim()
  const credits = Number(metadata.credits) || pack?.credits || 0
  const stripeCheckoutId = checkoutSession.id

  if (!userId || !credits || !stripeCheckoutId) {
    console.error('Stripe checkout completed without grantable metadata.', {
      userId,
      credits,
      stripeCheckoutId,
    })
    return { ok: false, error: 'missing_metadata' }
  }

  const paymentIntent =
    typeof checkoutSession.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : checkoutSession.payment_intent?.id || null
  const customer =
    typeof checkoutSession.customer === 'string'
      ? checkoutSession.customer
      : checkoutSession.customer?.id || null

  const result = await recordStripeCreditPurchase(env, {
    userId,
    phoneE164,
    credits,
    amountCents: checkoutSession.amount_total ?? (pack ? pack.price * 100 : 0),
    currency: checkoutSession.currency || 'usd',
    stripeCheckoutId,
    stripePaymentIntentId: paymentIntent,
    stripeCustomerId: customer,
    receiptEmail: checkoutSession.customer_details?.email || checkoutSession.customer_email || null,
    packId: pack?.id || metadata.packId || '',
    priceId: pack?.priceId || metadata.priceId || '',
  })

  return { ok: true, ...result }
}

const handleStripeWebhook = async (request, env) => {
  const stripe = getStripe(env)
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || '').trim()
  if (!stripe || !webhookSecret) {
    return jsonResponse(request, env, { error: 'Webhook is not configured.' }, 503)
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return jsonResponse(request, env, { error: 'Missing Stripe signature.' }, 400)
  }

  const rawBody = await request.text()
  let event
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    )
  } catch (error) {
    console.error('Stripe webhook signature verification failed.', error)
    return jsonResponse(request, env, { error: 'Invalid Stripe signature.' }, 400)
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const checkoutSession = event.data.object
      const paymentStatus = checkoutSession.payment_status
      if (paymentStatus === 'paid' || paymentStatus === 'no_payment_required' || event.type === 'checkout.session.async_payment_succeeded') {
        await grantCreditsFromCheckoutSession(env, checkoutSession)
      }
    }
  } catch (error) {
    console.error('Stripe webhook processing failed.', error)
    return jsonResponse(request, env, { error: 'Unable to process webhook.' }, 500)
  }

  return jsonResponse(request, env, { received: true })
}

const handleGetAccountHistory = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number to see your account.' }, 401)
  }

  const history = await getAccountHistory(env, session.userId, session.phoneE164)
  if (!history) {
    return jsonResponse(request, env, {
      ok: true,
      phoneE164: session.phoneE164,
      account: null,
      creditEvents: [],
      cards: [],
      deliveries: [],
    })
  }

  const cardIds = [
    ...new Set(
      [
        ...(history.cards || []).map((card) => card.id),
        ...(history.deliveries || []).map((delivery) => delivery.cardId),
        ...(history.printOrders || []).map((order) => order.cardId),
      ].filter(Boolean),
    ),
  ]

  const thumbsAvailable = new Set()
  await Promise.all(
    cardIds.map(async (cardId) => {
      if (await hasCoverThumb(env, cardId)) {
        thumbsAvailable.add(cardId)
        return
      }

      const record = await getCardRecord(env, cardId)
      if (!record?.card?.imageUrl) {
        return
      }

      const result = await ensureCoverThumbForRecord(env, record)
      if (result.ok) {
        thumbsAvailable.add(cardId)
      }
    }),
  )

  const withThumbUrls = (items, idKey = 'id') =>
    (items || []).map((item) => {
      const cardId = item[idKey] || item.cardId || item.id
      return {
        ...item,
        coverThumbUrl: cardId && thumbsAvailable.has(cardId) ? getCoverThumbUrl(request, env, cardId) : '',
      }
    })

  return jsonResponse(request, env, {
    ok: true,
    phoneE164: session.phoneE164,
    ...history,
    cards: withThumbUrls(history.cards, 'id'),
    deliveries: withThumbUrls(history.deliveries, 'cardId'),
    printOrders: withThumbUrls(history.printOrders, 'cardId'),
  })
}

const handleGetCoverThumb = async (request, env, cardId) => {
  const stored = await getCoverThumbBytes(env, cardId)
  if (stored) {
    return new Response(stored.bytes, {
      status: 200,
      headers: {
        'Content-Type': stored.contentType || 'image/jpeg',
        'Cache-Control': 'public, max-age=604800',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  const record = await getCardRecord(env, cardId)
  if (record?.card?.imageUrl) {
    try {
      await ensureCoverThumbForRecord(env, record)
      const created = await getCoverThumbBytes(env, cardId)
      if (created) {
        return new Response(created.bytes, {
          status: 200,
          headers: {
            'Content-Type': created.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=604800',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
    } catch (error) {
      console.error(error)
    }
  }

  return jsonResponse(request, env, { error: 'Cover thumbnail not found.' }, 404)
}

const isCardStoreRecordKey = (name = '') =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)

const handleBackfillCoverThumbs = async (request, env) => {
  if (!(await isAdminRequest(request, env))) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }

  if (!env.CARD_STORE) {
    return jsonResponse(request, env, { error: 'Card storage is not configured.' }, 500)
  }

  const body = (await readJson(request).catch(() => null)) || {}
  const limit = Math.min(100, Math.max(1, Number(body.limit) || 40))
  let cursor = typeof body.cursor === 'string' ? body.cursor : undefined
  let scanned = 0
  let created = 0
  let skipped = 0
  let failed = 0
  const errors = []

  while (scanned < limit) {
    const page = await env.CARD_STORE.list({ limit: Math.min(100, limit - scanned + 20), cursor })
    for (const key of page.keys || []) {
      if (scanned >= limit) {
        break
      }
      if (!isCardStoreRecordKey(key.name)) {
        continue
      }

      scanned += 1
      const record = await env.CARD_STORE.get(key.name, 'json')
      if (!record?.card?.imageUrl) {
        skipped += 1
        continue
      }

      const result = await ensureCoverThumbForRecord(env, record)
      if (result.ok && result.created) {
        created += 1
      } else if (result.ok && result.skipped) {
        skipped += 1
      } else {
        failed += 1
        if (errors.length < 8) {
          errors.push({ cardId: key.name, reason: result.reason || 'failed' })
        }
      }
    }

    if (page.list_complete) {
      cursor = undefined
      break
    }
    cursor = page.cursor
    if (!cursor) {
      break
    }
  }

  return jsonResponse(request, env, {
    ok: true,
    scanned,
    created,
    skipped,
    failed,
    cursor: cursor || null,
    done: !cursor,
    storage: env.CARD_ASSETS ? 'r2' : 'kv',
    errors,
  })
}

const handleGetAccount = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number before sending.' }, 401)
  }

  await ensureAccountUser(env, { userId: session.userId, phoneE164: session.phoneE164 })
  const account = await getAccountForSession(env, session.userId)
  return jsonResponse(request, env, {
    ok: true,
    phoneE164: session.phoneE164,
    email: account?.email || '',
    preferredName: account?.preferredName || '',
    mailingAddress: account?.mailingAddress || null,
    creditBalance: account?.creditBalance ?? null,
  })
}

const handleUpdateAccountProfile = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number before updating your account.' }, 401)
  }

  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
  }

  try {
    const body = (await readJson(request)) || {}
    const email = typeof body.email === 'string' ? body.email : undefined
    const preferredName = typeof body.preferredName === 'string' ? body.preferredName : undefined
    const mailingAddress =
      body.mailingAddress === null
        ? null
        : body.mailingAddress && typeof body.mailingAddress === 'object'
          ? body.mailingAddress
          : undefined

    const account = await updateAccountProfile(env, {
      userId: session.userId,
      email,
      preferredName,
      mailingAddress,
    })

    if (!account) {
      return jsonResponse(request, env, { error: 'Unable to update your account.' }, 500)
    }

    return jsonResponse(request, env, {
      ok: true,
      email: account.email || '',
      preferredName: account.preferredName || '',
      mailingAddress: account.mailingAddress || null,
      account,
    })
  } catch (error) {
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to update your account.' },
      400,
    )
  }
}

const isAdminRequest = async (request, env) => {
  const secret = String(env.ADMIN_SECRET || '').trim()
  const token = readAccountToken(request)
  if (secret && token && token === secret) {
    return true
  }

  const url = new URL(request.url)
  const querySecret = url.searchParams.get('secret')
  if (secret && querySecret && querySecret === secret) {
    return true
  }

  const session = await getAccountSession(env, token)
  return Boolean(session?.phoneE164 && isAdminPhone(session.phoneE164))
}

const handleGetAdminMetrics = async (request, env) => {
  if (!(await isAdminRequest(request, env))) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }

  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
  }

  const url = new URL(request.url)
  const period = url.searchParams.get('period') || url.searchParams.get('range') || '7d'
  const metrics = await getAdminMetrics(env, { period })
  if (!metrics) {
    return jsonResponse(request, env, { error: 'Unable to load admin metrics.' }, 500)
  }

  return jsonResponse(request, env, { ok: true, ...metrics })
}

const handleListAdminTestimonials = async (request, env) => {
  if (!(await isAdminRequest(request, env))) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }

  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
  }

  const url = new URL(request.url)
  const status = url.searchParams.get('status') || 'pending'
  const testimonials = await listTestimonials(env, { status, limit: 50 })
  return jsonResponse(request, env, { ok: true, status, testimonials })
}

const handleUpdateAdminTestimonial = async (request, env, testimonialId) => {
  if (!(await isAdminRequest(request, env))) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }

  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
  }

  const body = (await readJson(request)) || {}
  const status = String(body.status || '').trim()
  const updated = await updateTestimonialStatus(env, { id: testimonialId, status })
  if (!updated) {
    return jsonResponse(request, env, { error: 'Unable to update that review.' }, 400)
  }

  return jsonResponse(request, env, { ok: true, ...updated })
}

const handleAdminGrantCredits = async (request, env) => {
  if (!(await isAdminRequest(request, env))) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }

  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
  }

  const session = await getAccountSession(env, readAccountToken(request))
  const body = (await readJson(request)) || {}
  const rawPhone = String(body.phone || body.phoneE164 || '').trim()
  const amount = Math.floor(Number(body.credits ?? body.add))

  if (!rawPhone) {
    return jsonResponse(request, env, { error: 'Enter the account cellphone number.' }, 400)
  }

  let phoneE164 = ''
  try {
    phoneE164 = normalizePhoneNumber(rawPhone)
  } catch (error) {
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Enter a valid cellphone number.' },
      400,
    )
  }

  if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
    return jsonResponse(request, env, { error: 'Enter a credit amount between 1 and 500.' }, 400)
  }

  const user = await findUserByPhone(env, phoneE164)
  if (!user) {
    return jsonResponse(
      request,
      env,
      { error: 'No Card Genie account found for that number. They need to confirm their phone first.' },
      404,
    )
  }

  const nextBalance = await applyCreditChange(env, {
    userId: user.id,
    phoneE164,
    delta: amount,
    reason: 'admin_grant',
    kind: 'grant',
    note: session?.phoneE164 ? `Admin grant by ${session.phoneE164}` : 'Admin grant',
  })

  if (nextBalance === null) {
    return jsonResponse(request, env, { error: 'Unable to grant credits for that account.' }, 500)
  }

  return jsonResponse(request, env, {
    ok: true,
    phoneE164,
    creditsAdded: amount,
    creditBalance: nextBalance,
    previousBalance: Math.max(0, nextBalance - amount),
    message: `Added ${amount} credits. New balance: ${nextBalance}.`,
  })
}

const feedbackCommentMaxLength = 280
const feedbackNameMaxLength = 80
const feedbackSources = new Set(['post_send', 'account'])

const handleCreateTestimonial = async (request, env) => {
  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Feedback storage is not available right now.' }, 503)
  }

  try {
    const body = (await readJson(request)) || {}
    const name = String(body.name || '')
      .trim()
      .slice(0, feedbackNameMaxLength)
    const comment = String(body.comment || '').trim()
    const source = String(body.source || '').trim()
    const rawRating = body.rating
    let rating = null

    if (rawRating !== undefined && rawRating !== null && rawRating !== '') {
      const parsed = Number(rawRating)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        return jsonResponse(request, env, { error: 'Choose a rating from 1 to 5 stars, or leave it blank.' }, 400)
      }
      rating = parsed
    }

    if (!comment) {
      return jsonResponse(request, env, { error: 'Write a short review before sending.' }, 400)
    }

    if (comment.length > feedbackCommentMaxLength) {
      return jsonResponse(
        request,
        env,
        { error: `Keep your review under ${feedbackCommentMaxLength} characters.` },
        400,
      )
    }

    if (!feedbackSources.has(source)) {
      return jsonResponse(request, env, { error: 'Unable to save that review.' }, 400)
    }

    const session = await getAccountSession(env, readAccountToken(request))
    const saved = await createTestimonial(env, {
      name: name || null,
      rating,
      comment,
      source,
      userId: session?.userId || null,
      phoneE164: session?.phoneE164 || null,
    })

    if (!saved) {
      return jsonResponse(request, env, { error: 'Unable to save your review right now.' }, 500)
    }

    return jsonResponse(request, env, {
      ok: true,
      id: saved.id,
      message: 'Thanks for your review — that means a lot.',
    })
  } catch (error) {
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to save your review right now.' },
      400,
    )
  }
}

const MAX_DELIVERY_RECIPIENTS = 10

const collectDeliveryDestinations = ({ destination, destinations }) => {
  if (Array.isArray(destinations)) {
    return destinations.map((entry) => String(entry || '').trim()).filter(Boolean)
  }

  const single = typeof destination === 'string' ? destination.trim() : ''
  return single ? [single] : []
}

const handleDeliverCard = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(
      request,
      env,
      { error: 'Confirm your mobile number before sending. We’ll text you a one-time code.' },
      401,
    )
  }

  const {
    cardId,
    method,
    destination,
    destinations,
    recipientConsentConfirmed,
    senderCopyEmail: rawSenderCopyEmail,
  } = (await readJson(request)) || {}
  const record = await getCardRecord(env, cardId)
  const destinationList = collectDeliveryDestinations({ destination, destinations })
  const senderCopyEmail = rawSenderCopyEmail?.trim()

  if (!record) {
    return jsonResponse(request, env, { error: 'Save the card before delivering it.' }, 404)
  }

  if (!['email', 'text'].includes(method)) {
    return jsonResponse(request, env, { error: 'Choose email or text delivery.' }, 400)
  }

  if (!destinationList.length) {
    return jsonResponse(
      request,
      env,
      { error: method === 'email' ? 'Enter the recipient email address.' : 'Enter the recipient cellphone number.' },
      400,
    )
  }

  if (destinationList.length > MAX_DELIVERY_RECIPIENTS) {
    return jsonResponse(
      request,
      env,
      { error: `You can send to up to ${MAX_DELIVERY_RECIPIENTS} recipients at a time.` },
      400,
    )
  }

  if (method === 'text' && recipientConsentConfirmed !== true) {
    return jsonResponse(
      request,
      env,
      {
        error:
          destinationList.length > 1
            ? 'Confirm each recipient agreed to receive this one-time card delivery text.'
            : 'Confirm the recipient agreed to receive this one-time card delivery text.',
      },
      400,
    )
  }

  const shareUrl = getShareUrl(request, env, record.id)
  const coverUrl = getEmailCoverUrl(request, record.id)
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
          ? await sendEmailDelivery({ env, to: normalizedDestination, copy })
          : await sendTextDelivery({ env, to: normalizedDestination, copy })

      let copyForRecord = ''

      if (senderCopyPending && senderCopyEmail) {
        try {
          const senderCopy = buildSenderCopyDeliveryCopy(record, shareUrl, coverUrl)
          senderCopyDeliveredTo = await sendEmailDelivery({
            env,
            to: normalizeEmailAddress(senderCopyEmail),
            copy: senderCopy,
          })
          copyForRecord = senderCopyDeliveredTo || ''
        } catch (copyError) {
          console.error(copyError)
        }
        senderCopyPending = false
      }

      try {
        await recordSuccessfulDelivery(env, {
          userId: session.userId,
          phoneE164: session.phoneE164,
          record,
          method,
          destination: deliveredTo,
          senderCopyEmail: copyForRecord,
        })
      } catch (accountError) {
        console.error(accountError)
      }

      results.push({ destination: deliveredTo, status: 'sent' })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to deliver the card.'
      const isValidationError =
        /email|cellphone|phone|@|period|\.com|digits|incomplete|spaces/i.test(rawMessage) &&
        !/SendGrid|Postmark|Twilio|configured/i.test(rawMessage)
      const publicError = isValidationError ? rawMessage : publicDeliveryError(error, method)

      if (!isValidationError) {
        try {
          await recordFailedDelivery(env, {
            userId: session.userId,
            cardId,
            method,
            destination: normalizedDestination || rawDestination,
            error,
          })
        } catch (accountError) {
          console.error(accountError)
        }
      }

      results.push({
        destination: normalizedDestination || rawDestination,
        status: 'failed',
        error: publicError,
      })
    }
  }

  const sent = results.filter((entry) => entry.status === 'sent')
  const failed = results.filter((entry) => entry.status === 'failed')

  if (!sent.length) {
    return jsonResponse(
      request,
      env,
      {
        error: failed[0]?.error || (method === 'email' ? 'Unable to deliver the card by email.' : 'Unable to deliver the card by text.'),
        results,
        deliveredCount: 0,
        failedCount: failed.length,
      },
      failed.every((entry) =>
        /email|cellphone|phone|@|period|\.com|digits|incomplete|spaces/i.test(entry.error || ''),
      )
        ? 400
        : 500,
    )
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

  return jsonResponse(request, env, {
    ok: true,
    shareUrl,
    deliveredTo: sent[0].destination,
    deliveredCount: sent.length,
    failedCount: failed.length,
    results,
    senderCopyDeliveredTo,
    message,
  })
}

const handleOrderPrintCard = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(
      request,
      env,
      { error: 'Confirm your mobile number before ordering a printed card.' },
      401,
    )
  }

  try {
    const body = (await readJson(request)) || {}
    const {
      cardId,
      mailFrom: rawMailFrom,
      shipTo: rawShipTo,
      shopperEmail: rawShopperEmail,
      coverImage,
      insideImage,
      coverThumbImage,
      insideThumbImage,
    } = body
    const record = await getCardRecord(env, cardId)

    if (!record) {
      return jsonResponse(request, env, { error: 'Save the card before ordering a print.' }, 404)
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
    const shareUrl = getShareUrl(request, env, record.id)
    const savedOrder = await createPrintOrder(env, {
      userId: session.userId,
      cardId: record.id,
      mailFrom,
      shipTo,
      shopperEmail,
      creditCost: PRINT_CARD_CREDIT_COST,
    })
    await saveAccountEmail(env, { userId: session.userId, email: shopperEmail })
    if (!isDefaultPrintMailFrom(mailFrom)) {
      await saveAccountMailingAddress(env, { userId: session.userId, mailingAddress: mailFrom })
    }
    const orderCode = savedOrder?.orderCode || String(savedOrder?.orderNumber || '')
    if (!orderCode) {
      return jsonResponse(request, env, { error: 'Unable to allocate a print order number.' }, 500)
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

    let supportEmailError = ''
    try {
      await sendEmailDelivery({
        env,
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
      })
    } catch (emailError) {
      supportEmailError = emailError instanceof Error ? emailError.message : 'Unable to email support.'
      console.error('Print order saved but support email failed.', emailError)
    }

    try {
      const confirmationCopy = buildPrintOrderConfirmationCopy({
        orderCode,
        shipTo,
        mailFrom,
      })
      await sendEmailDelivery({
        env,
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

    try {
      await appendCoverRevision(env, {
        cardId: record.id,
        imageUrl: coverImage,
        source: 'print',
        orderNumber: orderCode,
        details: record.details || null,
      })
    } catch (revisionError) {
      console.error('Unable to save print-order cover revision.', revisionError)
    }

    return jsonResponse(request, env, {
      ok: true,
      orderCode,
      orderNumber: savedOrder.orderNumber,
      creditCost: PRINT_CARD_CREDIT_COST,
      shopperEmail,
      mailedTo: PRINT_ORDER_SUPPORT_EMAIL,
      supportEmailError: supportEmailError || undefined,
      message: supportEmailError
        ? `Print order ${orderCode} was placed. We had trouble notifying support — contact support@card-genie.com with your order number.`
        : `Print order ${orderCode} sent. We'll mail the card shortly.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to place the print order.'
    const isValidation =
      /enter|choose|provide|valid|united states|zip|state|street|name|city|image|email|@/i.test(message) &&
      !/SendGrid|Postmark|configured/i.test(message)

    return jsonResponse(request, env, { error: message }, isValidation ? 400 : 500)
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

  const { details, refinement, imageMode, currentImageUrl, cardId, referenceImages: rawReferenceImages } =
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
        : await editImage(
            openai,
            env,
            details,
            refinement,
            currentImageUrl,
            referenceImages,
            likenessBrief,
            typeof cardId === 'string' ? cardId.trim() : '',
          )

    const revisionSource = imageMode === 'new' ? 'new' : 'revise'
    let responseCardId = typeof cardId === 'string' ? cardId.trim() : ''
    let revisionId = ''

    if (responseCardId) {
      const updated = await updateCardCoverImage(env, responseCardId, imageUrl, {
        revisionSource,
        refinement: String(refinement || '').trim(),
        details,
      })
      if (updated) {
        const revisions = await listCoverRevisions(env, responseCardId)
        revisionId = revisions[0]?.id || ''
      } else {
        responseCardId = ''
      }
    }

    if (!responseCardId) {
      // Keep a recoverable 7-day snapshot even when there is no shared card yet.
      const snapshotCardId = createCardId()
      const entry = await appendCoverRevision(env, {
        cardId: snapshotCardId,
        imageUrl,
        source: revisionSource,
        refinement: String(refinement || '').trim(),
        details,
      })
      revisionId = entry?.id || ''
      return jsonResponse(request, env, {
        imageUrl,
        revisionId: revisionId || undefined,
        revisionCardId: snapshotCardId,
      })
    }

    return jsonResponse(request, env, {
      imageUrl,
      cardId: responseCardId,
      revisionId: revisionId || undefined,
    })
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

const CARD_INTERVIEW_TONES = ['Heartfelt', 'Playful', 'Elegant', 'Funny', 'Romantic', 'Encouraging', 'Business']
const CARD_INTERVIEW_MAX_USER_TURNS_QUICK = 3
const CARD_INTERVIEW_MAX_USER_TURNS_CHAT = 6
const CARD_INTERVIEW_FORCE_READY_TURNS_QUICK = 2
const CARD_INTERVIEW_FORCE_READY_TURNS_CHAT = 5
const CARD_INTERVIEW_IMAGE_STYLES = [
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
const AMBIGUOUS_RECIPIENT_TOKENS = new Set([
  'him',
  'her',
  'them',
  'he',
  'she',
  'they',
  'his',
  'hers',
  'himself',
  'herself',
  'someone',
  'somebody',
  'guy',
  'girl',
  'dude',
  'person',
])

const cardInterviewSystemPromptQuick = `You help shoppers fill out a greeting-card form for Card Genie.
They often speak into the mic, so the text may include speech-to-text mistakes. Collect the form in batches — never drip one field at a time when several are still unknown.

Return ONLY valid JSON with this shape:
{
  "assistantMessage": "friendly reply shown to the shopper",
  "status": "ask" or "ready",
  "details": {
    "recipientName": "",
    "recipientType": "",
    "senderName": "",
    "occasion": "",
    "tone": "Heartfelt",
    "imageStyle": "",
    "keyDetails": ""
  }
}

Essentials for status "ready": senderName, a clear recipientName, occasion, and useful keyDetails.
Rules:
- Extract every field you can from each reply into details.
- If essentials are complete, return status "ready". Do not ask optional enriching questions.
- If anything essential is still missing, return status "ask" with ONE short question that asks for ALL remaining gaps together (not one field per turn). When you already know the recipient’s name, personalize the ask (example: "Thanks. Do you have details, characteristics, or interests you can share about David, or any memories?"). Avoid generic phrasing like "a memory or detail to include" when a name is known.
- Only ask a single-topic question when the issue is unclear names (speech-to-text), e.g. "him and Anita". Prefer: "I want to make sure I have the names right — who is the card for?"
- Infer occasion from phrases like "thank you card", "thanks", "birthday card", "anniversary", "congratulations". Do NOT ask for occasion when it is already clear. Example: "send a thank you card" means occasion "Thank You".
- Treat pronouns or vague words as UNCLEAR recipient names, not real names: him, her, them, he, she, they, someone, guy, etc. Never put "him", "her", or "them" into recipientName.
- If the shopper says "me", "myself", or "me and …" for who the card is from, and a shopper first name is provided in the request notes, expand "me"/"myself" to that first name (example: me and Mindy → Nasser and Mindy).
- Never ask whether anyone else should be included, or for tone, style, or relation, when essentials are already known.
- If the shopper mentions an image/art style (example: "comic version", "watercolor", "photorealistic"), set imageStyle to the closest exact option from: ${CARD_INTERVIEW_IMAGE_STYLES.filter((style) => style !== 'AI chooses the best style for this card').join('; ')}. Do not leave style preferences only inside keyDetails. Never ask for style.
- If relation is unclear, guess (friends, couple, family, coworkers) in recipientType rather than asking.
- tone must be one of: ${CARD_INTERVIEW_TONES.join(', ')}.
- keyDetails should be a concise single-paragraph summary of memories/scene ideas. Do not write the finished inside note.
- assistantMessage is your short chat reply (acknowledgment + one question, or “I filled the form”). Never put the card message body there.
- Never invent trademarks, celebrity likenesses, or private facts they did not share.
- Keep assistantMessage warm and brief (1-3 sentences).
- When status is "ready", say you filled the form and they can edit before creating the card.
- Fill details as far as you can even when status is "ask".
- Output compact JSON. Escape any newlines inside strings.`

const cardInterviewSystemPromptChat = `You are Genie, a warm conversational guide helping shoppers create a greeting card for Card Genie.
They often speak into the mic. Collect the form in batches — never drip one field at a time when several are still unknown.

Return ONLY valid JSON with this shape:
{
  "assistantMessage": "friendly reply shown to the shopper",
  "status": "ask" or "ready",
  "details": {
    "recipientName": "",
    "recipientType": "",
    "senderName": "",
    "occasion": "",
    "tone": "Heartfelt",
    "imageStyle": "",
    "keyDetails": ""
  }
}

Essentials for status "ready": senderName, a clear recipientName, occasion, and useful keyDetails.
Conversation style:
- The opening already asked for everything. On each shopper reply, extract every field you can into details.
- If essentials are complete, return status "ready". Do not ask optional enriching questions.
- If anything essential is still missing, return status "ask" with ONE short question that asks for ALL remaining gaps together (not one field per turn). When you already know the recipient’s name, personalize the ask (example: "Thanks. Do you have details, characteristics, or interests you can share about David, or any memories?"). Avoid generic phrasing like "a memory or detail to include" when a name is known.
- Only ask a single-topic question when the issue is unclear names (speech-to-text), e.g. "him and Anita".
- Infer occasion from phrases like "thank you card", "thanks", "birthday card". Do NOT re-ask occasion when clear.
- Treat pronouns (him, her, them, he, she, they) as unclear names — ask who they mean. Never store "him"/"her" as recipientName.
- If the shopper says "me", "myself", or "me and …" for who the card is from, and a shopper first name is provided in the request notes, expand "me"/"myself" to that first name (example: me and Mindy → Nasser and Mindy).
- Do not ask about art style, tone, or relation. Guess recipientType when unclear.
- If the shopper mentions an image/art style (example: "comic version", "watercolor"), set imageStyle to the closest exact option from: ${CARD_INTERVIEW_IMAGE_STYLES.filter((style) => style !== 'AI chooses the best style for this card').join('; ')}. Do not leave style preferences only inside keyDetails.
- tone must be one of: ${CARD_INTERVIEW_TONES.join(', ')}.
- keyDetails is a concise paragraph of memories/scene ideas, not the finished inside note.
- assistantMessage is the chat reply only (1-3 sentences). Never put the card message body there.
- Fill details as far as you can even when status is "ask".
- When status is "ready", say you filled the form and they can edit before creating the card.
- Output compact JSON. Escape any newlines inside strings.`

const cardInterviewSystemPrompt = cardInterviewSystemPromptQuick

const inferInterviewImageStyleFromText = (text) => {
  const value = String(text || '').toLowerCase()
  if (!value) {
    return ''
  }
  if (/\bcomic(\s*book)?(\s*(art|style|version|look|cover))?\b|\bcomics\b/.test(value)) {
    return 'Comic book art'
  }
  if (/\bwater[\s-]?color\b|\bwatercolor\b/.test(value)) {
    return 'Watercolor greeting card illustration'
  }
  if (/\bphoto[\s-]?real|\bphotoreal|\brealistic\s+(?:photo|portrait)|\bphotograph/.test(value)) {
    return 'Photorealistic warm portrait photography'
  }
  if (/\bstory[\s-]?book\b|\bstorybook\b/.test(value)) {
    return 'Whimsical storybook illustration'
  }
  if (/\bpaper[\s-]?cut\b|\bbotanical\b/.test(value)) {
    return 'Elegant botanical paper-cut style'
  }
  if (/\bpencil\b|\bhand[\s-]?drawn\b/.test(value)) {
    return 'Cozy hand-drawn colored pencil'
  }
  if (/\bvector\b|\bflat\s+art\b|\bminimal(?:ist)?\b/.test(value)) {
    return 'Minimal modern flat vector art'
  }
  if (/\b3d\b|\banimat(?:ed|ion)\b|\bpixar\b|\bfamily[\s-]?film\b/.test(value)) {
    return 'Animated 3D family-film style'
  }
  if (/\beditorial\b|\bmagazine\b/.test(value)) {
    return 'Premium editorial illustration'
  }
  if (/\btravel\s+poster\b|\bretro\s+poster\b/.test(value)) {
    return 'Retro travel poster style'
  }
  if (/\bclay(?:mation)?\b/.test(value)) {
    return 'Claymation-inspired 3D scene'
  }
  if (/\bcollage\b|\bfoil\b/.test(value)) {
    return 'Luxury foil and paper collage'
  }
  if (/\bnursery\b|\bpastel\b/.test(value)) {
    return 'Soft pastel nursery-book illustration'
  }
  if (/\bgraphic\s+poster\b|\bbold\s+graphic\b/.test(value)) {
    return 'Bold graphic poster art'
  }
  if (/\bvintage\b/.test(value)) {
    return 'Vintage greeting card illustration'
  }
  for (const style of CARD_INTERVIEW_IMAGE_STYLES) {
    if (style === 'AI chooses the best style for this card') {
      continue
    }
    if (value.includes(style.toLowerCase())) {
      return style
    }
  }
  return ''
}

const normalizeInterviewImageStyle = (raw) => {
  const value = String(raw || '').trim()
  if (!value) {
    return ''
  }
  const exact = CARD_INTERVIEW_IMAGE_STYLES.find(
    (style) => style.toLowerCase() === value.toLowerCase(),
  )
  if (exact) {
    return exact
  }
  return inferInterviewImageStyleFromText(value)
}

const normalizeInterviewDetails = (raw = {}) => {
  const toneRaw = String(raw.tone || 'Heartfelt').trim()
  const tone =
    CARD_INTERVIEW_TONES.find((option) => option.toLowerCase() === toneRaw.toLowerCase()) || 'Heartfelt'
  const imageStyle = normalizeInterviewImageStyle(raw.imageStyle)

  return {
    recipientName: String(raw.recipientName || '').trim(),
    recipientType: String(raw.recipientType || '').trim(),
    senderName: String(raw.senderName || '').trim(),
    occasion: String(raw.occasion || '').trim(),
    tone,
    imageStyle,
    keyDetails: String(raw.keyDetails || '').trim(),
  }
}

const interviewRecipientNameLooksAmbiguous = (name) => {
  const parts = String(name || '')
    .split(/[\s,&/]+/)
    .map((part) => part.toLowerCase().replace(/[^a-z'-]/g, ''))
    .filter(Boolean)
  if (parts.length === 0) {
    return false
  }
  return parts.some((part) => AMBIGUOUS_RECIPIENT_TOKENS.has(part))
}

const inferInterviewOccasionFromText = (text) => {
  const value = String(text || '').toLowerCase()
  if (/\bthank[\s-]?you\b|\bthanks\b/.test(value)) {
    return 'Thank You'
  }
  if (/\bbirthday\b|\bb\-?day\b/.test(value)) {
    return 'Birthday'
  }
  if (/\banniversary\b/.test(value)) {
    return 'Anniversary'
  }
  if (/\bcongratulat|\bcongrats\b/.test(value)) {
    return 'Congratulations'
  }
  if (/\bget[\s-]?well\b/.test(value)) {
    return 'Get Well'
  }
  if (/\bsympathy\b|\bcondolence/.test(value)) {
    return 'Sympathy'
  }
  if (/\bvalentine/.test(value)) {
    return 'Valentine'
  }
  if (/\bwedding\b/.test(value)) {
    return 'Wedding'
  }
  if (/\bbaby\b|\bnewborn\b|\bshower\b/.test(value)) {
    return 'New Baby'
  }
  return ''
}

const scrubAmbiguousRecipientName = (name) => {
  const kept = String(name || '')
    .split(/([\s,&/]+)/)
    .map((part) => {
      const cleaned = part.toLowerCase().replace(/[^a-z'-]/g, '')
      if (AMBIGUOUS_RECIPIENT_TOKENS.has(cleaned)) {
        return ''
      }
      return part
    })
    .join('')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*and\s+|\s+and\s*$/gi, '')
    .replace(/^[\s,&/]+|[\s,&/]+$/g, '')
    .trim()
  return kept
}

const transcriptHasAmbiguousRecipientCue = (text) => {
  const value = String(text || '')
  // "him and Anita" / "her and Bob" — not "visiting them and want to thank them"
  if (/\b(?:him|her|he|she)\s+and\s+[A-Za-z][\w'-]+\b/i.test(value)) {
    return true
  }
  if (/\b(?:to|for)\s+(?:him|her|them)\b/i.test(value)) {
    return true
  }
  if (/\b(?:to|for)\s+(?:him|her|them)\s+and\s+[A-Za-z][\w'-]+\b/i.test(value)) {
    return true
  }
  return false
}

const latestShopperUtterance = (transcript) => {
  const lines = String(transcript || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (/^Shopper:\s*/i.test(line)) {
      return line.replace(/^Shopper:\s*/i, '').trim()
    }
  }
  return String(transcript || '')
}

/** Only shopper lines — never Genie prompts like “fill in the form from what you say”. */
const shopperOnlyTranscriptText = (transcript) => {
  const lines = String(transcript || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const shopperLines = lines
    .filter((line) => /^Shopper:\s*/i.test(line))
    .map((line) => line.replace(/^Shopper:\s*/i, '').trim())
    .filter(Boolean)
  if (shopperLines.length > 0) {
    return shopperLines.join('\n')
  }
  // Bare user text with no role prefixes (quick single-turn payloads).
  if (!/^Genie:/im.test(String(transcript || ''))) {
    return String(transcript || '').trim()
  }
  return ''
}

const normalizeInterviewOccasionLabel = (occasion) => {
  const raw = String(occasion || '').trim()
  if (!raw) {
    return ''
  }
  const inferred = inferInterviewOccasionFromText(raw)
  return inferred || raw
}

const resolveShopperSelfInSenderName = (senderName, shopperFirstName) => {
  const self = String(shopperFirstName || '').trim()
  const raw = String(senderName || '').trim()
  if (!self || !raw) {
    return raw
  }
  return raw
    .replace(/\b(me|myself)\b/gi, self)
    .replace(/\s+/g, ' ')
    .trim()
}

const senderNameStillHasSelfReference = (senderName) =>
  /\b(me|myself)\b/i.test(String(senderName || ''))

const senderNameLooksInvalid = (senderName) => {
  const value = String(senderName || '').trim()
  if (!value) {
    return true
  }
  if (
    /^(what you say|what you said|the form|who it'?s from|who it is from|anyone|someone|you say|details|memories)$/i.test(
      value,
    )
  ) {
    return true
  }
  if (/\b(what you say|fill (?:in|out) the form|tell me about)\b/i.test(value)) {
    return true
  }
  // Reject bare filler words that are not names.
  if (/^(what|who|you|the|a|an|from|form|card)$/i.test(value)) {
    return true
  }
  return false
}

const inferSenderNameFromTranscript = (transcript, shopperFirstName) => {
  const text = shopperOnlyTranscriptText(transcript)
  if (!text) {
    return ''
  }
  // Capture at most one "and …" name pair so we don't swallow "and Joey loves to…".
  const patterns = [
    /\b(?:(?:the\s+)?card\s+is\s+)?from\s+((?:me|myself|[A-Za-z][\w'-]+)(?:\s+and\s+(?:me|myself|[A-Za-z][\w'-]+))?)\b/i,
    /\b(?:it's|its)\s+from\s+((?:me|myself|[A-Za-z][\w'-]+)(?:\s+and\s+(?:me|myself|[A-Za-z][\w'-]+))?)\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const candidate = resolveShopperSelfInSenderName(match[1].trim(), shopperFirstName)
      if (candidate && !senderNameStillHasSelfReference(candidate) && !senderNameLooksInvalid(candidate)) {
        return candidate.replace(/\s+/g, ' ').trim()
      }
    }
  }
  // "me and Mindy" / "Mindy and me" without an explicit "from"
  const andMe = text.match(/\b((?:me|myself)\s+and\s+[A-Za-z][\w'-]+|[A-Za-z][\w'-]+\s+and\s+(?:me|myself))\b/i)
  if (andMe?.[1]) {
    const candidate = resolveShopperSelfInSenderName(andMe[1], shopperFirstName)
    if (candidate && !senderNameLooksInvalid(candidate)) {
      return candidate
    }
  }
  return ''
}

const inferRecipientNameFromTranscript = (transcript) => {
  const text = shopperOnlyTranscriptText(transcript)
  if (!text) {
    return ''
  }
  const patterns = [
    /\b(?:send\s+(?:a\s+)?)?(?:thank\s*you\s+)?(?:card\s+)(?:to|for)\s+(?!a\b|an\b|the\b|my\b|our\b|his\b|her\b|their\b|him\b|them\b)([A-Za-z][\w'-]+(?:\s+and\s+[A-Za-z][\w'-]+)?)\b/i,
    /\b(?:birthday|anniversary|thank(?:\s*you)?|congrats|congratulations)?\s*card\s+(?:to|for)\s+(?!a\b|an\b|the\b|my\b|our\b)([A-Za-z][\w'-]+(?:\s+and\s+[A-Za-z][\w'-]+)?)\b/i,
    /\b(?:to|for)\s+(?!a\b|an\b|the\b|my\b|our\b)([A-Za-z][\w'-]+(?:\s+and\s+[A-Za-z][\w'-]+)?)\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const candidate = String(match?.[1] || '').replace(/\s+/g, ' ').trim()
    if (!candidate || interviewRecipientNameLooksAmbiguous(candidate)) {
      continue
    }
    if (recipientNameLooksInvalid(candidate)) {
      continue
    }
    return candidate
  }
  return ''
}

const recipientNameLooksInvalid = (recipientName) => {
  const value = String(recipientName || '').trim()
  if (!value) {
    return true
  }
  if (
    /^(create|make|send|get|buy|order|want|like|need|have|do|be|birthday|anniversary|thanks|thank|fun|dinner|night|party|weekend|card|form)$/i.test(
      value,
    )
  ) {
    return true
  }
  return false
}

const buildChatMissingPrompt = (details, ambiguousRecipient) => {
  if (ambiguousRecipient) {
    return 'I want to make sure I have the names right — who is the card for? (I may have misheard one of them.)'
  }

  const recipient = String(details.recipientName || '').trim()
  const sender = String(details.senderName || '').trim()
  const occasion = String(details.occasion || '').trim()
  const hasDetails = Boolean(String(details.keyDetails || '').trim())

  const missing = []
  if (!recipient) {
    missing.push('for')
  }
  if (!sender) {
    missing.push('from')
  }
  if (!occasion) {
    missing.push('occasion')
  }
  if (!hasDetails) {
    missing.push('details')
  }
  if (missing.length === 0) {
    return ''
  }

  if (missing.length === 1) {
    if (missing[0] === 'details' && recipient) {
      return `Thanks. Do you have details, characteristics, or interests you can share about ${recipient}, or any memories?`
    }
    if (missing[0] === 'details') {
      return 'Thanks. Do you have details, characteristics, interests, or any memories to include?'
    }
    if (missing[0] === 'from' && recipient) {
      return `Thanks — who should the card to ${recipient} be from?`
    }
    if (missing[0] === 'from') {
      return 'Thanks — who is the card from?'
    }
    if (missing[0] === 'occasion' && recipient) {
      return `Thanks — what’s the occasion for ${recipient}’s card?`
    }
    if (missing[0] === 'occasion') {
      return 'Thanks — what’s the occasion?'
    }
    return 'Thanks — who is the card for?'
  }

  const parts = []
  if (!recipient) {
    parts.push('who it’s for')
  }
  if (!sender) {
    parts.push('who it’s from')
  }
  if (!occasion) {
    parts.push('the occasion')
  }
  if (!hasDetails) {
    parts.push(
      recipient
        ? `details, interests, or a memory about ${recipient}`
        : 'details, interests, or a memory to include',
    )
  }

  if (parts.length === 2) {
    return `Thanks — I still need ${parts[0]} and ${parts[1]}.`
  }
  const last = parts[parts.length - 1]
  return `Thanks — I still need ${parts.slice(0, -1).join(', ')}, and ${last}.`
}

const refineInterviewResult = ({
  details,
  status,
  assistantMessage,
  transcript,
  shouldForceReady,
  mode,
  shopperFirstName,
}) => {
  const next = { ...details }
  const fullTranscript = String(transcript || '')
  const shopperText = shopperOnlyTranscriptText(fullTranscript)
  const latestShopperText = latestShopperUtterance(fullTranscript)
  const selfName = String(shopperFirstName || '').trim()

  if (!next.occasion) {
    next.occasion = inferInterviewOccasionFromText(shopperText || fullTranscript)
  }
  next.occasion = normalizeInterviewOccasionLabel(next.occasion)

  next.imageStyle = normalizeInterviewImageStyle(next.imageStyle)
  if (!next.imageStyle) {
    next.imageStyle = inferInterviewImageStyleFromText(shopperText || fullTranscript)
  }

  next.senderName = resolveShopperSelfInSenderName(next.senderName, selfName)
  if (senderNameLooksInvalid(next.senderName)) {
    next.senderName = ''
  }
  if (!next.senderName || senderNameStillHasSelfReference(next.senderName)) {
    const inferredSender = inferSenderNameFromTranscript(fullTranscript, selfName)
    if (inferredSender) {
      next.senderName = inferredSender
    }
  }
  if (senderNameStillHasSelfReference(next.senderName) || senderNameLooksInvalid(next.senderName)) {
    // Still unresolved (no account first name) — don't keep "me" / junk as the From value.
    next.senderName = ''
  }

  if (recipientNameLooksInvalid(next.recipientName)) {
    next.recipientName = ''
  }
  if (!next.recipientName) {
    const inferredRecipient = inferRecipientNameFromTranscript(fullTranscript)
    if (inferredRecipient) {
      next.recipientName = inferredRecipient
    }
  }

  const nameAmbiguous = interviewRecipientNameLooksAmbiguous(next.recipientName)
  if (nameAmbiguous) {
    next.recipientName = scrubAmbiguousRecipientName(next.recipientName)
  }
  // "a nice card for him" is common even when they already named the person.
  // Only force a name clarification when we still lack a clear recipient name.
  const hasClearRecipient =
    Boolean(String(next.recipientName || '').trim()) &&
    !interviewRecipientNameLooksAmbiguous(next.recipientName)
  const ambiguousRecipient =
    !hasClearRecipient &&
    (nameAmbiguous || transcriptHasAmbiguousRecipientCue(latestShopperText))

  let nextStatus = String(status || '').toLowerCase() === 'ready' ? 'ready' : 'ask'
  let nextAssistant = String(assistantMessage || '').trim()
  const essentialsReady = interviewDetailsAreReady(next)

  // Both modes: parse everything said, then ask once for ALL remaining gaps.
  // Only single-topic ask when a pronoun name is unclear (him/her + someone).
  if (!shouldForceReady && (ambiguousRecipient || !essentialsReady)) {
    nextStatus = 'ask'
    const combined = buildChatMissingPrompt(next, ambiguousRecipient)
    if (combined) {
      nextAssistant = combined
    }
  } else if (shouldForceReady) {
    nextStatus = 'ready'
  } else if (essentialsReady) {
    nextStatus = 'ready'
  }

  if (!nextAssistant) {
    nextAssistant =
      nextStatus === 'ready'
        ? 'I filled in the form below. Tweak anything you want, then create your card.'
        : buildChatMissingPrompt(next, ambiguousRecipient) ||
          'Tell me a bit more so I can fill in the form.'
  }

  if (
    nextStatus === 'ready' &&
    (/names right|who is the card for|who should the card be|what.?s the occasion|i still need|confirm (?:the )?recipient|full names|tell me who/i.test(
      nextAssistant,
    ) ||
      /\?/.test(nextAssistant))
  ) {
    nextAssistant = 'I filled in the form below. Tweak anything you want, then create your card.'
  }

  return { details: next, status: nextStatus, assistantMessage: nextAssistant }
}

const interviewDetailsAreReady = (details) =>
  Boolean(
    details.senderName &&
      details.recipientName &&
      !interviewRecipientNameLooksAmbiguous(details.recipientName) &&
      details.occasion &&
      details.keyDetails,
  )

const getInterviewResponseText = (response) => {
  const direct = String(response?.output_text || '').trim()
  if (direct) {
    return direct
  }

  const chunks = []
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string' && content.text.trim()) {
        chunks.push(content.text.trim())
      } else if (typeof content?.output_text === 'string' && content.output_text.trim()) {
        chunks.push(content.output_text.trim())
      }
    }
  }
  return chunks.join('\n').trim()
}

const parseInterviewModelJson = (text) => {
  let trimmed = String(text || '').trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  }

  const tryParse = (value) => {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  const direct = tryParse(trimmed)
  if (direct) {
    return direct
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1)
    const parsed = tryParse(sliced)
    if (parsed) {
      return parsed
    }

    // Repair common model mistakes: raw newlines inside JSON strings.
    const repaired = sliced.replace(/[\u0000-\u001f]+/g, (char) => {
      if (char === '\n') return '\\n'
      if (char === '\r') return '\\r'
      if (char === '\t') return '\\t'
      return ' '
    })
    return tryParse(repaired)
  }

  return null
}

const handleCardInterview = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const body = (await readJson(request)) || {}
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const forceReady = Boolean(body.forceReady)
  const mode = String(body.mode || '').toLowerCase() === 'chat' ? 'chat' : 'quick'
  const messages = rawMessages
    .map((entry) => ({
      role: entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : '',
      content: String(entry?.content || '').trim(),
    }))
    .filter((entry) => entry.role && entry.content)
    .slice(-12)

  const userMessages = messages.filter((entry) => entry.role === 'user')
  const userTurns = userMessages.length
  if (userTurns < 1) {
    return jsonResponse(request, env, { error: 'Tell me about the card you want to create.' }, 400)
  }

  const maxUserTurns =
    mode === 'chat' ? CARD_INTERVIEW_MAX_USER_TURNS_CHAT : CARD_INTERVIEW_MAX_USER_TURNS_QUICK
  const forceReadyTurns =
    mode === 'chat' ? CARD_INTERVIEW_FORCE_READY_TURNS_CHAT : CARD_INTERVIEW_FORCE_READY_TURNS_QUICK

  if (userTurns > maxUserTurns + 2) {
    return jsonResponse(request, env, { error: 'Let’s finish this in the form below.' }, 400)
  }

  const shouldForceReady = forceReady || userTurns >= forceReadyTurns
  const shopperFirstName = String(body.shopperFirstName || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60)
  const systemPrompt = mode === 'chat' ? cardInterviewSystemPromptChat : cardInterviewSystemPromptQuick
  const transcript = messages
    .map((entry) => `${entry.role === 'assistant' ? 'Genie' : 'Shopper'}: ${entry.content}`)
    .join('\n')
  const shopperNameNote = shopperFirstName
    ? `\nShopper first name on their account: "${shopperFirstName}". When they say the card is from "me" or "me and …", use this first name for "me"/"myself".`
    : ''

  try {
    const openai = getOpenAI(env)
    const response = await openai.responses.create({
      model: env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      text: { format: { type: 'json_object' } },
      input: [
        {
          role: 'system',
          content: `${systemPrompt}${shopperNameNote}${
            shouldForceReady
              ? '\nThe shopper has answered enough. You MUST return status "ready" with your best-filled details now.'
              : ''
          }`,
        },
        {
          role: 'user',
          content: `Conversation so far:\n${transcript}\n\nReturn the next JSON result now.`,
        },
      ],
    })

    const rawText = getInterviewResponseText(response)
    const parsed = parseInterviewModelJson(rawText)
    if (!parsed || typeof parsed !== 'object') {
      return jsonResponse(
        request,
        env,
        { error: 'I had trouble understanding that. Try one more short sentence.' },
        502,
      )
    }

    const details = normalizeInterviewDetails(parsed.details || {})
    const modelStatus = String(parsed.status || '').toLowerCase() === 'ready' ? 'ready' : 'ask'
    const refined = refineInterviewResult({
      details,
      status:
        mode === 'chat'
          ? modelStatus
          : modelStatus === 'ready' || interviewDetailsAreReady(details)
            ? 'ready'
            : 'ask',
      assistantMessage: String(parsed.assistantMessage || '').trim(),
      transcript,
      shouldForceReady,
      mode,
      shopperFirstName,
    })

    return jsonResponse(request, env, {
      ok: true,
      status: refined.status,
      assistantMessage: refined.assistantMessage,
      details:
        refined.status === 'ready' || Object.values(refined.details).some(Boolean)
          ? refined.details
          : undefined,
    })
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: publicGenerationError(error, 'Unable to continue that conversation. Please try again.') },
      isSafetyRejection(error) ? 400 : 500,
    )
  }
}

const handleCardInterviewSpeak = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const body = (await readJson(request)) || {}
  const text = String(body.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)

  if (!text) {
    return jsonResponse(request, env, { error: 'Nothing to say.' }, 400)
  }

  const allowedVoices = new Set([
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
    'verse',
  ])
  const tts1FallbackByVoice = {
    ash: 'alloy',
    ballad: 'fable',
    coral: 'nova',
    sage: 'shimmer',
    verse: 'nova',
  }

  try {
    const openai = getOpenAI(env)
    const model = env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'
    const requestedVoice = String(body.voice || env.OPENAI_TTS_VOICE || 'echo')
      .trim()
      .toLowerCase()
    const voice = allowedVoices.has(requestedVoice) ? requestedVoice : 'echo'
    let speech
    try {
      speech = await openai.audio.speech.create({
        model,
        voice,
        input: text,
        instructions:
          'Speak warmly and naturally, like a friendly conversational helper named Genie. Clear, calm, and human — not robotic or overly theatrical.',
      })
    } catch (primaryError) {
      // Older accounts may not have gpt-4o-mini-tts yet.
      console.warn('Primary TTS model failed, falling back to tts-1-hd', primaryError)
      const fallbackVoice = tts1FallbackByVoice[voice] || voice
      speech = await openai.audio.speech.create({
        model: 'tts-1-hd',
        voice: fallbackVoice,
        input: text,
      })
    }

    const audioBytes = await speech.arrayBuffer()
    return new Response(audioBytes, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        ...getCorsHeaders(request, env),
      },
    })
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: publicGenerationError(error, 'Unable to speak that reply.') },
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

  if (sharePath?.isThumb) {
    return handleGetCoverThumb(request, env, sharePath.cardId)
  }

  if (sharePath) {
    return handleSharePreview(request, env, sharePath.cardId)
  }

  if (request.method === 'POST' && url.pathname === '/api/cards') {
    return handleSaveCard(request, env)
  }

  const thankYouMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/thank-you$/)
  if (thankYouMatch) {
    const thankYouCardId = decodeURIComponent(thankYouMatch[1])
    if (request.method === 'GET') {
      return handleGetThankYouStatus(request, env, thankYouCardId)
    }
    if (request.method === 'POST') {
      return handleSendThankYou(request, env, thankYouCardId)
    }
  }

  const revisionImageMatch = url.pathname.match(
    /^\/api\/cards\/([^/]+)\/revisions\/([^/]+)\/image$/,
  )
  if (request.method === 'GET' && revisionImageMatch) {
    return handleGetCardCoverRevisionImage(
      request,
      env,
      decodeURIComponent(revisionImageMatch[1]),
      decodeURIComponent(revisionImageMatch[2]),
    )
  }

  const revisionsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/revisions$/)
  if (request.method === 'GET' && revisionsMatch) {
    return handleListCardCoverRevisions(request, env, decodeURIComponent(revisionsMatch[1]))
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/cards/')) {
    return handleGetCard(request, env, decodeURIComponent(url.pathname.replace('/api/cards/', '')))
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/otp/start') {
    return handleStartAccountOtp(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/otp/verify') {
    return handleVerifyAccountOtp(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/account') {
    return handleGetAccount(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/account/profile') {
    return handleUpdateAccountProfile(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/account/history') {
    return handleGetAccountHistory(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/grant-credits') {
    return handleAdminGrantCredits(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/backfill-cover-thumbs') {
    return handleBackfillCoverThumbs(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/metrics') {
    return handleGetAdminMetrics(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/testimonials') {
    return handleListAdminTestimonials(request, env)
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/admin/testimonials/')) {
    return handleUpdateAdminTestimonial(
      request,
      env,
      decodeURIComponent(url.pathname.replace('/api/admin/testimonials/', '')),
    )
  }

  if (request.method === 'POST' && url.pathname === '/api/account/credits') {
    return handleAdjustAccountCredits(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/billing/checkout-session') {
    return handleCreateCheckoutSession(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/billing/webhook') {
    return handleStripeWebhook(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/testimonials') {
    return handleCreateTestimonial(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/deliver-card') {
    return handleDeliverCard(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/order-print-card') {
    return handleOrderPrintCard(request, env)
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

  if (request.method === 'POST' && url.pathname === '/api/card-interview') {
    return handleCardInterview(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/card-interview-speak') {
    return handleCardInterviewSpeak(request, env)
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
