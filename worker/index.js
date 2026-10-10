import OpenAI from 'openai'
import Stripe from 'stripe'
import { migrateAssetsToR2 } from './assets.js'
import { currentQuarter, getArtistPayouts, handleGcuRequest, matchGcuPath } from './gcu.js'
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
  recordCreatedCard,
  recordFailedDelivery,
  hideAccountCards,
  userCanAccessCard,
  recordStripeCreditPurchase,
  recordSuccessfulDelivery,
  recordThankYou,
  createPrintOrder,
  getPrintOrder,
  getShopperById,
  listAdminShoppers,
  countRecipientPrintOrders,
  listRecipientPrintOrders,
  markPrintOrderShipmentEmailSent,
  setPrintOrderShipmentEmailSchedule,
  listDueShipmentEmailOrders,
  updatePrintOrderShipping,
  saveAccountEmail,
  saveAccountMailingAddress,
  updateAccountProfile,
  updateTestimonialStatus,
  upsertUserOnLogin,
  TEST_LOGIN_PHONE,
} from './account-db.js'
import { USAGE_KINDS, getAdminCosts, recordUsage, smsSegmentCount } from './costs.js'
import {
  ensureCoverThumbForRecord,
  getCoverThumbBytes,
  getCoverThumbUrl,
  hasCoverThumb,
  putCoverThumbFromDataUrl,
} from './cover-thumbs.js'
import {
  backfillCreatedCardRecipients,
  backfillRecipients,
  deleteRecipient,
  deleteRecipientPhoto,
  getRecipientPhoto,
  listRecipients,
  updateRecipient,
  upsertRecipientFromCard,
} from './recipients.js'
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
  { id: '21', credits: 21, price: 10, priceId: 'price_1UOrSv1GfvmAXQBhNrH4obMu' },
  { id: '53', credits: 53, price: 25, priceId: 'price_1UOrSv1GfvmAXQBhVEbCmhue' },
  { id: '108', credits: 108, price: 50, priceId: 'price_1UOk001GfvmAXQBhQujTCQ5s' },
  { id: '222', credits: 222, price: 100, priceId: 'price_1UOk001GfvmAXQBhmcR4DTMO' },
]
/** No longer sold, but checkouts started before the Oct 2026 price changes still need crediting. */
const retiredCreditPacks = [
  { id: '20', credits: 20, price: 10, priceId: 'price_1UOjzx1GfvmAXQBhOiubPGsq' },
  { id: '52', credits: 52, price: 25, priceId: 'price_1UOjzy1GfvmAXQBhjEnv166G' },
  { id: '25', credits: 25, price: 10, priceId: 'price_1UFlL11GfvmAXQBhBGbdzji0' },
  { id: '60', credits: 60, price: 20, priceId: 'price_1UFlKl1GfvmAXQBho0xWW6JO' },
]

const creditPackById = new Map(creditPacks.map((pack) => [pack.id, pack]))
const creditPackByPriceId = new Map(creditPacks.map((pack) => [pack.priceId, pack]))
const anyCreditPackById = new Map([...creditPacks, ...retiredCreditPacks].map((pack) => [pack.id, pack]))
const anyCreditPackByPriceId = new Map([...creditPacks, ...retiredCreditPacks].map((pack) => [pack.priceId, pack]))

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

const personAppearancePattern =
  /\b(hair|haired|blonde?|brunette|redhead|ginger|gr[ae]y-haired|bald|curly|wavy|ponytail|braids?|beard(ed)?|mustache|moustache|goatee|stubble|freckles?|dimples?|eyes?|eyed|glasses|spectacles|skin|complexion|tall|petite|slim|slender|stocky|muscular|athletic build|height|wears?|wearing|dressed|outfit|shirt|dress|tattoos?|piercings?|looks like|resembles?)\b/i
const peopleRequestPattern =
  /\b(show|include|add|draw|depict|put)\b[^.]{0,40}\b(people|person|persons|man|men|woman|women|boy|girls?|boys|kids?|children|child|baby|couple|family|portrait|faces?)\b/i

const coverAllowsPeople = (details = {}, refinement = '') => {
  const context = `${details.keyDetails || ''}\n${refinement || ''}`
  return personAppearancePattern.test(context) || peopleRequestPattern.test(String(refinement || ''))
}

const coverNameFormalTitlePattern = /^(mr|mrs|ms|miss|mx|dr|prof|rev|the)\.?$/i
const coverNameCompoundFirstNames = new Set(['mary ann', 'mary anne', 'mary beth', 'mary jo', 'mary lou', 'mary kate', 'mary jane', 'mary ellen', 'mary grace', 'mary claire', 'anna mae', 'ella mae', 'lou ann', 'lee ann', 'jo ann', 'jo anne', 'ann marie', 'anne marie', 'anna marie', 'rose marie', 'betty jo', 'billie jo', 'bobbie jo', 'peggy sue', 'sue ellen', 'sara jane', 'sarah jane', 'billy bob', 'billy ray', 'billy joe', 'jim bob', 'joe bob', 'john paul', 'jean paul', 'jean claude', 'jean luc', 'jean pierre', 'tommy lee', 'bobby joe', 'la toya', 'de andre'])
const coverNameKinTitlePattern = /^(aunt|auntie|uncle|grandma|grandpa|granny|nana|papa|gigi|cousin|coach|sister|brother|sis|bro|mom|dad|mama|pastor|father|mother)$/i

const coverRecipientFirstNames = (fullName = '') => {
  const value = String(fullName || '').trim().replace(/\s+/g, ' ')
  if (!value) return ''
  const parts = value.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean)
  const firstNames = parts.map((part) => {
    const words = part.split(' ')
    if (words.length < 2 || coverNameFormalTitlePattern.test(words[0])) return part
    const start = coverNameKinTitlePattern.test(words[0]) ? 1 : 0
    const compound = words.length > start + 1 && coverNameCompoundFirstNames.has(`${words[start]} ${words[start + 1]}`.toLowerCase())
    return words.slice(0, start + (compound ? 2 : 1)).join(' ')
  })
  if (firstNames.length === 1) return firstNames[0]
  return `${firstNames.slice(0, -1).join(', ')} and ${firstNames[firstNames.length - 1]}`
}

const withCoverRecipientName = (details) =>
  details?.recipientName?.trim()
    ? { ...details, recipientName: coverRecipientFirstNames(details.recipientName) }
    : details

const buildImagePrompt = (details, ...args) => buildCoverImagePrompt(withCoverRecipientName(details), ...args)

const buildImageEditPrompt = (details, ...args) => buildCoverImageEditPrompt(withCoverRecipientName(details), ...args)

const coverChangeFields = [
  ['recipientName', 'Recipient name'],
  ['recipientType', 'Relationship'],
  ['occasion', 'Occasion'],
  ['tone', 'Tone'],
  ['imageStyle', 'Image style'],
  ['keyDetails', 'Personal details'],
]

const describeCoverDetailChanges = (previous, next) => {
  if (!previous || typeof previous !== 'object') return ''
  const lines = []
  for (const [field, label] of coverChangeFields) {
    let before = String(previous[field] || '').trim()
    let after = String(next?.[field] || '').trim()
    if (before === after) continue
    if (field === 'recipientName') {
      before = coverRecipientFirstNames(before)
      after = coverRecipientFirstNames(after)
    }
    const show = (value) => (value ? `"${value}"` : field === 'imageStyle' ? 'AI chooses the style' : '(blank)')
    lines.push(`- ${label}: changed from ${show(before)} to ${show(after)}`)
  }
  if (!lines.length) return ''
  return `The sender updated the card form since this cover was made. Apply these updates to the cover:
${lines.join('\n')}
If the image style changed, redraw the whole cover in the new style. If the occasion or recipient name changed, update any cover text to match.`
}

const combineCoverRefinement = (refinement, previous, next) =>
  [String(refinement || '').trim(), describeCoverDetailChanges(previous, next)].filter(Boolean).join('\n\n')

const buildPeopleOnCoverGuidance = (details, hasReferenceImages = false, refinement = '') => {
  const names = `the recipient is named "${details.recipientName || 'the recipient'}" and is described by the sender as "${details.recipientType}". The sender is named "${details.senderName || 'the sender'}".`
  const castingLine = `Name and relationship context: ${names} Use these names and relationship clues only as soft visual context for age, relationship, and casting when they are obvious. Do not add gender questions, do not stereotype, and do not force a photorealistic person if a symbolic or illustrative scene would work better.`

  if (hasReferenceImages) {
    return castingLine
  }

  if (coverAllowsPeople(details, refinement)) {
    return `${castingLine}

People on the cover: the sender described how someone looks or asked for people, so show the person or people as described in the personal context and refinement request.`
  }

  return `Name and relationship context: ${names} Use names and relationship only for the mood and meaning of the card, never to invent or cast people.

People on the cover: the sender provided no photos and did not describe what anyone looks like, so do not depict any people. No faces, heads, human figures, silhouettes, crowds, hands, or body parts. Tell the story through objects, places, food, nature, animals or pets the sender mentioned, and symbolic scenery instead. For example, show a pickleball paddle and ball, skis on a snowy slope, or two lattes and a pastry on a café table rather than people doing those things.`
}

const buildCoverImagePrompt = (details, refinement = '', imageMode = 'new', hasReferenceImages = false) => `
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

${buildPeopleOnCoverGuidance(details, hasReferenceImages, refinement)}
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
${
  details.recipientName?.trim()
    ? `- Personalize that phrase with the recipient's name, "${details.recipientName.trim()}", whenever cover text is used and it suits the occasion, for example "Happy Birthday, Joe" or "Thank You, Nellie". Use the name exactly as written here — first names only, never add a last name. Leave the name off only for somber occasions such as sympathy, or if it is too long to stay legible inside the safe area.\n`
    : ''
}- Ages may be included when they fit naturally and remain fully inside the central safe area.

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

