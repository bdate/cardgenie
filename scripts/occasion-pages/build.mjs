// Builds the occasion landing pages, the /occasions/ hub, and sitemap.xml from occasions.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { occasions, STYLE_TAGS } from './occasions.mjs'

const SITE = 'https://www.card-genie.com'
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '../../public')
const css = readFileSync(join(here, 'page.css'), 'utf8')
const messagesPath = join(here, 'messages.json')
const messages = existsSync(messagesPath) ? JSON.parse(readFileSync(messagesPath, 'utf8')) : {}

const esc = (value = '') =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const indent = (text, spaces) =>
  text
    .split('\n')
    .map((line) => (line ? ' '.repeat(spaces) + line : line))
    .join('\n')

const insideQuote = (page, sample) => {
  if (sample.inside) return sample.inside
  const generated = messages[`${page.slug}/${sample.slug}`]
  const text = generated?.variants?.medium || generated?.message || ''
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text]
  let quote = ''
  for (const sentence of sentences) {
    if (quote && (quote + sentence).length > 170) break
    quote += sentence
  }
  return quote.trim()
}

const head = ({ title, description, url, image, jsonLd }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Card Genie" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${image}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Inter:wght@400;600;700;800&family=Playfair+Display:wght@700;800&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/brand-header.css" />
    <script type="application/ld+json">
${indent(JSON.stringify(jsonLd, null, 2), 6)}
    </script>
    <style>
${indent(css.trimEnd(), 6)}
    </style>
  </head>
  <body>
    <main>
      <header class="cg-header">
        <a class="cg-brand" href="/" aria-label="Card Genie home"><img src="/logo-mark.png" alt="" width="72" height="72" /><span>Card Genie</span></a>
        <a class="cg-powered" href="https://www.greetingcarduniverse.com" target="_blank" rel="noreferrer">Powered by GreetingCardUniverse.com</a>
      </header>
`

const footer = `
      <footer>
        <a href="/">Card Genie</a>
        <a href="/occasions/">All occasions</a>
        <a href="/styles/">Art styles</a>
        <a href="/faq/">FAQ</a>
        <a href="/?contact=general">Contact us</a>
        <a href="/?reviews=1">Reviews</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
      </footer>
    </main>
  </body>
</html>
`

const breadcrumbs = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, item], index) => ({ '@type': 'ListItem', position: index + 1, name, item })),
})

const makeHref = (page) => `/?occasion=${encodeURIComponent(page.occasion)}`

const renderPage = (page) => {
  const url = `${SITE}/${page.slug}/`
  const missing = page.samples.filter((s) => !existsSync(join(publicDir, page.slug, 'img', `${s.slug}.jpg`)))
  if (missing.length) throw new Error(`${page.slug}: missing art for ${missing.map((s) => s.slug).join(', ')}`)

  const figures = page.samples
    .map((sample, index) => {
      const quote = insideQuote(page, sample)
      return `        <figure>
          <img
            src="img/${sample.slug}.jpg"
            alt="${esc(sample.alt)}"
            width="528"
            height="736"
            loading="${index < 3 ? 'eager' : 'lazy'}"
          />
          <figcaption>
            <span class="tag">${esc(STYLE_TAGS[sample.imageStyle] || sample.imageStyle)}</span>
            <strong>${esc(sample.title)}</strong>
            <p class="story">The story: ${esc(sample.story)}</p>${quote ? `\n            <p class="inside">“${esc(quote)}”</p>` : ''}
          </figcaption>
        </figure>`
    })
    .join('\n')

  const ideas = page.ideas
    .map(
      (idea) => `        <div class="idea">
          <h3>${esc(idea.who)}</h3>
          <p>${esc(idea.tip)}</p>
          <blockquote>“${esc(idea.line)}”</blockquote>
        </div>`,
    )
    .join('\n')

  const faqs = page.faqs
    .map(
      (faq) => `        <details>
          <summary>${esc(faq.q)}</summary>
          <p>${esc(faq.a)}</p>
        </details>`,
    )
    .join('\n')

  const others = occasions
    .filter((other) => other.slug !== page.slug)
    .map((other) => `        <a href="/${other.slug}/">${esc(other.name)}</a>`)
    .join('\n')

  return (
    head({
      title: page.title,
      description: page.description,
      url,
      image: `${SITE}/${page.slug}/img/${page.samples[0].slug}.jpg`,
      jsonLd: breadcrumbs([
        ['Card Genie', `${SITE}/`],
        ['Occasions', `${SITE}/occasions/`],
        [`${page.name} cards`, url],
      ]),
    }) +
    `
      <section class="hero">
        <h1>${esc(page.h1)}</h1>
        <p class="lede">${esc(page.lede)}</p>
        <a class="cta" href="${makeHref(page)}">${esc(page.cta)}</a>
        <p class="cta-note">Creating a card is free, and so is your first send.</p>
      </section>

      <h2>${esc(page.galleryHeading)}</h2>
      <p class="section-intro">
        Every card starts from a few details. Here’s what Card Genie made from each story — the cover art and the
        inside message.
      </p>
      <div class="gallery">
${figures}
      </div>
      <p class="section-intro" style="margin-top: 16px">
        People and stories above are made up for these examples. See all 15 art styles in the
        <a href="/styles/">style lookbook</a>.
      </p>

      <h2>How it works</h2>
      <ol class="steps">
        <li>
          <strong>Tell Genie about them</strong>
          <p>Fill in a few fields or just chat with Genie: their name, what they love, a memory, and how they look.</p>
        </li>
        <li>
          <strong>Get your card in minutes</strong>
          <p>Custom cover art in the style you pick, plus a message written for them. Revise anything you like.</p>
        </li>
        <li>
          <strong>Send it your way</strong>
          <p>By email or text for instant delivery, or printed on cardstock and mailed by USPS.</p>
        </li>
      </ol>

      <h2>${esc(page.writeHeading)}</h2>
      <p class="section-intro">${esc(page.writeIntro)}</p>
      <div class="ideas">
${ideas}
      </div>

      <h2>${esc(page.name)} card questions</h2>
      <div class="faq">
${faqs}
      </div>

      <section class="closing">
        <h2>${esc(page.closingHeading)}</h2>
        <p>A few details are all it takes. Your first card is free.</p>
        <a class="cta" href="${makeHref(page)}">${esc(page.cta)}</a>
      </section>

      <h2>Cards for every occasion</h2>
      <div class="more">
${others}
      </div>
` +
    footer
  )
}

const renderHub = () => {
  const url = `${SITE}/occasions/`
  const tiles = occasions
    .map(
      (page, index) => `        <a href="/${page.slug}/">
          <img src="/${page.slug}/img/${page.samples[0].slug}.jpg" alt="" width="528" height="560" loading="${index < 6 ? 'eager' : 'lazy'}" />
          <span>${esc(page.name)} cards</span>
        </a>`,
    )
    .join('\n')
  return (
    head({
      title: 'Personalized Cards for Every Occasion | Card Genie',
      description:
        'Birthday, thank you, anniversary, sympathy, holidays, and more: make a one-of-a-kind card with custom artwork and a message written just for them.',
      url,
      image: `${SITE}/og-image.png`,
      jsonLd: breadcrumbs([
        ['Card Genie', `${SITE}/`],
        ['Occasions', url],
      ]),
    }) +
    `
      <section class="hero">
        <h1>Personalized cards for every occasion</h1>
        <p class="lede">
          Pick an occasion to see cards Card Genie has made, ideas for what to write, and answers to common questions.
          Don’t see yours? Card Genie makes a card for anything — just type the occasion when you start.
        </p>
        <a class="cta" href="/">Make a card</a>
      </section>

      <div class="hub">
${tiles}
      </div>
` +
    footer
  )
}

const writePage = (slug, html) => {
  mkdirSync(join(publicDir, slug), { recursive: true })
  writeFileSync(join(publicDir, slug, 'index.html'), html)
}

const built = []
for (const page of occasions) {
  try {
    writePage(page.slug, renderPage(page))
    built.push(page.slug)
  } catch (error) {
    console.log('SKIPPED', error.message)
  }
}
writePage('occasions', renderHub())

const sitemapUrls = [
  ['/', 'weekly', '1.0'],
  ['/occasions/', 'monthly', '0.9'],
  ...built.map((slug) => [`/${slug}/`, 'monthly', '0.8']),
  ['/styles/', 'monthly', '0.7'],
  ['/faq/', 'monthly', '0.6'],
  ['/terms/', 'yearly', '0.3'],
  ['/privacy/', 'yearly', '0.3'],
]
writeFileSync(
  join(publicDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls
  .map(
    ([path, freq, priority]) => `  <url>
    <loc>${SITE}${path}</loc>
    <changefreq>${freq}</changefreq>
    <priority>${priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`,
)
console.log(`built ${built.length} occasion pages + hub + sitemap`)
