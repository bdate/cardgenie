// Occasion list and type-ahead suggestions shared by the card form and the welcome page.

export const commonOccasions = [
  'Birthday',
  'Thank you',
  'Anniversary',
  'Get well',
  'Sympathy',
  'Congratulations',
  'Graduation',
  'Wedding',
  'Engagement',
  'New baby',
  'Baby shower',
  'Bridal shower',
  'Retirement',
  'New job',
  'Promotion',
  'Work anniversary',
  'Welcome to the team',
  'Farewell',
  'Good luck',
  'Bon voyage',
  'Welcome home',
  'Housewarming',
  'Just because',
  'Thinking of you',
  'Miss you',
  'Love you',
  'Friendship',
  'Encouragement',
  'Apology',
  'Pet sympathy',
  'Teacher appreciation',
  'Nurse appreciation',
  'Boss’s Day',
  'Valentine’s Day',
  'Mother’s Day',
  'Father’s Day',
  'Grandparents Day',
  'Easter',
  'Passover',
  'Thanksgiving',
  'Halloween',
  'Christmas',
  'Hanukkah',
  'Happy holidays',
  'New Year',
  'St. Patrick’s Day',
  'Diwali',
  'Eid',
  'Lunar New Year',
  'Bar mitzvah',
  'Bat mitzvah',
  'Quinceañera',
  'First communion',
  'Baptism',
]

// Keep in sync with the invitation types on the /invitations/ page (scripts/occasion-pages/occasions.mjs).
const invitationOccasions = [
  'Invitation',
  'Party invitation',
  'Birthday party invitation',
  'Kids’ birthday party invitation',
  'Milestone birthday invitation',
  'Surprise party invitation',
  'Save the date',
  'Wedding invitation',
  'Engagement party invitation',
  'Bridal shower invitation',
  'Bachelorette party invitation',
  'Rehearsal dinner invitation',
  'Anniversary party invitation',
  'Baby shower invitation',
  'Gender reveal invitation',
  'Baptism invitation',
  'First communion invitation',
  'Bar mitzvah invitation',
  'Bat mitzvah invitation',
  'Quinceañera invitation',
  'Graduation party invitation',
  'Retirement party invitation',
  'Housewarming invitation',
  'Celebration of life invitation',
  'Dinner party invitation',
  'Cocktail party invitation',
  'BBQ invitation',
  'Brunch invitation',
  'Game night invitation',
  'Holiday party invitation',
  'Halloween party invitation',
  'New Year’s Eve party invitation',
  'Business event invitation',
  'Office party invitation',
]
commonOccasions.push(...invitationOccasions)

const ordinalSuffix = (n: number) => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][n % 10] || 'th'
}

export const normalizeOccasion = (value: string) =>
  value
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const formatOccasionLabel = (value: string) => {
  const trimmed = value.trim()
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : ''
}

const MAX_OCCASION_SUGGESTIONS = 7

export const buildOccasionSuggestions = (typed: string, popular: { label: string; uses: number }[]) => {
  const query = normalizeOccasion(typed)
  if (!query) return []
  const uses = new Map<string, number>()
  const labels = new Map<string, string>()
  commonOccasions.forEach((label) => labels.set(normalizeOccasion(label), label))
  popular.forEach((entry) => {
    const key = normalizeOccasion(entry.label)
    if (!key) return
    uses.set(key, (uses.get(key) || 0) + entry.uses)
    if (!labels.has(key)) labels.set(key, formatOccasionLabel(entry.label))
  })
  const number = query.match(/^(\d{1,3})(st|nd|rd|th)?\b/)
  if (number) {
    const n = Number(number[1])
    if (n > 0) {
      for (const kind of ['birthday', 'anniversary']) {
        const label = `${n}${ordinalSuffix(n)} ${kind}`
        if (!labels.has(normalizeOccasion(label))) labels.set(normalizeOccasion(label), formatOccasionLabel(label))
      }
    }
  }
  const scored: { label: string; score: number }[] = []
  labels.forEach((label, key) => {
    if (key === query) return
    let rank = -1
    if (key.startsWith(query)) rank = 3
    else if (key.split(' ').some((word) => word.startsWith(query))) rank = 2
    else if (query.length >= 3 && key.includes(query)) rank = 1
    if (rank < 0) return
    scored.push({ label, score: rank * 10000 + (uses.get(key) || 0) * 10 - key.length })
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OCCASION_SUGGESTIONS)
    .map((entry) => entry.label)
}