const buildCoverImageEditPrompt = (details, refinement = '') => `
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

const detailFieldLabels = {
  senderName: 'From',
  occasion: 'Occasion',
  tone: 'Tone',
  length: 'Message length',
  keyDetails: 'Personal details',
}

const validateDetails = (details, requiredFields = ['senderName', 'occasion', 'tone', 'length', 'keyDetails']) =>
  requiredFields.filter((field) => !details[field]?.trim())

const refineRequiredFields = ['occasion']

const missingFieldsMessage = (missingFields) =>
  `Please fill in: ${missingFields.map((field) => detailFieldLabels[field] || field).join(', ')}.`

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

const imageUsageKind = (method, params) => {
  const files = Array.isArray(params?.image) ? params.image : params?.image ? [params.image] : []
  const names = files.map((file) => String(file?.name || ''))
  const isRevision = names.includes('current-cover.png')
  const hasPhoto = names.some((name) => name.startsWith('reference-'))
  if (method === 'generate' || !isRevision) {
    return hasPhoto ? USAGE_KINDS.imageNewWithPhoto : USAGE_KINDS.imageNew
  }
  return hasPhoto ? USAGE_KINDS.imageReviseWithPhoto : USAGE_KINDS.imageRevise
}

const trackOpenAIMethod = (env, resource, method, kindFor) => {
  const original = resource?.[method]?.bind(resource)
  if (!original) {
    return
  }
  resource[method] = async (params, ...rest) => {
    const result = await original(params, ...rest)
    await recordUsage(env, kindFor(params))
    return result
  }
}

const getOpenAI = (env) => {
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  })
  trackOpenAIMethod(env, client.responses, 'create', () => USAGE_KINDS.textModel)
  trackOpenAIMethod(env, client.images, 'generate', (params) => imageUsageKind('generate', params))
  trackOpenAIMethod(env, client.images, 'edit', (params) => imageUsageKind('edit', params))
  trackOpenAIMethod(env, client.audio?.speech, 'create', () => USAGE_KINDS.tts)
  trackOpenAIMethod(env, client.audio?.transcriptions, 'create', () => USAGE_KINDS.transcription)
  return client
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

const recipientDetailsFor = (record) => ({ ...(record?.editor?.details || {}), ...(record?.details || {}) })

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
    editor: buildCardEditorState(payload),
  }
}

const cardEditorTextLimit = 4000

const buildCardEditorState = (payload) => {
  const details = payload?.details || {}
  const clip = (value) => String(value || '').slice(0, cardEditorTextLimit)
  const variants = payload?.card?.messageVariants
  const lengths = ['short', 'medium', 'long']
  return {
    details: Object.fromEntries(
      ['recipientName', 'recipientType', 'senderName', 'occasion', 'tone', 'length', 'imageStyle', 'keyDetails'].map(
        (field) => [field, clip(details[field]).trim()],
      ),
    ),
    messageVariants:
      variants && lengths.every((length) => typeof variants[length] === 'string')
        ? Object.fromEntries(lengths.map((length) => [length, clip(variants[length])]))
        : undefined,
    selectedLength: lengths.includes(payload?.card?.selectedLength) ? payload.card.selectedLength : undefined,
  }
}

const saveCardRecord = async (
  env,
  record,
  { coverThumbDataUrl, revisionSource = 'save', refinement = '', replaceThumb = false } = {},
) => {
  if (env.CARD_STORE) {
    await env.CARD_STORE.put(record.id, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 })
  } else {
    fallbackCardStore.set(record.id, record)
  }

  try {
    if (coverThumbDataUrl) {
      await putCoverThumbFromDataUrl(env, record.id, coverThumbDataUrl)
    } else {
      await ensureCoverThumbForRecord(env, record, { replace: replaceThumb })
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
    editor: details && existing.editor ? { ...existing.editor, details: buildCardEditorState({ details }).details } : existing.editor,
    card: {
      ...existing.card,
      imageUrl,
    },
  }

  await saveCardRecord(env, next, {
    coverThumbDataUrl,
    revisionSource,
    refinement,
    replaceThumb: true,
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

  await recordCardHistory(env, {
    kind: 'generate',
    status: 'failed',
    ...job?.account,
    jobId: job?.id,
    details,
    photoCount,
    error: message,
  })

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
        await recordCardHistory(
          env,
          {
            kind: 'generate',
            ...job.account,
            jobId: job.id,
            details,
            photoCount: referenceImages.length,
            message: copy.message,
          },
          imageUrl,
        )
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

const getCardSummary = (record, request, env) => {
  const { editor: _editor, ...publicRecord } = record
  return {
    ...publicRecord,
    shareUrl: getShareUrl(request, env, record.id),
  }
}

const getEmailCoverUrl = (request, env, cardId) =>
  `${String(env.PUBLIC_API_URL || '').replace(/\/$/, '') || new URL(request.url).origin}/c/${encodeURIComponent(cardId)}/cover`

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
    from: { ...parseEmailSender(env.EMAIL_FROM), ...(copy.fromName ? { name: copy.fromName } : {}) },
    content: [
      { type: 'text/plain', value: copy.text },
      { type: 'text/html', value: copy.html },
    ],
    tracking_settings: {
      click_tracking: {
        enable: false,
        enable_text: false,
      },
      open_tracking: {
        enable: false,
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
    From: copy.fromName ? `${copy.fromName} <${parseEmailSender(env.EMAIL_FROM).email}>` : env.EMAIL_FROM,
    To: to,
    Subject: copy.subject,
    TextBody: copy.text,
    HtmlBody: copy.html,
    MessageStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
    TrackOpens: false,
    TrackLinks: 'None',
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
    const sentTo = await sendSendGridEmailDelivery({ env, to, copy, attachments })
    await recordUsage(env, USAGE_KINDS.email)
    return sentTo
  }

  if (env.POSTMARK_SERVER_TOKEN) {
    const sentTo = await sendPostmarkEmailDelivery({ env, to, copy, attachments })
    await recordUsage(env, USAGE_KINDS.email)
    return sentTo
  }

  throw new Error('Email delivery is not configured. Add SENDGRID_API_KEY and EMAIL_FROM.')
}

/** Ops inbox for live deploy summaries. */
const DEPLOY_SUMMARY_TO = 'cardgenie@gcuniverse.com'

const formatDeploySubjectStamp = (date = new Date()) => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

const buildDeploySummaryCopy = ({ subject, summary }) => {
  const safeSummary = String(summary || '').trim()
  return {
    subject,
    text: safeSummary,
    html: `
      <div style="font-family: Georgia, 'Times New Roman', serif; color: #1f1a17; line-height: 1.55; max-width: 640px;">
        <p style="margin: 0 0 12px; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; color: #7a6a60;">Card Genie deploy</p>
        <div style="white-space: pre-wrap; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 15px;">${escapeHtml(safeSummary)}</div>
      </div>
    `,
  }
}

const handleAdminDeploySummary = async (request, env) => {
  const expected = String(env.DEPLOY_NOTIFY_SECRET || env.ADMIN_SECRET || '').trim()
  const headerToken = readAccountToken(request)
  const querySecret = new URL(request.url).searchParams.get('secret') || ''
  const body = await request.json().catch(() => ({}))
  const bodySecret = String(body?.secret || '').trim()
  const provided = String(headerToken || querySecret || bodySecret || '').trim()
  const secretOk = Boolean(expected && provided && provided === expected)
  if (!secretOk && !(await isAdminRequest(request, env))) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }

  const summary = String(body?.summary || body?.text || '').trim()
  if (!summary) {
    return jsonResponse(request, env, { error: 'Missing summary.' }, 400)
  }

  const to = normalizeEmailAddress(String(body?.to || DEPLOY_SUMMARY_TO).trim() || DEPLOY_SUMMARY_TO)
  const stamp = formatDeploySubjectStamp(new Date())
  const subject = String(body?.subject || '').trim() || `Card Genie latest code - ${stamp}`

  try {
    await sendEmailDelivery({
      env,
      to,
      copy: buildDeploySummaryCopy({ subject, summary }),
    })
  } catch (error) {
    return jsonResponse(
      request,
      env,
      { error: error instanceof Error ? error.message : 'Unable to send deploy summary email.' },
      500,
    )
  }

  return jsonResponse(request, env, { ok: true, to, subject })
}

const PRINT_ORDER_SUPPORT_EMAIL = 'support@card-genie.com'
const PRINT_CARD_CREDIT_COST = 10
const PRINT_ORDER_PREVIEWS_PREFIX = 'print-order-previews:'
const PRINT_ORDER_PREVIEWS_TTL_SECONDS = 400 * 24 * 60 * 60

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

const formatShipDateLong = (isoDate) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim())
  if (!match) {
    return String(isoDate || '').trim()
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const buildPrintOrderConfirmationCopy = ({
  orderCode,
  shipTo,
  mailFrom,
  shipment = null,
  hasCoverPreview = true,
  hasInsidePreview = true,
}) => {
  const shipToBlock = formatMailingAddressBlock(shipTo)
  const includeReturnAddress = mailFrom && !isDefaultPrintMailFrom(mailFrom)
  const returnAddressBlock = includeReturnAddress ? formatMailingAddressBlock(mailFrom) : ''
  const subject = shipment
    ? `Your Card Genie printed card order shipment confirmation - ${orderCode}`
    : `Your Card Genie printed card order - ${orderCode}`
  const introLine = shipment
    ? 'Your Card Genie printed card has been mailed. Thank you for your order!'
    : "We've received your Card Genie print order. Thank you!"
  const gcuOrderNumber = shipment ? escapeHtml(shipment.gcuOrderNumber) : ''
  const deliveryCopy = shipment
    ? `Your card was mailed on ${formatShipDateLong(shipment.shipDate)}, from Northern California. Please allow 3 to 7 business days for delivery.`
    : "Your card will be mailed out the next business day via USPS regular mail, from Northern California. Once mailed, it'll take 3 to 7 business days for delivery."
  const deliveryNote = shipment
    ? 'Your card has been sent via USPS (regular mail) with a regular postage stamp, so there is no tracking.'
    : 'There is no tracking available on your order. It is mailed out in a regular envelope with a postage stamp.'
  const text = [
    introLine,
    '',
    `Order number: ${orderCode}`,
    shipment ? `GCU Order number: ${shipment.gcuOrderNumber}` : null,
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
    hasCoverPreview || hasInsidePreview ? '' : null,
    hasCoverPreview && hasInsidePreview
      ? 'Previews of your card cover and inside are included in this email.'
      : hasCoverPreview
        ? 'A preview of your card cover is included in this email.'
        : hasInsidePreview
          ? 'A preview of your card inside is included in this email.'
          : null,
  ]
    .filter((line) => line !== null)
    .join('\n')

  const previewCells = [
    hasCoverPreview
      ? `<td style="padding: 0 12px 0 0; vertical-align: top;">
            <p style="margin: 0 0 6px; font-size: 0.85rem; color: #666;">Cover</p>
            <img src="cid:print-cover-thumb" alt="Card cover" width="140" style="display:block;width:140px;max-width:140px;height:auto;border:0;border-radius:8px;" />
          </td>`
      : '',
    hasInsidePreview
      ? `<td style="padding: 0; vertical-align: top;">
            <p style="margin: 0 0 6px; font-size: 0.85rem; color: #666;">Inside</p>
            <img src="cid:print-inside-thumb" alt="Card inside" width="140" style="display:block;width:140px;max-width:140px;height:auto;border:1px solid #d0d0d0;border-radius:8px;" />
          </td>`
      : '',
  ].join('')

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #16272b;">
      <p style="margin: 0 0 12px;">${introLine}</p>
      ${
        shipment
          ? `<p style="margin: 0 0 4px; font-size: 1.1rem;"><strong>Order number:</strong> ${orderCode}</p>
      <p style="margin: 0 0 16px; font-size: 1.1rem;"><strong>GCU Order number:</strong> ${gcuOrderNumber}</p>`
          : `<p style="margin: 0 0 16px; font-size: 1.1rem;"><strong>Order number:</strong> ${orderCode}</p>`
      }
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
      ${
        previewCells
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          ${previewCells}
        </tr>
      </table>`
          : ''
      }
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

  await recordUsage(env, USAGE_KINDS.smsCard, { units: smsSegmentCount(copy.text) })
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
    const saveAccount = await getRequestAccount(request, env)
    if (saveAccount.userId) {
      try {
        await recordCreatedCard(env, {
          userId: saveAccount.userId,
          phoneE164: saveAccount.phone,
          record,
          replacesCardId: payload?.replacesCardId,
        })
      } catch (accountError) {
        console.error('Unable to record created card for account.', accountError)
      }
      try {
        await upsertRecipientFromCard(env, {
          userId: saveAccount.userId,
          details: recipientDetailsFor(record),
          cardId: record.id,
          sent: false,
        })
      } catch (recipientError) {
        console.error('recipient save failed', recipientError)
      }
    }
    await recordCardHistory(env, {
      kind: 'save',
      ...saveAccount,
      cardId: record.id,
      details: payload?.details,
      message: record.card.message,
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

  await recordUsage(env, USAGE_KINDS.smsAccount, { units: smsSegmentCount(body) })
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

const handleAccountLogout = async (request, env) => {
  const token = readAccountToken(request)
  if (token && env.CARD_STORE) {
    await env.CARD_STORE.delete(`session:${token}`)
  }
  return jsonResponse(request, env, { ok: true })
}

/** TEST_LOGIN_PHONE is fictional: no text is sent, the code is the TEST_LOGIN_CODE secret, and every sign-in starts a brand-new account with 0 credits. */
const testLoginCode = (env) => String(env.TEST_LOGIN_CODE || '').replace(/\D/g, '')

// Frees the test number by renaming the previous test account, so its history stays but the next login is new.
const retireTestLoginAccount = async (env) => {
  await env.CARD_STORE.delete(`user:phone:${TEST_LOGIN_PHONE}`)
  if (!env.ACCOUNT_DB) return
  const now = new Date().toISOString()
  await env.ACCOUNT_DB.prepare(
    `UPDATE users SET phone_e164 = ?, status = 'test_retired', updated_at = ? WHERE phone_e164 = ?`,
  )
    .bind(`${TEST_LOGIN_PHONE}#retired-${Date.now()}`, now, TEST_LOGIN_PHONE)
    .run()
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

    if (phoneE164 === TEST_LOGIN_PHONE) {
      if (testLoginCode(env).length !== 6) {
        return jsonResponse(request, env, { error: 'The test number is not set up.' }, 400)
      }
      await env.CARD_STORE.put(
        `otp:${phoneE164}`,
        JSON.stringify({ codeHash: await hashSecret(testLoginCode(env)), attempts: 0, sentAt: Date.now() }),
        { expirationTtl: otpTtlSeconds },
      )
      return jsonResponse(request, env, { ok: true, phoneE164, message: 'We texted you a 6-digit code.' })
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
    const { phone, code, source } = (await readJson(request)) || {}
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

    if (phoneE164 === TEST_LOGIN_PHONE) {
      await retireTestLoginAccount(env)
    }

    const userKey = `user:phone:${phoneE164}`
    const existingUser = (await env.CARD_STORE.get(userKey, 'json')) || null
    const account = await upsertUserOnLogin(env, {
      phoneE164,
      request,
      existingUserId: existingUser?.id,
      signupSource: source === 'gcu' ? 'gcu' : 'web',
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

    let profile = null
    try {
      profile = await getAccountForSession(env, user.id)
    } catch (profileError) {
      console.error(profileError)
    }

    return jsonResponse(request, env, {
      ok: true,
      token,
      phoneE164,
      email: profile?.email || user.email || '',
      preferredName: profile?.preferredName || '',
      mailingAddress: profile?.mailingAddress || null,
      creditBalance: user.creditBalance ?? 2,
      paidCreditBalance: profile?.paidCreditBalance ?? 0,
      isNew: account?.isNew === true,
      phoneVerifyBonusCredits: account?.isNew ? (account.phoneVerifyBonusCredits ?? 2) : 0,
      message:
        account?.isNew === true
          ? account.phoneVerifyBonusCredits === 0
            ? 'Your number is confirmed.'
            : 'Your number is confirmed. We added 2 credits for registering.'
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

const resolveCreditPack = ({ packId, priceId } = {}, { includeRetired = false } = {}) => {
  const byPriceId = includeRetired ? anyCreditPackByPriceId : creditPackByPriceId
  const byId = includeRetired ? anyCreditPackById : creditPackById
  if (priceId && byPriceId.has(String(priceId))) {
    return byPriceId.get(String(priceId))
  }
  if (packId && byId.has(String(packId))) {
    return byId.get(String(packId))
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
  // Greeting Card Universe card pages buy credits without leaving for Card Genie.
  const gcuReturnPath = /^\/gcu\/\d{1,12}$/.test(String(body.returnPath || '')) ? String(body.returnPath) : ''
  const successUrl = gcuReturnPath ? `${appUrl}${gcuReturnPath}?billing=success` : `${appUrl}/?billing=success${resumeQuery}`
  const cancelUrl = gcuReturnPath ? `${appUrl}${gcuReturnPath}?billing=cancel` : `${appUrl}/?billing=cancel${resumeQuery}`

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: pack.priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: session.userId,
      metadata: {
        userId: session.userId,
        phoneE164: session.phoneE164 || '',
        credits: String(pack.credits),
        packId: pack.id,
        priceId: pack.priceId,
        ...(resumeQuery ? { resumeCardId } : {}),
        ...(gcuReturnPath ? { source: 'gcu' } : {}),
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
    resolveCreditPack(
      {
        packId: metadata.packId,
        priceId: metadata.priceId || checkoutSession?.metadata?.priceId,
      },
      { includeRetired: true },
    ) ||
    resolveCreditPack(
      {
        priceId: checkoutSession?.line_items?.data?.[0]?.price?.id,
      },
      { includeRetired: true },
    )

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

const RECIPIENT_PRINT_PRICE_CENTS = 500
const RECIPIENT_PRINT_PENDING_PREFIX = 'recipient-print-pending:'
const RECIPIENT_PRINT_DONE_PREFIX = 'recipient-print-done:'

const handleRecipientPrintCheckout = async (request, env) => {
  const stripe = getStripe(env)
  if (!stripe || !env.CARD_STORE) {
    return jsonResponse(request, env, { error: 'Printed cards are not available right now.' }, 503)
  }

  try {
    const body = (await readJson(request)) || {}
    const record = await getCardRecord(env, String(body.cardId || '').trim())
    if (!record) {
      return jsonResponse(request, env, { error: 'This card is no longer available to print.' }, 404)
    }
    const shipTo = normalizeMailingAddress(body.shipTo, 'ship-to')
    const email = normalizeEmailAddress(body.email)
    const cover = parseDataUrlImage(body.coverImage, 'cover')
    const inside = parseDataUrlImage(body.insideImage, 'inside')
    const coverThumb = body.coverThumbImage
      ? parseDataUrlImage(body.coverThumbImage, 'cover thumbnail')
      : { type: cover.type, content: cover.content }
    const insideThumb = body.insideThumbImage
      ? parseDataUrlImage(body.insideThumbImage, 'inside thumbnail')
      : { type: inside.type, content: inside.content }

    const pendingId = crypto.randomUUID()
    await env.CARD_STORE.put(
      `${RECIPIENT_PRINT_PENDING_PREFIX}${pendingId}`,
      JSON.stringify({ cardId: record.id, shipTo, email, cover, inside, coverThumb, insideThumb, createdAt: new Date().toISOString() }),
      { expirationTtl: 3 * 24 * 60 * 60 },
    )

    const { sender, occasion } = buildSharePreviewCopy(record)
    const appUrl = getCheckoutReturnBaseUrl(request, env)
    const cardQuery = `card=${encodeURIComponent(record.id)}`
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: RECIPIENT_PRINT_PRICE_CENTS,
            product_data: {
              name: 'Printed Card Genie keepsake card',
              description: `Your ${occasion} card from ${sender}, printed and mailed to you. Shipping included.`,
            },
          },
        },
      ],
      customer_email: email,
      success_url: `${appUrl}/?${cardQuery}&keepsake=success`,
      cancel_url: `${appUrl}/?${cardQuery}&keepsake=cancel`,
      metadata: { kind: 'recipient_print', pendingId, cardId: record.id },
      integration_identifier: `card-genie-keepsake-${pendingId.slice(0, 8)}`,
    })
    if (!checkoutSession.url) {
      return jsonResponse(request, env, { error: 'Unable to start checkout.' }, 500)
    }
    return jsonResponse(request, env, { ok: true, url: checkoutSession.url })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start checkout.'
    const isValidation = /enter|choose|provide|valid|united states|zip|state|street|name|city|image|email|@/i.test(message)
    if (!isValidation) {
      console.error('Recipient print checkout failed.', error)
    }
    return jsonResponse(request, env, { error: message }, isValidation ? 400 : 500)
  }
}

const fulfillRecipientPrintOrder = async (request, env, checkoutSession) => {
  const pendingId = String(checkoutSession?.metadata?.pendingId || '')
  const doneKey = `${RECIPIENT_PRINT_DONE_PREFIX}${checkoutSession.id}`
  if (!pendingId || (await env.CARD_STORE.get(doneKey))) {
    return
  }
  const pending = await env.CARD_STORE.get(`${RECIPIENT_PRINT_PENDING_PREFIX}${pendingId}`, 'json')
  if (!pending) {
    console.error('Paid recipient print order has no pending data.', { pendingId, checkoutId: checkoutSession.id })
    await sendEmailDelivery({
      env,
      to: PRINT_ORDER_SUPPORT_EMAIL,
      copy: {
        subject: 'Recipient keepsake order needs attention',
        text: `A $5 recipient keepsake order was paid (Stripe checkout ${checkoutSession.id}, card ${checkoutSession?.metadata?.cardId || 'unknown'}, ${checkoutSession.customer_details?.email || ''}), but its print files had expired. Please contact the customer.`,
        html: `<p>A $5 recipient keepsake order was paid (Stripe checkout ${escapeHtml(checkoutSession.id)}, card ${escapeHtml(checkoutSession?.metadata?.cardId || 'unknown')}, ${escapeHtml(checkoutSession.customer_details?.email || '')}), but its print files had expired. Please contact the customer.</p>`,
      },
    })
    await env.CARD_STORE.put(doneKey, 'missing', { expirationTtl: 30 * 24 * 60 * 60 })
    return
  }

  const record = await getCardRecord(env, pending.cardId)
  const savedOrder = await createPrintOrder(env, {
    userId: null,
    cardId: pending.cardId,
    mailFrom: DEFAULT_PRINT_MAIL_FROM,
    shipTo: pending.shipTo,
    shopperEmail: pending.email,
    creditCost: 0,
    orderSource: 'recipient',
    amountCents: checkoutSession.amount_total ?? RECIPIENT_PRINT_PRICE_CENTS,
  })
  const orderCode = savedOrder.orderCode
  await env.CARD_STORE.put(doneKey, orderCode, { expirationTtl: 30 * 24 * 60 * 60 })

  const supportCopy = buildPrintOrderEmailCopy({
    cardId: pending.cardId,
    orderCode,
    shareUrl: getShareUrl(request, env, pending.cardId),
    mailFrom: DEFAULT_PRINT_MAIL_FROM,
    shipTo: pending.shipTo,
    details: record?.details || {},
    shopperEmail: pending.email,
  })
  const keepsakeNote = 'Recipient keepsake order: paid $5.00 by card (shipping included). Mail it to the recipient below.'
  supportCopy.subject = `Recipient keepsake · ${supportCopy.subject}`
  supportCopy.text = `${keepsakeNote}\n\n${supportCopy.text}`
  supportCopy.html = `<p style="margin:0 0 12px;font-family:Arial,sans-serif;"><strong>${keepsakeNote}</strong></p>${supportCopy.html}`

  try {
    await sendEmailDelivery({
      env,
      to: PRINT_ORDER_SUPPORT_EMAIL,
      copy: supportCopy,
      attachments: [
        {
          filename: pending.cover.type?.includes('jpeg') ? 'print-cover.jpg' : 'print-cover.png',
          type: pending.cover.type || 'image/png',
          content: pending.cover.content,
        },
        { filename: 'print-inside.png', type: pending.inside.type || 'image/png', content: pending.inside.content },
      ],
    })
  } catch (error) {
    console.error('Recipient keepsake support email failed.', error)
  }

  try {
    await sendEmailDelivery({
      env,
      to: pending.email,
      copy: buildPrintOrderConfirmationCopy({ orderCode, shipTo: pending.shipTo, mailFrom: DEFAULT_PRINT_MAIL_FROM }),
      attachments: [
        {
          filename: 'print-cover-thumb.jpg',
          type: pending.coverThumb.type || 'image/jpeg',
          content: pending.coverThumb.content,
          disposition: 'inline',
          contentId: 'print-cover-thumb',
        },
        {
          filename: 'print-inside-thumb.png',
          type: pending.insideThumb.type || 'image/png',
          content: pending.insideThumb.content,
          disposition: 'inline',
          contentId: 'print-inside-thumb',
        },
      ],
    })
  } catch (error) {
    console.error('Recipient keepsake confirmation email failed.', error)
  }

  try {
    await env.CARD_STORE.put(
      `${PRINT_ORDER_PREVIEWS_PREFIX}${orderCode}`,
      JSON.stringify({ cover: pending.coverThumb, inside: pending.insideThumb }),
      { expirationTtl: PRINT_ORDER_PREVIEWS_TTL_SECONDS },
    )
    await env.CARD_STORE.delete(`${RECIPIENT_PRINT_PENDING_PREFIX}${pendingId}`)
  } catch (error) {
    console.error('Recipient keepsake cleanup failed.', error)
  }
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
        if (checkoutSession?.metadata?.kind === 'recipient_print') {
          await fulfillRecipientPrintOrder(request, env, checkoutSession)
        } else {
          await grantCreditsFromCheckoutSession(env, checkoutSession)
        }
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
  return jsonResponse(request, env, await buildAccountHistoryPayload(request, env, history, session.phoneE164))
}

const buildAccountHistoryPayload = async (request, env, history, phoneE164) => {
  if (!history) {
    return {
      ok: true,
      phoneE164,
      account: null,
      creditEvents: [],
      cards: [],
      deliveries: [],
    }
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
  const thumbVersions = new Map()
  const cardSummaries = {}
  await Promise.all(
    cardIds.map(async (cardId) => {
      const record = await getCardRecord(env, cardId)
      if (record) {
        const version = Date.parse(record.updatedAt || record.createdAt || '')
        if (Number.isFinite(version)) {
          thumbVersions.set(cardId, String(version))
        }
        const recipientName = String(record.details?.recipientName || '').trim()
        const occasion = String(record.details?.occasion || '').trim()
        const senderName = String(record.details?.senderName || '').trim()
        const message = String(record.card?.message || '').replace(/\s+/g, ' ').trim()
        cardSummaries[cardId] = {
          recipientName,
          occasion,
          groupKey: [recipientName, occasion, senderName, message.slice(0, 240)]
            .map((part) => part.toLowerCase())
            .join('|'),
        }
      }

      if (await hasCoverThumb(env, cardId)) {
        thumbsAvailable.add(cardId)
        return
      }

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
        coverThumbUrl:
          cardId && thumbsAvailable.has(cardId)
            ? `${getCoverThumbUrl(request, env, cardId)}${thumbVersions.has(cardId) ? `?v=${thumbVersions.get(cardId)}` : ''}`
            : '',
      }
    })

  return {
    ok: true,
    phoneE164,
    ...history,
    cards: withThumbUrls(history.cards, 'id'),
    deliveries: withThumbUrls(history.deliveries, 'cardId'),
    printOrders: withThumbUrls(history.printOrders, 'cardId'),
    cardSummaries,
  }
}

const requireAccountSession = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  return session
    ? { session }
    : { denied: jsonResponse(request, env, { error: 'Confirm your mobile number to see your recipients.' }, 401) }
}

const handleListRecipients = async (request, env) => {
  const { session, denied } = await requireAccountSession(request, env)
  if (denied) {
    return denied
  }
  return jsonResponse(request, env, { ok: true, recipients: await listRecipients(env, session.userId) })
}

const handleUpdateRecipient = async (request, env) => {
  const { session, denied } = await requireAccountSession(request, env)
  if (denied) {
    return denied
  }
  const body = (await readJson(request)) || {}
  try {
    const fields = {}
    for (const key of ['name', 'relation', 'keyDetails', 'notes', 'mailingAddress']) {
      if (body[key] !== undefined) {
        fields[key] = body[key]
      }
    }
    for (const key of ['birthday', 'anniversary']) {
      if (body[key] !== undefined) {
        const value = String(body[key] || '').trim()
        if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return jsonResponse(request, env, { error: 'Choose a valid date.' }, 400)
        }
        fields[key] = value
      }
    }
    if (body.email !== undefined) {
      fields.email = String(body.email || '').trim() ? normalizeEmailAddress(body.email) : ''
    }
    if (body.phone !== undefined) {
      fields.phoneE164 = String(body.phone || '').trim() ? normalizePhoneNumber(body.phone) : ''
    }
    const recipient = await updateRecipient(env, session.userId, String(body.id || ''), fields)
    if (!recipient) {
      return jsonResponse(request, env, { error: 'Recipient not found.' }, 404)
    }
    return jsonResponse(request, env, { ok: true, recipient })
  } catch (error) {
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to save.' }, 400)
  }
}

const handleDeleteRecipient = async (request, env) => {
  const { session, denied } = await requireAccountSession(request, env)
  if (denied) {
    return denied
  }
  const body = (await readJson(request)) || {}
  const ok = await deleteRecipient(env, session.userId, String(body.id || ''))
  return ok
    ? jsonResponse(request, env, { ok: true })
    : jsonResponse(request, env, { error: 'Recipient not found.' }, 404)
}

const handleDeleteRecipientPhoto = async (request, env) => {
  const { session, denied } = await requireAccountSession(request, env)
  if (denied) {
    return denied
  }
  const body = (await readJson(request)) || {}
  const recipient = await deleteRecipientPhoto(env, session.userId, String(body.id || ''), Number(body.index))
  return recipient
    ? jsonResponse(request, env, { ok: true, recipient })
    : jsonResponse(request, env, { error: 'Recipient not found.' }, 404)
}

const handleGetRecipientPhoto = async (request, env) => {
  const url = new URL(request.url)
  const recipientId = url.searchParams.get('id') || ''
  const index = Number(url.searchParams.get('n') || 0)
  const session = await getAccountSession(env, readAccountToken(request))
  const isAdmin = await isAdminRequest(request, env)
  if (!session && !isAdmin) {
    return jsonResponse(request, env, { error: 'Not found.' }, 404)
  }
  const dataUrl = await getRecipientPhoto(env, isAdmin ? null : session.userId, recipientId, index)
  const parsed = parseDataImage(dataUrl)
  if (!parsed) {
    return jsonResponse(request, env, { error: 'Photo not found.' }, 404)
  }
  return new Response(parsed.bytes, {
    headers: {
      ...getCorsHeaders(request, env),
      'Content-Type': parsed.mimeType,
      'Cache-Control': 'private, no-store',
    },
  })
}

const handleGetAccountCard = async (request, env, cardId) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number to open your cards.' }, 401)
  }
  if (!(await userCanAccessCard(env, { userId: session.userId, phoneE164: session.phoneE164, cardId }))) {
    return jsonResponse(request, env, { error: 'Card not found.' }, 404)
  }
  const record = await getCardRecord(env, cardId)
  if (!record) {
    return jsonResponse(request, env, { error: 'That card is no longer available.' }, 404)
  }
  return jsonResponse(request, env, { ...getCardSummary(record, request, env), editor: record.editor || null })
}

const handleHideAccountCards = async (request, env) => {
  const session = await getAccountSession(env, readAccountToken(request))
  if (!session) {
    return jsonResponse(request, env, { error: 'Confirm your mobile number to manage your cards.' }, 401)
  }
  const body = (await readJson(request)) || {}
  const requested = Array.isArray(body.cardIds) ? body.cardIds : []
  const cardIds = [...new Set(requested.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].slice(0, 20)
  if (!cardIds.length) {
    return jsonResponse(request, env, { error: 'No cards to remove.' }, 400)
  }
  const allowed = []
  for (const cardId of cardIds) {
    if (await userCanAccessCard(env, { userId: session.userId, phoneE164: session.phoneE164, cardId })) {
      allowed.push(cardId)
    }
  }
  const hidden = await hideAccountCards(env, { userId: session.userId, phoneE164: session.phoneE164, cardIds: allowed })
  return jsonResponse(request, env, { ok: true, hidden })
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
    paidCreditBalance: account?.paidCreditBalance ?? null,
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

const handleGetAdminCosts = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }

  if (!accountDbReady(env)) {
    return jsonResponse(request, env, { error: 'Account storage is not configured.' }, 500)
  }

  const costs = await getAdminCosts(env)
  if (!costs) {
    return jsonResponse(request, env, { error: 'Unable to load cost estimates.' }, 500)
  }

  return jsonResponse(request, env, { ok: true, ...costs })
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

  const firstName = String(user.preferredName || user.preferred_name || '').trim().split(/\s+/)[0] || ''
  const creditWord = (count) => `${count} credit${count === 1 ? '' : 's'}`
  const grantText = [
    `${firstName ? `Hi ${firstName}! ` : 'Hi! '}Good news from Card Genie: we've added ${creditWord(amount)} to your account, on us.`,
    `You now have ${creditWord(nextBalance)} to create and send personalized cards.`,
    `Make one anytime at ${getPublicAppUrl(request, env)}`,
    'Reply STOP to opt out.',
  ].join(' ')
  let textSent = false
  try {
    await sendTextDelivery({ env, to: phoneE164, copy: { text: grantText } })
    textSent = true
  } catch (textError) {
    console.error('Credit grant text failed.', textError)
  }

  return jsonResponse(request, env, {
    ok: true,
    phoneE164,
    creditsAdded: amount,
    creditBalance: nextBalance,
    previousBalance: Math.max(0, nextBalance - amount),
    textSent,
    message: `Added ${amount} credits. New balance: ${nextBalance}. ${textSent ? 'We texted them to let them know.' : 'The text notification could not be sent.'}`,
  })
}

const feedbackCommentMaxLength = 280
const feedbackNameMaxLength = 80
const feedbackSources = new Set(['post_send', 'account'])

const REVIEW_ALERT_TO = DEPLOY_SUMMARY_TO

const loadReviewSenderDetails = async (env, userId) => {
  if (!userId || !env.ACCOUNT_DB) {
    return null
  }
  const db = env.ACCOUNT_DB
  const safeAll = async (sql) => {
    try {
      return (await db.prepare(sql).bind(userId).all()).results || []
    } catch {
      return []
    }
  }
  const [users, cards, deliveries, prints, credits] = await Promise.all([
    safeAll(
      `SELECT phone_e164, email, preferred_name, credit_balance, created_at, last_login_at FROM users WHERE id = ?`,
    ),
    safeAll(
      `SELECT id, created_at, status, recipient_name, occasion FROM cards WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
    ),
    safeAll(
      `SELECT card_id, created_at, method, destination, status FROM deliveries
       WHERE user_id = ? AND is_sender_copy = 0 ORDER BY created_at DESC LIMIT 10`,
    ),
    safeAll(`SELECT order_number, card_id, created_at, ship_to_name FROM print_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`),
    safeAll(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'purchase' THEN credits_delta ELSE 0 END), 0) AS purchased FROM credit_events WHERE user_id = ?`,
    ),
  ])
  return { user: users[0] || null, cards, deliveries, prints, purchased: Number(credits[0]?.purchased || 0) }
}

const buildReviewAlertText = ({ review, sender, request, env }) => {
  const stamp = (iso) => (iso ? formatDeploySubjectStamp(new Date(iso)) : '—')
  const lines = [
    'New Card Genie review',
    '',
    `Name: ${review.name || '(not given)'}`,
    `Rating: ${review.rating ? `${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} (${review.rating}/5)` : '(no rating)'}`,
    `Where: ${review.source}`,
    `Received: ${stamp(review.createdAt)}`,
    `Review id: ${review.id}`,
    '',
    'Comment:',
    review.comment,
    '',
    '— Sender —',
  ]
  const user = sender?.user
  if (!user) {
    lines.push('Not signed in (no account details).')
  } else {
    lines.push(
      `Account first name: ${user.preferred_name || '(none)'}`,
      `Phone: ${user.phone_e164 || review.phoneE164 || '(none)'}`,
      `Email: ${user.email || '(none)'}`,
      `Account created: ${stamp(user.created_at)}`,
      `Last sign-in: ${stamp(user.last_login_at)}`,
      `Credits left: ${user.credit_balance ?? 0} · Credits purchased: ${sender.purchased}`,
      '',
      'Recent cards:',
      ...(sender.cards.length
        ? sender.cards.map(
            (card) =>
              `- ${stamp(card.created_at)} · ${card.occasion || 'Card'} for ${card.recipient_name || '(no name)'} · ${card.status} · ${getShareUrl(request, env, card.id)}`,
          )
        : ['- none']),
      '',
      'Recent sends:',
      ...(sender.deliveries.length
        ? sender.deliveries.map(
            (delivery) => `- ${stamp(delivery.created_at)} · ${delivery.method} to ${delivery.destination} · ${delivery.status}`,
          )
        : ['- none']),
      '',
      'Print orders:',
      ...(sender.prints.length
        ? sender.prints.map((order) => `- ${stamp(order.created_at)} · #${order.order_number} to ${order.ship_to_name || '(no name)'}`)
        : ['- none']),
    )
  }
  return lines.join('\n')
}

const sendReviewAlert = async (env, request, review) => {
  try {
    const sender = await loadReviewSenderDetails(env, review.userId)
    const text = buildReviewAlertText({ review, sender, request, env })
    const who = review.name || sender?.user?.preferred_name || 'someone'
    const subject = `New review from ${who}${review.rating ? ` (${review.rating}★)` : ''}`
    await sendEmailDelivery({
      env,
      to: REVIEW_ALERT_TO,
      copy: {
        subject,
        text,
        html: `<div style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 15px; line-height: 1.5; white-space: pre-wrap; color: #1f1a17;">${escapeHtml(text)}</div>`,
      },
    })
  } catch (error) {
    console.error('review alert email failed', error)
  }
}

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

    await sendReviewAlert(env, request, {
      id: saved.id,
      createdAt: saved.createdAt || new Date().toISOString(),
      name,
      rating,
      comment,
      source,
      userId: session?.userId || null,
      phoneE164: session?.phoneE164 || null,
    })

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
    saveRecipientPhotos,
  } = (await readJson(request)) || {}
  let pendingRecipientPhotos = Array.isArray(saveRecipientPhotos) ? saveRecipientPhotos : []
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
      { error: 'Check the box to send this card by text.' },
      400,
    )
  }

  const shareUrl = getShareUrl(request, env, record.id)
  const coverUrl = getEmailCoverUrl(request, env, record.id)
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

      try {
        await upsertRecipientFromCard(env, {
          userId: session.userId,
          details: recipientDetailsFor(record),
          cardId: record.id,
          email: method === 'email' ? deliveredTo : '',
          phoneE164: method === 'text' ? deliveredTo : '',
          photos: pendingRecipientPhotos,
        })
        pendingRecipientPhotos = []
      } catch (recipientError) {
        console.error('recipient save failed', recipientError)
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
      saveRecipientPhotos,
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
    try {
      await upsertRecipientFromCard(env, {
        userId: session.userId,
        details: recipientDetailsFor(record),
        cardId: record.id,
        mailingAddress: shipTo,
        photos: Array.isArray(saveRecipientPhotos) ? saveRecipientPhotos : [],
      })
    } catch (recipientError) {
      console.error('recipient save failed', recipientError)
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
      await env.CARD_STORE?.put(
        `${PRINT_ORDER_PREVIEWS_PREFIX}${orderCode}`,
        JSON.stringify({ cover: coverThumb, inside: insideThumb }),
        { expirationTtl: PRINT_ORDER_PREVIEWS_TTL_SECONDS },
      )
    } catch (previewError) {
      console.error('Unable to save print order previews.', previewError)
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
    return jsonResponse(request, env, { error: missingFieldsMessage(missingFields) }, 400)
  }

  let job

  try {
    job = await saveGenerateJob(env, {
      id: createCardId(),
      status: 'queued',
      details,
      account: await getRequestAccount(request, env),
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

  const {
    details,
    previousDetails,
    refinement: rawRefinement,
    imageMode,
    currentImageUrl,
    cardId,
    referenceImages: rawReferenceImages,
  } = (await readJson(request)) || {}
  const refinement = combineCoverRefinement(rawRefinement, previousDetails, details)
  const referenceImages = normalizeReferenceImages(rawReferenceImages)
  const missingFields = validateDetails(details || {}, refineRequiredFields)

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: missingFieldsMessage(missingFields) }, 400)
  }

  if (!refinement?.trim()) {
    return jsonResponse(request, env, { error: 'Tell us what to change about the cover image, or update the card details above.' }, 400)
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

    await recordCardHistory(
      env,
      {
        kind: 'refine-image',
        ...(await getRequestAccount(request, env)),
        cardId: responseCardId,
        details,
        refinement,
        imageMode: revisionSource,
        photoCount: referenceImages.length,
      },
      imageUrl,
    )

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
  const missingFields = validateDetails(details || {}, refineRequiredFields)

  if (missingFields.length > 0) {
    return jsonResponse(request, env, { error: missingFieldsMessage(missingFields) }, 400)
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

    await recordCardHistory(env, {
      kind: 'refine-copy',
      ...(await getRequestAccount(request, env)),
      details,
      refinement,
      photoCount: referenceImages.length,
      message: copy.message,
    })

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
- If the shopper mentions tone (example: "funny", "playful", "romantic", "heartfelt", "elegant", "encouraging", "business/professional"), set tone to the exact matching option from: ${CARD_INTERVIEW_TONES.join(', ')}. Do not leave tone preferences only inside keyDetails. Never ask for tone.
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
- If the shopper mentions tone (example: "funny", "playful", "romantic", "heartfelt", "elegant", "encouraging", "business/professional"), set tone to the exact matching option from: ${CARD_INTERVIEW_TONES.join(', ')}. Do not leave tone preferences only inside keyDetails.
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

const inferInterviewToneFromText = (text) => {
  const value = String(text || '').toLowerCase()
  if (!value) {
    return ''
  }
  if (/\b(romantic|lovey|affectionate|love\s*note)\b/.test(value)) {
    return 'Romantic'
  }
  if (/\b(business|professional|corporate)\b/.test(value)) {
    return 'Business'
  }
  if (/\b(encourag(?:e|ing|ement)|supportive|uplift(?:ing)?|motivational)\b/.test(value)) {
    return 'Encouraging'
  }
  if (/\b(elegant|classy|sophisticated|refined)\b/.test(value)) {
    return 'Elegant'
  }
  if (/\b(funny|humor(?:ous)?|hilarious|jokes?|witty|comedic|comedy)\b/.test(value)) {
    return 'Funny'
  }
  if (/\b(playful|light[\s-]?hearted)\b/.test(value)) {
    return 'Playful'
  }
  if (/\b(heartfelt|sincere|from\s+the\s+heart|sentimental)\b/.test(value)) {
    return 'Heartfelt'
  }
  if (
    /\b(?:tone|make\s+it|keep\s+it|something|more)\s+(?:a\s+bit\s+|more\s+)?(?:fun|light)\b|\bfun\s+tone\b/.test(
      value,
    )
  ) {
    return 'Playful'
  }
  return ''
}

const normalizeInterviewTone = (raw) => {
  const value = String(raw || '').trim()
  if (!value) {
    return ''
  }
  const exact = CARD_INTERVIEW_TONES.find((tone) => tone.toLowerCase() === value.toLowerCase())
  if (exact) {
    return exact
  }
  return inferInterviewToneFromText(value)
}

const normalizeInterviewDetails = (raw = {}) => {
  const toneRaw = String(raw.tone || '').trim()
  const tone =
    normalizeInterviewTone(toneRaw) ||
    CARD_INTERVIEW_TONES.find((option) => option.toLowerCase() === toneRaw.toLowerCase()) ||
    'Heartfelt'
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

  const inferredTone = inferInterviewToneFromText(shopperText || fullTranscript)
  next.tone = normalizeInterviewTone(next.tone) || inferredTone || next.tone || 'Heartfelt'

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
        speed: 1.1,
        instructions:
          'Speak warmly and naturally, like a friendly conversational helper named Genie. Clear, calm, and human — not robotic or overly theatrical. Speak about 10% faster than a natural conversational pace.',
      })
    } catch (primaryError) {
      // Older accounts may not have gpt-4o-mini-tts yet.
      console.warn('Primary TTS model failed, falling back to tts-1-hd', primaryError)
      const fallbackVoice = tts1FallbackByVoice[voice] || voice
      speech = await openai.audio.speech.create({
        model: 'tts-1-hd',
        voice: fallbackVoice,
        input: text,
        speed: 1.1,
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

const REALTIME_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
])

const REALTIME_VOICE_FALLBACK = {
  nova: 'shimmer',
  fable: 'ballad',
  onyx: 'echo',
}

const buildLampGenieRealtimeInstructions = (shopperFirstName = '') => {
  const shopperNote = shopperFirstName
    ? `The shopper’s first name on their account is "${shopperFirstName}". When they say the card is from "me" or "me and …", use this first name for "me"/"myself".
The card is from ${shopperFirstName} (the signed-in member), and your greeting already told them: "Looks like this card is from you, ${shopperFirstName}." NEVER ask who the card is from. Fill senderName with "${shopperFirstName}" in every update_card_details and complete_card_interview call. Only change it if the shopper says it is from someone else or from more people (for example "from me and Min" means "${shopperFirstName} and Min").`
    : 'If the shopper has not said who the card is from, ask who it is from along with any other missing essentials.'
  return `You are Genie, the friendly Lamp Genie voice helper for Card Genie. Speak warmly, briefly, and naturally in English — about 10% faster than a casual chat pace. Never sound robotic.

Your very first words in the conversation are always exactly: "Your wish is my command!"

Personality: you are a playful, good-natured genie from a magic lamp. Sprinkle in classic genie lines, about one every other reply, never more than one per reply, and don't repeat the same line twice in a row. Examples:
- "As you wish!"
- "Consider it granted!"
- "Ooh, a splendid wish!"
- "One magical card, coming right up!"
- "The lamp has spoken!"
- "Ten thousand years in a lamp, and this is my favorite kind of wish."
- "Noted, by the power of the lamp!"
Keep the flair light and quick; the questions still come first.
Never say "poof" (the app plays a magic sound at the end instead).

CRITICAL — only respond to clear English speech from the shopper.
- Ignore echo of your own voice, silence, background noise, music, and any non-English or garbled audio.
- Never invent names or details from nonsense syllables (examples: random Japanese/Chinese/Russian fragments).
- If you are unsure you heard real English, ask them to repeat in one short sentence — do not guess.

Your job is to fill a greeting-card form by talking with the shopper.
Essentials before finishing: senderName (already known for signed-in members), a clear recipientName (not a pronoun), occasion, and keyDetails (memories, inside jokes, what to celebrate).

NEVER ask about tone, mood, or image/art style. Those are optional.
- If the shopper volunteers a tone or style, capture it.
- If they do not mention them, leave them unset and do not bring them up.
- Do not say things like “what tone do you want” or “any art style”.

If the shopper does volunteer a tone, map it to one of: ${CARD_INTERVIEW_TONES.join(', ')}.
If they volunteer an image style, map it to the closest option from: ${CARD_INTERVIEW_IMAGE_STYLES.join('; ')}.

Pronouns like him/her/them are NOT names. If they say "him and Anita", ask for the real names before other gaps.
The relationship (recipientType) is optional. NEVER ask how they know the recipient or what the relationship is. Fill recipientType only if they mention it or it is obvious.
Never ask the shopper to repeat the same thing more than twice. After that, use your best understanding, or finish with what you have if the essentials are there.
If the shopper says they are done, wants to stop, or says goodbye, call update_card_details with what you know, say one short goodbye, and stop.
Ask for ALL remaining essential gaps (recipient name, occasion, key details, and sender only if unknown) in one short question when possible — never drip one field per turn.
${shopperNote}

As soon as you learn new fields, call update_card_details with whatever you know (partial updates are fine).
When essentials are complete, call complete_card_interview with the full details. After that tool returns, say exactly: "Consider it granted! I filled the form below. Review it, then create your card. Until your next wish!" Then stop talking.
Do not invent facts. Keep replies to 1–2 short sentences.`
}

const lampGenieRealtimeTools = [
  {
    type: 'function',
    name: 'update_card_details',
    description:
      'Save partial or full card form fields as soon as you learn them from the shopper.',
    parameters: {
      type: 'object',
      properties: {
        recipientName: { type: 'string' },
        recipientType: { type: 'string' },
        senderName: { type: 'string' },
        occasion: { type: 'string' },
        tone: { type: 'string', enum: CARD_INTERVIEW_TONES },
        imageStyle: { type: 'string', enum: CARD_INTERVIEW_IMAGE_STYLES },
        keyDetails: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'complete_card_interview',
    description:
      'Call when senderName, recipientName, occasion, and keyDetails are known. Do not wait for tone or image style. Pass the best-filled details.',
    parameters: {
      type: 'object',
      properties: {
        recipientName: { type: 'string' },
        recipientType: { type: 'string' },
        senderName: { type: 'string' },
        occasion: { type: 'string' },
        tone: { type: 'string', enum: CARD_INTERVIEW_TONES },
        imageStyle: { type: 'string', enum: CARD_INTERVIEW_IMAGE_STYLES },
        keyDetails: { type: 'string' },
      },
      required: ['recipientName', 'senderName', 'occasion', 'keyDetails'],
      additionalProperties: false,
    },
  },
]

/** Mint ephemeral Realtime client secret for Lamp Genie WebRTC (browser never sees OPENAI_API_KEY). */
const handleRealtimeSession = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const body = (await readJson(request)) || {}
  const shopperFirstName = String(body.shopperFirstName || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60)
  const requestedVoice = String(body.voice || env.OPENAI_TTS_VOICE || 'echo')
    .trim()
    .toLowerCase()
  const voice = REALTIME_VOICES.has(requestedVoice)
    ? requestedVoice
    : REALTIME_VOICE_FALLBACK[requestedVoice] || 'echo'
  const model = env.OPENAI_REALTIME_MODEL || 'gpt-realtime'

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': `cardgenie-lamp-${shopperFirstName || 'guest'}`.slice(0, 64),
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 60 },
        session: {
          type: 'realtime',
          model,
          instructions: buildLampGenieRealtimeInstructions(shopperFirstName),
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: {
                model: 'gpt-4o-transcribe',
                language: 'en',
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.7,
                prefix_padding_ms: 300,
                silence_duration_ms: 1600,
                create_response: false,
                interrupt_response: false,
              },
            },
            output: {
              voice,
            },
          },
          tools: lampGenieRealtimeTools,
          tool_choice: 'auto',
        },
      }),
    })

    const data = await response.json().catch(() => ({}))
    const value = String(data?.value || data?.client_secret?.value || '').trim()
    if (!response.ok || !value) {
      console.error('Realtime client_secrets failed', response.status, data)
      return jsonResponse(
        request,
        env,
        { error: data?.error?.message || 'Unable to start a secure voice session.' },
        response.status >= 400 ? response.status : 502,
      )
    }

    await recordUsage(env, USAGE_KINDS.realtimeSession)
    return jsonResponse(request, env, {
      ok: true,
      value,
      expires_at: data.expires_at || data.client_secret?.expires_at || null,
      model,
      voice,
    })
  } catch (error) {
    console.error(error)
    return jsonResponse(
      request,
      env,
      { error: publicGenerationError(error, 'Unable to start a secure voice session.') },
      isSafetyRejection(error) ? 400 : 500,
    )
  }
}

