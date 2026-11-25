/** Decides which sender notes may be lettered on a cover, and which are scene direction only. */

const insideMessageMarker = '\n\nCurrent inside message:'
const maxCoverLineWords = 8

const dedicationPattern =
  /^(?:i|we)\s+(?:love|miss)\s+you\b|^(?:love|miss)\s+you\b|^(?:i\s+)?thanks?(?:\s+you)?\b|^thinking of you\b|^with (?:all my )?love\b|^(?:i am |i'm |we are |we're )?proud of you\b|^congratulations\b|^congrats\b|^happy\s+[a-z]/i

const lovesYouPattern =
  /^(?:she|he|they|[a-z][a-z'-]*)\s+(?:loves|misses)\s+(?:you|ya|mom|dad|mama|papa|her|him|them|us)\b/i

const interestInventoryPattern =
  /\b(?:loves?|likes?|enjoys?|favorites?|favourites?|hobbies|hobby|obsessed with|collects?|into)\b/i

const coverInstructionPattern =
  /\b(?:write|put|add|letter|print|include|say)\b[^.]{0,40}\b(?:on the (?:front|cover)|cover text)\b|\bon the (?:front|cover)\b[^.]{0,40}\b(?:write|put|add|letter|print|say)\b/i

const eventTitlePattern =
  /\b(?:birthday|party|wedding|shower|reunion|anniversary|invitation|invited|join us|save the date)\b/i

const appearancePattern =
  /\b(?:tall|petite|slim|hair|eyes?|glasses|beard|blonde?|brunette)\b/i

const wordsOf = (sentence = '') =>
  String(sentence || '')
    .replace(/[.!?]+$/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

const unique = (lines) => {
  const seen = new Set()
  const result = []
  for (const line of lines) {
    const key = line.toLowerCase()
    if (!line || seen.has(key)) continue
    seen.add(key)
    result.push(line)
  }
  return result
}

export const coverNotesWithoutInsideMessage = (keyDetails = '') => {
  const raw = String(keyDetails || '')
  const index = raw.indexOf(insideMessageMarker)
  return (index === -1 ? raw : raw.slice(0, index)).trim()
}

export const coverNoteSentences = (text = '') =>
  String(text || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

export const isInterestInventory = (sentence = '') => {
  const trimmed = String(sentence || '').trim()
  if (!interestInventoryPattern.test(trimmed)) return false
  if (lovesYouPattern.test(trimmed) && wordsOf(trimmed).length <= 6 && !/,/.test(trimmed)) return false
  if (dedicationPattern.test(trimmed) && wordsOf(trimmed).length <= maxCoverLineWords && !/,/.test(trimmed)) {
    return false
  }
  return true
}

const cleanCoverLine = (sentence = '') =>
  String(sentence || '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()

export const isCoverLettering = (sentence = '', { invitation = false } = {}) => {
  const cleaned = cleanCoverLine(sentence)
  const count = wordsOf(cleaned).length
  if (!cleaned || count > maxCoverLineWords) return false
  if (coverInstructionPattern.test(cleaned)) return false
  if (isInterestInventory(sentence)) return false
  if (appearancePattern.test(cleaned) && !dedicationPattern.test(cleaned)) return false
  if (invitation) return eventTitlePattern.test(cleaned)
  return dedicationPattern.test(cleaned) || lovesYouPattern.test(cleaned)
}

export const sceneDirectionFor = (sentence = '') => {
  const trimmed = String(sentence || '').trim()
  if (isInterestInventory(trimmed)) {
    const listed = trimmed
      .replace(/^.*?\b(?:loves?|likes?|enjoys?|favorites?|favourites?|obsessed with|into)\b/i, '')
      .replace(/\b(?:and|or)\b/gi, ',')
      .replace(/[.!?]+$/g, '')
      .replace(/\s+,/g, ',')
      .replace(/\s+/g, ' ')
      .trim()
    return listed
      ? `Show in the picture, as objects or activities, not as written words: ${listed}`
      : trimmed
  }
  if (appearancePattern.test(trimmed) && !dedicationPattern.test(trimmed) && !lovesYouPattern.test(trimmed)) {
    return `Show this look in the picture, and do not write it: ${cleanCoverLine(trimmed)}`
  }
  return trimmed
}

const requestedLineFrom = (raw = '') => {
  const cleaned = cleanCoverLine(raw)
  if (!cleaned || wordsOf(cleaned).length > maxCoverLineWords) return ''
  if (isInterestInventory(cleaned)) return ''
  return cleaned
}

export const extractRequestedCoverLines = (text = '') => {
  const source = String(text || '')
  const lines = []
  const patterns = [
    /\b(?:write|put|add|letter|print|include)\s+(?:the words?\s+)?["“]([^"”]{1,48})["”]/gi,
    /\b(?:write|put|add|letter|print)\s+(?:the words?\s+)?["“]?([^"”.\n]{1,48})["”]?\s+on the (?:front|cover)/gi,
    /\bon the (?:front|cover)\s*[:,-]?\s*["“]([^"”]{1,48})["”]/gi,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = requestedLineFrom(match[1])
      if (line) lines.push(line)
    }
  }
  return unique(lines)
}

export const classifyCoverNotes = (keyDetails = '', refinement = '', { invitation = false } = {}) => {
  const lettering = []
  const scene = []
  for (const sentence of coverNoteSentences(coverNotesWithoutInsideMessage(keyDetails))) {
    if (isCoverLettering(sentence, { invitation })) {
      lettering.push(cleanCoverLine(sentence))
      continue
    }
    if (coverInstructionPattern.test(sentence)) continue
    scene.push(sceneDirectionFor(sentence))
  }
  lettering.push(...extractRequestedCoverLines(`${keyDetails}\n${refinement || ''}`))
  return {
    lettering: unique(lettering).slice(0, 2),
    scene,
  }
}

export const buildCoverContextBlock = (details = {}, refinement = '', { invitation = false } = {}) => {
  const { lettering, scene } = classifyCoverNotes(details.keyDetails, refinement, { invitation })
  const sceneLines = scene.length
    ? scene.map((line) => `- ${line}`).join('\n')
    : '- Use the occasion, relationship, and tone.'
  const extra = lettering.length
    ? `The sender wrote short lines that belong on the front. You may letter only these, besides the occasion greeting: ${lettering
        .map((line) => `"${line}"`)
        .join('; ')}.`
    : 'Do not add any other words. Personal notes are not cover copy.'

  return `Scene direction (draw these; never spell them out as text, captions, subtitles, or notes):
${sceneLines}

Cover lettering rules:
- Readable text is limited to one short occasion greeting, the recipient's first name when it fits the occasion, and the extra lines listed here.
- ${extra}
- Interests, favorites, pets, vehicles, food, and hobbies belong in the picture as objects and activities. They do not belong as a written sentence under the greeting.
- No second block of text under the greeting, and no handwriting of the sender's notes.`
}