const LAMP_SESSION_LOG_PREFIX = 'lamp-session:'
const LAMP_SESSION_INDEX_KEY = 'lamp-session-index'
const LAMP_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

const normalizeLampSessionId = (value) =>
  String(value || '')
    .trim()
    .slice(0, 80)
    .replace(/[^a-zA-Z0-9_-]/g, '')

const LAMP_SESSION_MAX_BILLED_SECONDS = 30 * 60

const lampSessionElapsedSeconds = (record) => {
  if (!record || record.mode !== 'lamp') {
    return 0
  }
  const times = (Array.isArray(record.turns) ? record.turns : [])
    .map((turn) => Date.parse(turn?.at))
    .filter((value) => Number.isFinite(value))
  const ended = Date.parse(record.endedAt || '')
  if (Number.isFinite(ended)) {
    times.push(ended)
  }
  if (times.length < 2) {
    return 0
  }
  const elapsed = (Math.max(...times) - Math.min(...times)) / 1000
  return Math.min(LAMP_SESSION_MAX_BILLED_SECONDS, Math.max(0, elapsed))
}

const handleRealtimeSessionLog = async (request, env) => {
  if (!env.CARD_STORE) {
    return jsonResponse(request, env, { error: 'Session log store unavailable.' }, 503)
  }

  const body = (await readJson(request)) || {}
  const sessionId = normalizeLampSessionId(body.sessionId)
  if (!sessionId || sessionId.length < 8) {
    return jsonResponse(request, env, { error: 'Missing sessionId.' }, 400)
  }

  const incomingTurns = Array.isArray(body.turns) ? body.turns : []
  const normalizedIncoming = incomingTurns
    .map((entry) => ({
      role: ['user', 'assistant', 'system', 'junk'].includes(entry?.role) ? entry.role : 'system',
      text: String(entry?.text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000),
      at: String(entry?.at || new Date().toISOString()).slice(0, 40),
    }))
    .filter((entry) => entry.text)

  const key = `${LAMP_SESSION_LOG_PREFIX}${sessionId}`
  const existing = (await env.CARD_STORE.get(key, 'json')) || null
  const now = new Date().toISOString()
  const mode =
    String(body.mode || existing?.mode || '').toLowerCase() === 'ask' || sessionId.startsWith('ask')
      ? 'ask'
      : String(body.mode || existing?.mode || '').toLowerCase() === 'lamp' || sessionId.startsWith('lamp')
        ? 'lamp'
        : existing?.mode || (sessionId.startsWith('ask') ? 'ask' : 'lamp')

  // Append + dedupe so Ask Genie incremental posts don't wipe earlier turns.
  // Lamp Genie may resend the full transcript; keep the longer merged history.
  const merged = [...(Array.isArray(existing?.turns) ? existing.turns : [])]
  for (const turn of normalizedIncoming) {
    const already = merged.some(
      (entry) => entry.role === turn.role && entry.text === turn.text && entry.at === turn.at,
    )
    if (!already) {
      merged.push(turn)
    }
  }
  const turns = merged.slice(-120)

  const record = {
    id: sessionId,
    mode,
    startedAt: existing?.startedAt || now,
    updatedAt: now,
    endedAt: body.ended ? now : existing?.endedAt || null,
    shopperFirstName: String(body.shopperFirstName || existing?.shopperFirstName || '')
      .trim()
      .slice(0, 60),
    userAgent: String(body.userAgent || existing?.userAgent || '')
      .trim()
      .slice(0, 240),
    turns,
  }

  await env.CARD_STORE.put(key, JSON.stringify(record), {
    expirationTtl: LAMP_SESSION_TTL_SECONDS,
  })

  const addedSeconds = lampSessionElapsedSeconds(record) - lampSessionElapsedSeconds(existing)
  if (addedSeconds > 0) {
    await recordUsage(env, USAGE_KINDS.realtimeSeconds, { events: 0, units: addedSeconds })
  }

  const index = (await env.CARD_STORE.get(LAMP_SESSION_INDEX_KEY, 'json')) || []
  const nextIndex = [
    {
      id: sessionId,
      mode,
      updatedAt: now,
      endedAt: record.endedAt,
      turnCount: record.turns.length,
    },
    ...(Array.isArray(index) ? index.filter((entry) => entry?.id !== sessionId) : []),
  ].slice(0, 60)
  await env.CARD_STORE.put(LAMP_SESSION_INDEX_KEY, JSON.stringify(nextIndex), {
    expirationTtl: LAMP_SESSION_TTL_SECONDS,
  })

  return jsonResponse(request, env, { ok: true, sessionId, mode, turnCount: record.turns.length })
}

const CARD_HISTORY_PREFIX = 'card-history:'
const CARD_HISTORY_IMAGE_PREFIX = 'card-history-image:'
const CARD_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7
const CARD_HISTORY_DETAIL_FIELDS = [
  'recipientName',
  'recipientType',
  'senderName',
  'occasion',
  'tone',
  'length',
  'imageStyle',
  'keyDetails',
]
const CARD_HISTORY_IMAGE_KINDS = new Set(['generate', 'refine-image'])

const pickCardHistoryDetails = (details = {}) =>
  Object.fromEntries(
    CARD_HISTORY_DETAIL_FIELDS.map((field) => [field, String(details?.[field] ?? '').trim().slice(0, 2000)]),
  )

// Inverted timestamp so KV's ascending key order lists newest first.
const cardHistoryKey = (atMs, id) => `${CARD_HISTORY_PREFIX}${String(9_999_999_999_999 - atMs).padStart(13, '0')}:${id}`

const getRequestAccount = async (request, env) => {
  try {
    const session = await getAccountSession(env, readAccountToken(request))
    return { userId: session?.userId || '', phone: session?.phoneE164 || '' }
  } catch {
    return { userId: '', phone: '' }
  }
}

const recordCardHistory = async (env, entry = {}, imageUrl = '') => {
  if (!env.CARD_STORE) {
    return
  }

  try {
    const atMs = Date.now()
    const id = crypto.randomUUID()
    const details = pickCardHistoryDetails(entry.details)
    const refinement = String(entry.refinement || '').trim().slice(0, 1000)
    const photoCount = Number(entry.photoCount) || 0
    const hasImage = typeof imageUrl === 'string' && /^data:image\//.test(imageUrl)
    const record = {
      id,
      at: new Date(atMs).toISOString(),
      kind: entry.kind || 'generate',
      status: entry.status || 'ok',
      userId: entry.userId || '',
      phone: entry.phone || '',
      jobId: entry.jobId || '',
      cardId: entry.cardId || '',
      details,
      refinement,
      imageMode: entry.imageMode || '',
      photoCount,
      peopleOnCover: CARD_HISTORY_IMAGE_KINDS.has(entry.kind)
        ? photoCount > 0
          ? 'from-photos'
          : coverAllowsPeople(details, refinement)
            ? 'described'
            : 'none'
        : '',
      message: String(entry.message || '').slice(0, 4000),
      error: String(entry.error || '').slice(0, 500),
      hasImage,
    }

    await env.CARD_STORE.put(cardHistoryKey(atMs, id), JSON.stringify(record), {
      expirationTtl: CARD_HISTORY_TTL_SECONDS,
      metadata: {
        id,
        at: record.at,
        kind: record.kind,
        status: record.status,
        phone: record.phone,
        recipientName: details.recipientName.slice(0, 80),
        occasion: details.occasion.slice(0, 80),
      },
    })

    if (hasImage) {
      await env.CARD_STORE.put(`${CARD_HISTORY_IMAGE_PREFIX}${id}`, imageUrl, {
        expirationTtl: CARD_HISTORY_TTL_SECONDS,
      })
    }
  } catch (error) {
    console.error('card history write failed', error)
  }
}

const requireDeployOrAdminSecret = async (request, env) => {
  const expected = String(env.DEPLOY_NOTIFY_SECRET || env.ADMIN_SECRET || '').trim()
  const headerToken = readAccountToken(request)
  const querySecret = new URL(request.url).searchParams.get('secret') || ''
  const provided = String(headerToken || querySecret || '').trim()
  const secretOk = Boolean(expected && provided && provided === expected)
  if (secretOk || (await isAdminRequest(request, env))) {
    return null
  }
  return jsonResponse(request, env, { error: 'Not found.' }, 404)
}

const handleMigrateAssets = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  const body = (await readJson(request).catch(() => null)) || {}
  const result = await migrateAssetsToR2(env, {
    kind: Number(body.kind) || 0,
    cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
    deleteKv: body.deleteKv === true,
    limit: Math.min(100, Math.max(1, Number(body.limit) || 50)),
  })
  return jsonResponse(request, env, result)
}

const handleAdminLampSessions = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  if (!env.CARD_STORE) {
    return jsonResponse(request, env, { error: 'Session log store unavailable.' }, 503)
  }

  const url = new URL(request.url)
  const sessionId = normalizeLampSessionId(url.searchParams.get('id') || '')
  if (sessionId) {
    const record = await env.CARD_STORE.get(`${LAMP_SESSION_LOG_PREFIX}${sessionId}`, 'json')
    if (!record) {
      return jsonResponse(request, env, { error: 'Session not found.' }, 404)
    }
    return jsonResponse(request, env, { ok: true, session: record })
  }

  const index = (await env.CARD_STORE.get(LAMP_SESSION_INDEX_KEY, 'json')) || []
  return jsonResponse(request, env, {
    ok: true,
    sessions: Array.isArray(index) ? index.slice(0, 40) : [],
  })
}

const handleAdminResendCardEmail = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }

  const { cardId, to } = (await readJson(request)) || {}
  const record = await getCardRecord(env, String(cardId || '').trim())
  if (!record) {
    return jsonResponse(request, env, { error: 'Card not found.' }, 404)
  }

  let normalizedTo = ''
  try {
    normalizedTo = normalizeEmailAddress(String(to || ''))
  } catch (error) {
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Invalid email.' }, 400)
  }

  try {
    const copy = buildDeliveryCopy(record, getShareUrl(request, env, record.id), getEmailCoverUrl(request, env, record.id))
    const deliveredTo = await sendEmailDelivery({ env, to: normalizedTo, copy })
    return jsonResponse(request, env, { ok: true, deliveredTo, subject: copy.subject })
  } catch (error) {
    console.error('admin resend failed', error)
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to send.' }, 502)
  }
}

const handleAdminShoppers = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  const query = new URL(request.url).searchParams.get('q') || ''
  const shoppers = await listAdminShoppers(env, { query })
  const keepsakes = query.trim() ? { total: 0 } : await countRecipientPrintOrders(env)
  const keepsakeRow = keepsakes.total
    ? [
        {
          id: RECIPIENT_KEEPSAKE_SHOPPER_ID,
          phoneE164: keepsakes.recipientPhone || '',
          email: keepsakes.recipientEmail || '',
          preferredName: keepsakes.recipientName
            ? `Recipient keepsake: ${keepsakes.recipientName}${keepsakes.total > 1 ? ` +${keepsakes.total - 1} more` : ''}`
            : 'Recipient keepsake orders',
          mailingAddress: null,
          creditBalance: 0,
          createdAt: keepsakes.lastAt,
          lastUsedAt: keepsakes.lastAt,
          cardsCount: 0,
          printsCount: keepsakes.total,
          printsPending: keepsakes.pending,
          lastPrintAt: keepsakes.lastAt,
        },
      ]
    : []
  return jsonResponse(request, env, { ok: true, shoppers: [...keepsakeRow, ...shoppers] })
}

const RECIPIENT_KEEPSAKE_SHOPPER_ID = 'recipient-keepsakes'

const buildRecipientKeepsakeHistory = async (request, env) => {
  const orders = await listRecipientPrintOrders(env)
  const thumbs = await Promise.all(orders.map((order) => hasCoverThumb(env, order.cardId).catch(() => false)))
  return {
    ok: true,
    phoneE164: '',
    account: { preferredName: 'Recipient keepsake orders', email: '', creditBalance: 0, creditsPurchased: 0, creditsSpent: 0 },
    creditEvents: [],
    cards: [],
    deliveries: [],
    recipients: [],
    printOrders: orders.map((order, index) => ({
      ...order,
      coverThumbUrl: thumbs[index] ? getCoverThumbUrl(request, env, order.cardId) : '',
    })),
  }
}

const handleAdminShopperHistory = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  const shopperId = new URL(request.url).searchParams.get('id') || ''
  if (shopperId === RECIPIENT_KEEPSAKE_SHOPPER_ID) {
    return jsonResponse(request, env, await buildRecipientKeepsakeHistory(request, env))
  }
  const shopper = await getShopperById(env, shopperId)
  if (!shopper) {
    return jsonResponse(request, env, { error: 'Shopper not found.' }, 404)
  }
  const history = await getAccountHistory(env, shopper.id, shopper.phoneE164, { includeHidden: true })
  return jsonResponse(request, env, {
    ...(await buildAccountHistoryPayload(request, env, history, shopper.phoneE164)),
    recipients: await listRecipients(env, shopper.id),
  })
}

const handleAdminBackfillRecipients = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  const loadCardDetails = async (cardId) => {
    const record = await getCardRecord(env, cardId)
    if (record) {
      return recipientDetailsFor(record)
    }
    const row = await env.ACCOUNT_DB.prepare('SELECT recipient_name, occasion FROM cards WHERE id = ?').bind(cardId).first()
    return row ? { recipientName: row.recipient_name || '', occasion: row.occasion || '' } : null
  }
  const url = new URL(request.url)
  const result =
    url.searchParams.get('scope') === 'created'
      ? await backfillCreatedCardRecipients(env, { loadCardDetails })
      : await backfillRecipients(env, { loadCardDetails })
  return jsonResponse(request, env, { ok: true, ...result })
}

const SHIP_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const handleAdminUpdatePrintOrderShipping = async (request, env, orderNumber) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  const existing = await getPrintOrder(env, orderNumber)
  if (!existing) {
    return jsonResponse(request, env, { error: 'Order not found.' }, 404)
  }
  const body = (await readJson(request)) || {}
  const shipDate = String(body.shipDate || '').trim()
  const gcuOrderNumber = String(body.gcuOrderNumber || '').trim().slice(0, 80)
  if (shipDate && !SHIP_DATE_PATTERN.test(shipDate)) {
    return jsonResponse(request, env, { error: 'Enter the ship date as YYYY-MM-DD.' }, 400)
  }
  let order = await updatePrintOrderShipping(env, { orderNumber, shipDate, gcuOrderNumber })
  if (order?.shipmentEmailScheduledFor) {
    order = await setPrintOrderShipmentEmailSchedule(env, {
      orderNumber,
      scheduledFor: SHIP_DATE_PATTERN.test(order.shipDate) ? shipmentEmailSendTime(order.shipDate) : null,
    })
  }
  return jsonResponse(request, env, { ok: true, order })
}

const PACIFIC_TIME_ZONE = 'America/Los_Angeles'
const SHIPMENT_EMAIL_HOUR_PT = 10

const pacificDateKey = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

const pacificHourOn = (dateKey, hour) => {
  const [year, month, day] = dateKey.split('-').map(Number)
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + offsetHours))
    const localHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(
        candidate,
      ),
    )
    if (localHour === hour && pacificDateKey(candidate) === dateKey) {
      return candidate
    }
  }
  return new Date(Date.UTC(year, month - 1, day, hour + 8))
}

const shiftDateKey = (dateKey, days) => {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

// 10 AM Pacific on the ship date; if that has already passed, the next 10 AM Pacific.
const shipmentEmailSendTime = (shipDate, now = new Date()) => {
  const onShipDate = pacificHourOn(shipDate, SHIPMENT_EMAIL_HOUR_PT)
  if (onShipDate > now) {
    return onShipDate.toISOString()
  }
  const today = pacificDateKey(now)
  const todayAtHour = pacificHourOn(today, SHIPMENT_EMAIL_HOUR_PT)
  return (todayAtHour > now ? todayAtHour : pacificHourOn(shiftDateKey(today, 1), SHIPMENT_EMAIL_HOUR_PT)).toISOString()
}

const handleAdminSendShipmentEmail = async (request, env, orderNumber) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  const order = await getPrintOrder(env, orderNumber)
  if (!order) {
    return jsonResponse(request, env, { error: 'Order not found.' }, 404)
  }
  const body = (await readJson(request)) || {}
  const mode = ['schedule', 'cancel'].includes(body.mode) ? body.mode : 'now'
  if (mode === 'cancel') {
    const updated = await setPrintOrderShipmentEmailSchedule(env, { orderNumber, scheduledFor: null })
    return jsonResponse(request, env, { ok: true, order: updated })
  }
  if (!SHIP_DATE_PATTERN.test(order.shipDate) || !order.gcuOrderNumber) {
    return jsonResponse(request, env, { error: 'Save the ship date and GCU order number first.' }, 400)
  }
  if (!order.shopperEmail) {
    return jsonResponse(request, env, { error: 'This order has no shopper email.' }, 400)
  }
  if (mode === 'schedule') {
    const scheduledFor = shipmentEmailSendTime(order.shipDate)
    const updated = await setPrintOrderShipmentEmailSchedule(env, { orderNumber, scheduledFor })
    return jsonResponse(request, env, { ok: true, order: updated, scheduledFor, sentTo: order.shopperEmail })
  }

  try {
    await deliverShipmentEmail(env, order)
  } catch (error) {
    console.error('shipment email failed', error)
    return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to send.' }, 502)
  }

  const updated = await markPrintOrderShipmentEmailSent(env, { orderNumber, sentAt: new Date().toISOString() })
  return jsonResponse(request, env, { ok: true, order: updated, sentTo: order.shopperEmail })
}

const sendScheduledShipmentEmails = async (env) => {
  const due = await listDueShipmentEmailOrders(env, new Date().toISOString())
  for (const order of due) {
    if (!SHIP_DATE_PATTERN.test(order.shipDate) || !order.gcuOrderNumber || !order.shopperEmail) {
      console.error('scheduled shipment email skipped: missing details', order.orderCode)
      await setPrintOrderShipmentEmailSchedule(env, { orderNumber: order.orderNumber, scheduledFor: null })
      continue
    }
    try {
      await deliverShipmentEmail(env, order)
      await markPrintOrderShipmentEmailSent(env, { orderNumber: order.orderNumber, sentAt: new Date().toISOString() })
    } catch (error) {
      console.error('scheduled shipment email failed', order.orderCode, error)
    }
  }
}

const deliverShipmentEmail = async (env, order) => {
  const attachments = []
  const previews = await env.CARD_STORE?.get(`${PRINT_ORDER_PREVIEWS_PREFIX}${order.orderCode}`, 'json').catch(() => null)
  let cover = previews?.cover?.content ? previews.cover : null
  const inside = previews?.inside?.content ? previews.inside : null
  if (!cover && order.cardId) {
    const thumb = await getCoverThumbBytes(env, order.cardId).catch(() => null)
    if (thumb?.bytes?.length) {
      cover = { type: thumb.contentType || 'image/jpeg', content: arrayBufferToBase64(thumb.bytes) }
    }
  }
  if (cover) {
    attachments.push({
      filename: 'print-cover-thumb.jpg',
      type: cover.type || 'image/jpeg',
      content: cover.content,
      disposition: 'inline',
      contentId: 'print-cover-thumb',
    })
  }
  if (inside) {
    attachments.push({
      filename: 'print-inside-thumb.png',
      type: inside.type || 'image/png',
      content: inside.content,
      disposition: 'inline',
      contentId: 'print-inside-thumb',
    })
  }

  const copy = buildPrintOrderConfirmationCopy({
    orderCode: order.orderCode,
    shipTo: order.shipTo,
    mailFrom: order.mailFrom,
    shipment: { shipDate: order.shipDate, gcuOrderNumber: order.gcuOrderNumber },
    hasCoverPreview: Boolean(cover),
    hasInsidePreview: Boolean(inside),
  })

  await sendEmailDelivery({ env, to: order.shopperEmail, copy, attachments })
}

const handleAdminCardHistory = async (request, env) => {
  const denied = await requireDeployOrAdminSecret(request, env)
  if (denied) {
    return denied
  }
  if (!env.CARD_STORE) {
    return jsonResponse(request, env, { error: 'Card history store unavailable.' }, 503)
  }

  const url = new URL(request.url)
  const entryId = String(url.searchParams.get('id') || '').trim()

  if (entryId) {
    if (!/^[0-9a-f-]{36}$/i.test(entryId)) {
      return jsonResponse(request, env, { error: 'Invalid history id.' }, 400)
    }

    if (url.searchParams.get('image') === '1') {
      const dataUrl = await env.CARD_STORE.get(`${CARD_HISTORY_IMAGE_PREFIX}${entryId}`)
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '')
      if (!match) {
        return jsonResponse(request, env, { error: 'Image not found.' }, 404)
      }
      return new Response(base64ToUint8Array(match[2]), {
        headers: { ...getCorsHeaders(request, env), 'Content-Type': match[1], 'Cache-Control': 'private, max-age=300' },
      })
    }

    const page = await env.CARD_STORE.list({ prefix: CARD_HISTORY_PREFIX, limit: 1000 })
    const key = (page.keys || []).find((item) => item.name.endsWith(`:${entryId}`))
    const record = key ? await env.CARD_STORE.get(key.name, 'json') : null
    if (!record) {
      return jsonResponse(request, env, { error: 'History entry not found.' }, 404)
    }
    return jsonResponse(request, env, { ok: true, entry: record })
  }

  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
  const kindFilter = String(url.searchParams.get('kind') || '').trim()
  const phoneFilter = String(url.searchParams.get('phone') || '').replace(/[^\d+]/g, '')
  const query = String(url.searchParams.get('q') || '').trim().toLowerCase()
  const matches = []
  let cursor

  do {
    const page = await env.CARD_STORE.list({ prefix: CARD_HISTORY_PREFIX, limit: 1000, cursor })
    for (const key of page.keys || []) {
      const meta = key.metadata || {}
      if (kindFilter && meta.kind !== kindFilter) continue
      if (phoneFilter && !String(meta.phone || '').includes(phoneFilter)) continue
      if (query && !`${meta.recipientName || ''} ${meta.occasion || ''}`.toLowerCase().includes(query)) continue
      matches.push(key.name)
      if (matches.length >= limit) break
    }
    cursor = page.list_complete || matches.length >= limit ? undefined : page.cursor
  } while (cursor)

  const entries = []
  for (let index = 0; index < matches.length; index += 25) {
    const batch = await Promise.all(
      matches.slice(index, index + 25).map((name) => env.CARD_STORE.get(name, 'json')),
    )
    entries.push(...batch.filter(Boolean))
  }

  return jsonResponse(request, env, { ok: true, retentionDays: 7, count: entries.length, entries })
}

/** Durable Chrome mic path: MediaRecorder chunks → Whisper (no SpeechRecognition restart). */
const handleCardInterviewTranscribe = async (request, env) => {
  const missingKeyResponse = requireOpenAIKey(request, env)
  if (missingKeyResponse) {
    return missingKeyResponse
  }

  const body = (await readJson(request)) || {}
  const audioBase64 = String(body.audioBase64 || body.audio || '').replace(/\s+/g, '')
  const mimeType = String(body.mimeType || 'audio/webm').trim() || 'audio/webm'
  const prompt = String(body.prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)

  if (!audioBase64 || audioBase64.length < 64) {
    return jsonResponse(request, env, { error: 'Nothing to transcribe.' }, 400)
  }

  // Cap ~2.5MB raw audio after base64 decode.
  if (audioBase64.length > 3_500_000) {
    return jsonResponse(request, env, { error: 'Audio chunk is too large.' }, 413)
  }

  try {
    const binary = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0))
    if (binary.byteLength < 256) {
      return jsonResponse(request, env, { ok: true, text: '' })
    }
    const extension = /mp4|m4a|aac/i.test(mimeType)
      ? 'mp4'
      : /ogg/i.test(mimeType)
        ? 'ogg'
        : /wav/i.test(mimeType)
          ? 'wav'
          : 'webm'
    const file = new File([binary], `interview-chunk.${extension}`, {
      type: mimeType.includes('/') ? mimeType : `audio/${extension}`,
    })
    const openai = getOpenAI(env)
    const model = env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1'
    const transcription = await openai.audio.transcriptions.create({
      file,
      model,
      language: 'en',
      ...(prompt ? { prompt } : {}),
    })
    const text = String(transcription?.text || '')
      .replace(/\s+/g, ' ')
      .trim()
    return jsonResponse(request, env, { ok: true, text })
  } catch (error) {
    console.error(error)
    const message = error instanceof Error ? error.message : String(error || '')
    // MediaRecorder often sends incomplete slices; treat as empty rather than alarming the UI.
    if (/invalid file format|unsupported|corrupt|empty|could not be decoded/i.test(message)) {
      return jsonResponse(request, env, { ok: true, text: '', skipped: true })
    }
    return jsonResponse(
      request,
      env,
      { error: publicGenerationError(error, 'Unable to transcribe that audio.') },
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

  const gcuPath = matchGcuPath(url.pathname)
  if (gcuPath) {
    return handleGcuRequest(request, env, url, gcuPath, getCorsHeaders(request, env), {
      getSession: (req) => getAccountSession(env, readAccountToken(req)),
      normalizeEmailAddress,
      normalizePhoneNumber,
      sendEmailDelivery,
      sendTextDelivery,
      escapeHtml,
    })
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

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    return handleAccountLogout(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/account') {
    return handleGetAccount(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/account/profile') {
    return handleUpdateAccountProfile(request, env)
  }

  const accountCardMatch = url.pathname.match(/^\/api\/account\/cards\/([^/]+)$/)
  if (request.method === 'GET' && accountCardMatch) {
    return handleGetAccountCard(request, env, decodeURIComponent(accountCardMatch[1]))
  }

  if (request.method === 'POST' && url.pathname === '/api/account/cards/hide') {
    return handleHideAccountCards(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/account/history') {
    return handleGetAccountHistory(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/grant-credits') {
    return handleAdminGrantCredits(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/deploy-summary') {
    return handleAdminDeploySummary(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/resend-card-email') {
    return handleAdminResendCardEmail(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/recipient-print/checkout') {
    return handleRecipientPrintCheckout(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/account/recipients') {
    return handleListRecipients(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/account/recipients/photo') {
    return handleGetRecipientPhoto(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/account/recipients/update') {
    return handleUpdateRecipient(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/account/recipients/delete') {
    return handleDeleteRecipient(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/account/recipients/photo-delete') {
    return handleDeleteRecipientPhoto(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/backfill-recipients') {
    return handleAdminBackfillRecipients(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/gcu-artist-payouts') {
    if (!(await isAdminRequest(request, env))) {
      return jsonResponse(request, env, { error: 'Not found.' }, 404)
    }
    try {
      const report = await getArtistPayouts(env, url.searchParams.get('quarter') || currentQuarter())
      return jsonResponse(request, env, { ok: true, currentQuarter: currentQuarter(), ...report })
    } catch (error) {
      return jsonResponse(request, env, { error: error instanceof Error ? error.message : 'Unable to load payouts.' }, 400)
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/shoppers') {
    return handleAdminShoppers(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/shopper-history') {
    return handleAdminShopperHistory(request, env)
  }

  const adminPrintOrderMatch = url.pathname.match(/^\/api\/admin\/print-orders\/(\d+)\/(shipping|shipment-email)$/)
  if (request.method === 'POST' && adminPrintOrderMatch) {
    return adminPrintOrderMatch[2] === 'shipping'
      ? handleAdminUpdatePrintOrderShipping(request, env, Number(adminPrintOrderMatch[1]))
      : handleAdminSendShipmentEmail(request, env, Number(adminPrintOrderMatch[1]))
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/migrate-assets') {
    return handleMigrateAssets(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/backfill-cover-thumbs') {
    return handleBackfillCoverThumbs(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/metrics') {
    return handleGetAdminMetrics(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/costs') {
    return handleGetAdminCosts(request, env)
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

  if (request.method === 'POST' && url.pathname === '/api/card-interview-transcribe') {
    return handleCardInterviewTranscribe(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/realtime/session') {
    return handleRealtimeSession(request, env)
  }

  if (request.method === 'POST' && url.pathname === '/api/realtime/session-log') {
    return handleRealtimeSessionLog(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/lamp-sessions') {
    return handleAdminLampSessions(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/card-history') {
    return handleAdminCardHistory(request, env)
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
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendScheduledShipmentEmails(env))
  },
}
