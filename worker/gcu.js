// www.card-genie.com/gcu/<card#> (any case; index.html loads this page from api.card-genie.com):
// envelope reveal for a GreetingCardUniverse card.
// The page opens as a GCU-style product page; "Send Card Digitally Now" builds the envelope reveal
// and lets a signed-in Card Genie user send it by email or text (recipients open /gcu/<card#>?s=<id>).
// The worker scrapes the product once and keeps it in D1; the visitor's browser re-typesets the
// inside message at print size (it needs canvas + web fonts) and uploads it to KV for next time.
import { ensureAccountUser, getAccountForSession } from './account-db.js'
import { getAsset, putAsset } from './assets.js'
import pageHtml from './gcu-page.html'

const SITE = 'https://www.greetingcarduniverse.com'
// Bump when the browser-side inside renderer changes so stored inside images are rebuilt.
const INSIDE_VERSION = 4
// Bump when scrape() collects new product-page fields so cached rows are refreshed on next visit.
const DETAILS_VERSION = 3
const MAX_INSIDE_BYTES = 6 * 1024 * 1024
const insideAsset = (pid) => ({ r2Key: `gcu/inside/${pid}.jpg`, kvKey: `gcu:inside:${pid}` })
// GCU's bot protection challenges clients that claim to be a browser but don't act like one.
const GCU_HEADERS = { 'User-Agent': 'CardGenie/1.0 (+https://www.card-genie.com)', Accept: '*/*' }
// Same price as a single-recipient send in the main app.
const SEND_CREDIT_COST = 3
const SENDS_PER_HOUR = 10

export const matchGcuPath = (pathname) => {
  const tab = pathname.match(/^\/gcu\/0*(\d{1,10})\/tab\/([234])\/?$/i)
  if (tab) return { pid: tab[1], action: 'tab', id: tab[2] }
  const m = pathname.match(/^\/gcu\/0*(\d{1,10})(?:\/(info|preview|inside|inside\.jpg|send|gift)(?:\/([A-Za-z0-9]{6,24}))?)?\/?$/i)
  return m ? { pid: m[1], action: (m[2] || 'page').toLowerCase(), id: m[3] || null } : null
}

const DETAIL_COLUMNS = {
  price: 'TEXT',
  artist: 'TEXT',
  artist_url: 'TEXT',
  artist_notes: 'TEXT',
  size_text: 'TEXT',
  customize: 'TEXT',
  categories_json: 'TEXT',
  image3d_url: 'TEXT',
  // Everything else the product-page replica shows (back image, price tiers, related cards, testimonials…).
  extra_json: 'TEXT',
  details_version: 'INTEGER NOT NULL DEFAULT 0',
}

let tableReady = false
const ensureTable = async (db) => {
  if (tableReady) return
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS gcu_cards (
        pid TEXT PRIMARY KEY,
        title TEXT,
        product_url TEXT,
        front_url TEXT,
        inside_preview_url TEXT,
        inside_lines_json TEXT,
        landscape INTEGER,
        front_w INTEGER,
        front_h INTEGER,
        inside_ready INTEGER NOT NULL DEFAULT 0,
        inside_version INTEGER NOT NULL DEFAULT 0,
        inside_font TEXT,
        inside_color TEXT,
        inside_align TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS gcu_sends (
        id TEXT PRIMARY KEY,
        pid TEXT NOT NULL,
        user_id TEXT NOT NULL,
        method TEXT NOT NULL,
        destination TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_name TEXT,
        note TEXT,
        status TEXT NOT NULL,
        error TEXT,
        open_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        opened_at TEXT
      )`,
    ),
    db.prepare('CREATE INDEX IF NOT EXISTS gcu_sends_user_created ON gcu_sends (user_id, created_at)'),
  ])
  const { results } = await db.prepare('PRAGMA table_info(gcu_cards)').all()
  const have = new Set(results.map((c) => c.name))
  for (const [name, type] of Object.entries(DETAIL_COLUMNS)) {
    if (have.has(name)) continue
    // Another isolate may add the column first.
    await db.prepare(`ALTER TABLE gcu_cards ADD COLUMN ${name} ${type}`).run().catch((error) => {
      if (!/duplicate column/i.test(String(error?.message))) throw error
    })
  }
  tableReady = true
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&[lr]squo;/g, "'")
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/&[mn]dash;/g, '–')
    .replace(/&amp;/g, '&')

const parseZoom = (zoom) => {
  const paths = {}
  for (const side of ['front', 'inside', 'back']) {
    const m = zoom.match(new RegExp(`${side}_img\\.src\\s*=\\s*"([^"?]+)`))
    paths[side] = m ? `${SITE}${m[1]}` : null
  }
  return paths
}

const parseInsideText = (page) => {
  const t = page.match(/Inside Text:\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i)
  if (!t) return []
  const lines = t[1].split(/<br\s*\/?>/i).map((s) => decodeEntities(s.replace(/<[^>]+>/g, '')).trim())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  while (lines.length && !lines[0]) lines.shift()
  return lines
}

const parseTitle = (page, pid) => {
  const h1 = page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const title = page.match(/<title>([\s\S]*?)<\/title>/i)
  const raw = h1 ? h1[1] : title ? title[1].replace(new RegExp(`\\s*\\(${pid}\\)\\s*$`), '') : ''
  return decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

const cleanText = (html) => decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

// The "Details" tab rows: <div class="detailsL">Label:</div><div>value</div>
const detailHtml = (page, label) => {
  const m = page.match(new RegExp(`class="detailsL"[^>]*>\\s*${label}:\\s*</div>\\s*<div[^>]*>([\\s\\S]*?)</div>`, 'i'))
  return m ? m[1] : ''
}

const absolute = (href) => (href ? new URL(decodeEntities(href), SITE).href : null)

const parseDetails = (page) => {
  const priceText = detailHtml(page, 'Price').match(/\$\s*([\d,]+\.\d{2})/)
  const trackedPrice = page.match(/\bPrice:\s*([\d.]+)\s*}/)
  const artistHtml = detailHtml(page, 'Artist')
  const artistLink = artistHtml.match(/<a[^>]*href="([^"]*)"/i)
  const crumbs = page.match(/<\/h1>[\s\S]{0,400}?<div colspan=2>([\s\S]*?)<\/div>/i)
  const categories = crumbs
    ? [...crumbs[1].matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map(([, href, name]) => ({ name: cleanText(name), url: absolute(href) }))
    : []
  const image3d = page.match(/<img\s+id\s*=\s*"image1"\s+src\s*=\s*"([^"]+)"/i)
  const tiersHtml = page.match(/class="popoverdiv prices_popover">([\s\S]*?)<\/table>/i)
  const tiers = tiersHtml
    ? [...tiersHtml[1].matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)]
        .map(([, qty, price]) => ({ qty: cleanText(qty.replace(/<sup>\*<\/sup>/gi, '*')), price: cleanText(price) }))
        .filter((t) => t.qty && t.price && !/quantity/i.test(t.qty))
    : []
  const lowest = page.match(/<\/table>\s*<\/div>\s*<\/div>\s*<\/span>\s*\$\s*([\d.,]+)/i)
  const cid = page.match(/load_other_cards\(\s*\d+\s*,\s*(\d+)/)
  const section = (from, to) => {
    const a = page.indexOf(from)
    if (a < 0) return ''
    const b = to ? page.indexOf(to, a) : -1
    return page.slice(a, b > a ? b : a + 20000)
  }
  const quotes = (html, whoFirst) =>
    [...html.matchAll(/<div class="testimonial grey_gilltext">([\s\S]*?<div class="reviewer[^"]*">[\s\S]*?<\/div>[\s\S]*?)<\/div>/gi)]
      .map(([, inner]) => {
        const who = inner.match(/<div class="reviewer[^"]*">([\s\S]*?)<\/div>/i)
        return { who: cleanText(who ? who[1] : ''), text: cleanText(inner.replace(/<div class="reviewer[^"]*">[\s\S]*?<\/div>/i, '')) }
      })
      .filter((q) => q.text)
      .slice(0, whoFirst ? 30 : 3)
  const reviews = page
    .split(/<div class="product_review">/i)
    .slice(1)
    .map((block) => {
      const field = (cls) => {
        const m = block.match(new RegExp(`class="${cls}">([\\s\\S]*?)</(?:span|div)>`, 'i'))
        return m ? cleanText(m[1]) : ''
      }
      const rating = block.match(/rating\s*=\s*"(\d)"/i)
      return { rating: rating ? Number(rating[1]) : 5, title: field('pr_title'), who: field('pr_customer'), body: field('pr_body') }
    })
    .filter((r) => r.body || r.title)
    .slice(0, 30)
  const extra = {
    reviews,
    availability: cleanText(detailHtml(page, 'Availability')) || null,
    tiers: tiers.slice(0, 14),
    lowest: lowest ? lowest[1] : null,
    cid: cid ? cid[1] : null,
    sideQuotes: quotes(section('id="testimonialsC"', 'id="bbblinks"'), false),
    productQuotes: quotes(section('id="product_testimonials"', 'as_featured_in'), true),
  }
  return {
    extra,
    price: priceText ? priceText[1] : trackedPrice ? Number(trackedPrice[1]).toFixed(2) : null,
    artist: cleanText(artistHtml) || null,
    artistUrl: artistLink ? absolute(artistLink[1]) : null,
    artistNotes: cleanText(detailHtml(page, 'Artist Notes')) || null,
    size: cleanText(detailHtml(page, 'Size')) || null,
    customize: cleanText(detailHtml(page, 'Customize')) || null,
    categories: categories.filter((c) => c.name && c.url).slice(0, 6),
    image3d: image3d ? absolute(image3d[1]) : null,
  }
}

const fetchGcu = (url, init = {}) => fetch(url, { redirect: 'follow', ...init, headers: GCU_HEADERS })

const exists = async (url) => {
  const res = await fetchGcu(url, { method: 'HEAD' }).catch(() => null)
  return Boolean(res?.ok && (res.headers.get('content-type') || '').startsWith('image/'))
}

const scrape = async (pid) => {
  const [pageRes, zoomRes] = await Promise.all([
    fetchGcu(`${SITE}/${pid}`),
    fetchGcu(`${SITE}/shopping/zoom.asp?pid=${pid}&view=front&popin=1`),
  ])
  if (!zoomRes.ok) throw new Error(`GreetingCardUniverse returned ${zoomRes.status} for the card viewer.`)
  const paths = parseZoom(await zoomRes.text())
  if (!paths.front) return null
  // Not cached when the product page fails, so the next visit retries for the title and inside text.
  if (!pageRes.ok) {
    const challenged = pageRes.headers.get('cf-mitigated') === 'challenge' ? ' (bot challenge)' : ''
    throw new Error(`GreetingCardUniverse returned ${pageRes.status}${challenged} for the product page.`)
  }
  const page = await pageRes.text()
  const details = parseDetails(page)
  const printUrl = paths.front.replace('_hres.', '_print.')
  const [front, related] = await Promise.all([
    printUrl !== paths.front ? exists(printUrl).then((ok) => (ok ? printUrl : paths.front)) : paths.front,
    details.extra.cid ? fetchRelated(pid, details.extra.cid) : [],
  ])
  details.extra.back = paths.back
  details.extra.related = related
  details.extra.shadow = details.image3d ? details.image3d.replace(/_3d\.jpg(\?.*)?$/, '_shadow.jpg') : null
  return {
    title: parseTitle(page, pid),
    productUrl: pageRes.url,
    front,
    insidePreview: paths.inside,
    lines: parseInsideText(page),
    details,
  }
}

// The "other cards in this category" column GCU's page loads by AJAX after it renders.
const fetchRelated = async (pid, cid) => {
  try {
    const res = await fetchGcu(`${SITE}/community/card_details.asp?ajax=true&cmd2=get_other_cards&aid=0&pid=${pid}&cid=${cid}&off=0&fromsearch=false`)
    if (!res.ok) return []
    const html = await res.text()
    return html
      .split(/<!--\s*card div/i)
      .slice(1)
      .map((block) => {
        const id = block.match(/id\s*=\s*["']cardid_(\d+)/i)
        const img = block.match(/<img[^>]*?\ssrc\s*=\s*["']([^"']+)/i)
        const alt = block.match(/\salt\s*=\s*"([^"]*)"/i)
        const name = block.match(/class\s*=\s*"prodname[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        if (!id || !img) return null
        return {
          pid: id[1],
          img: absolute(img[1]),
          title: alt ? decodeEntities(alt[1]) : '',
          name: name ? cleanText(name[1]) : '',
          landscape: /cardstyle\s+landscapeC/i.test(block),
        }
      })
      .filter(Boolean)
      .slice(0, 6)
  } catch (error) {
    console.error('gcu related', pid, error)
    return []
  }
}

const getRow = (db, pid) => db.prepare('SELECT * FROM gcu_cards WHERE pid = ?').bind(pid).first()

const parseJson = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

const rowInfo = (row) => {
  const ready = Boolean(row.inside_ready) && row.inside_version >= INSIDE_VERSION
  return {
    pid: row.pid,
    title: row.title || '',
    productUrl: row.product_url,
    front: row.front_url,
    image3d: row.image3d_url || null,
    hasPreview: Boolean(row.inside_preview_url),
    insidePreview: row.inside_preview_url || null,
    lines: parseJson(row.inside_lines_json, []),
    inside: ready ? `/gcu/${row.pid}/inside.jpg?v=${encodeURIComponent(row.updated_at)}` : null,
    width: row.front_w || null,
    height: row.front_h || null,
    landscape: row.landscape == null ? null : Boolean(row.landscape),
    price: row.price || null,
    artist: row.artist || null,
    artistUrl: row.artist_url || null,
    artistNotes: row.artist_notes || null,
    size: row.size_text || null,
    customize: row.customize || null,
    categories: parseJson(row.categories_json, []),
    ...parseJson(row.extra_json, {}),
  }
}

const detailValues = (d) => [
  d.price,
  d.artist,
  d.artistUrl,
  d.artistNotes,
  d.size,
  d.customize,
  JSON.stringify(d.categories),
  d.image3d,
  JSON.stringify(d.extra || {}),
  DETAILS_VERSION,
]

// Scrapes new cards; rows cached before the product-page fields existed are refreshed once.
// Failed scrapes are never stored, so the next visit retries.
const loadRow = async (db, pid) => {
  const row = await getRow(db, pid)
  if (row && row.details_version >= DETAILS_VERSION) return row
  let card
  try {
    card = await scrape(pid)
  } catch (error) {
    console.error('gcu scrape', pid, error)
    if (row) return row
    return { error: `Couldn't reach GreetingCardUniverse for GCU Card# ${pid}. Please try again.`, status: 502 }
  }
  if (!card) return row || { error: `GCU Card# ${pid} was not found.`, status: 404 }
  const now = new Date().toISOString()
  if (row) {
    await db
      .prepare(
        `UPDATE gcu_cards SET title = ?, product_url = ?, price = ?, artist = ?, artist_url = ?, artist_notes = ?,
           size_text = ?, customize = ?, categories_json = ?, image3d_url = ?, extra_json = ?, details_version = ? WHERE pid = ?`,
      )
      .bind(card.title || row.title, card.productUrl, ...detailValues(card.details), pid)
      .run()
  } else {
    await db
      .prepare(
        `INSERT OR IGNORE INTO gcu_cards (pid, title, product_url, front_url, inside_preview_url, inside_lines_json,
           price, artist, artist_url, artist_notes, size_text, customize, categories_json, image3d_url, extra_json,
           details_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(pid, card.title, card.productUrl, card.front, card.insidePreview, JSON.stringify(card.lines), ...detailValues(card.details), now, now)
      .run()
  }
  return getRow(db, pid)
}

const handleInfo = async (env, pid) => {
  const db = env.ACCOUNT_DB
  const row = await loadRow(db, pid)
  if (row.error) return json({ error: row.error }, row.status)
  await db.prepare('UPDATE gcu_cards SET views = views + 1 WHERE pid = ?').bind(pid).run()
  return json(rowInfo(row))
}

const handlePreview = async (env, pid) => {
  const row = await getRow(env.ACCOUNT_DB, pid)
  if (!row?.inside_preview_url) return json({ error: 'No inside preview.' }, 404)
  const res = await fetchGcu(row.inside_preview_url)
  if (!res.ok) return json({ error: `Preview fetch failed (${res.status}).` }, 502)
  return new Response(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') || 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  })
}

const handleInsideUpload = async (request, env, pid, url) => {
  const db = env.ACCOUNT_DB
  const row = await getRow(db, pid)
  if (!row) return json({ error: 'Unknown card.' }, 404)
  if (row.inside_ready && row.inside_version >= INSIDE_VERSION) return json({ ok: true, kept: true })
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length < 1000 || bytes.length > MAX_INSIDE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return json({ error: 'Expected a JPEG.' }, 400)
  }
  const q = url.searchParams
  const int = (k) => {
    const n = Number.parseInt(q.get(k) || '', 10)
    return Number.isFinite(n) && n > 0 && n < 20000 ? n : null
  }
  const text = (k) => (q.get(k) || '').slice(0, 60) || null
  await putAsset(env, insideAsset(pid), bytes, 'image/jpeg')
  await db
    .prepare(
      `UPDATE gcu_cards SET inside_ready = 1, inside_version = ?, landscape = ?, front_w = ?, front_h = ?,
         inside_font = ?, inside_color = ?, inside_align = ?, updated_at = ? WHERE pid = ?`,
    )
    .bind(
      INSIDE_VERSION,
      q.get('landscape') === '1' ? 1 : 0,
      int('w'),
      int('h'),
      text('font'),
      text('color'),
      text('align'),
      new Date().toISOString(),
      pid,
    )
    .run()
  return json({ ok: true })
}

const handleInsideImage = async (env, pid) => {
  const found = await getAsset(env, insideAsset(pid))
  if (!found) return json({ error: 'Not built yet.' }, 404)
  return new Response(found.value, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' },
  })
}

const appUrl = (env) => String(env.PUBLIC_APP_URL || 'https://www.card-genie.com').replace(/\/$/, '')
const inlineJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '')

const handlePage = async (env, pid, origin) => {
  const db = env.ACCOUNT_DB
  const row = await getRow(db, pid).catch(() => null)
  // A fully cached card renders the product page without waiting on /info.
  const info = row && row.details_version >= DETAILS_VERSION ? rowInfo(row) : null
  if (info) await db.prepare('UPDATE gcu_cards SET views = views + 1 WHERE pid = ?').bind(pid).run().catch(() => {})
  const page = pageHtml
    .replaceAll('__PID__', pid)
    .replace('"__API__"', JSON.stringify(origin))
    .replace('"__APP__"', JSON.stringify(appUrl(env)))
    .replace('"__TITLE__"', inlineJson(row?.title || ''))
    .replace('"__INFO__"', inlineJson(info))
  return new Response(page, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

const SEND_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newSendId = () =>
  [...crypto.getRandomValues(new Uint8Array(12))].map((b) => SEND_ID_ALPHABET[b % SEND_ID_ALPHABET.length]).join('')

// Names go into the email subject and the text message, so they must not carry links.
const cleanName = (value, label, required) => {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()
  if (!name) {
    if (required) throw new Error(`Enter ${label}.`)
    return ''
  }
  if (name.length > 40) throw new Error(`Keep ${label} under 40 characters.`)
  if (/https?:|www\.|@|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|us|info|biz|xyz|app|link)\b/i.test(name)) {
    throw new Error('Names can’t include links or email addresses.')
  }
  return name
}

const giftCopy = ({ fromName, toName, shareUrl, imageUrl, title, escapeHtml }) => {
  const toFirst = toName.split(' ')[0]
  const openLine = toFirst ? `${toFirst}, open the card ${fromName} sent you.` : `Open the card ${fromName} sent you.`
  return {
    subject: `${fromName} sent you a card`,
    text: `${openLine} ${shareUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #302632; line-height: 1.5;">
        ${imageUrl ? `<p style="margin: 0 0 16px;"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title || 'Greeting card')}" width="160" style="display:block;width:160px;max-width:160px;height:auto;border:0;border-radius:8px;" /></p>` : ''}
        <p>${escapeHtml(openLine)}</p>
        <p><a href="${shareUrl}" style="display:inline-block;padding:12px 18px;background:#f59e33;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">Open your card</a></p>
        <p>If the button does not work, copy and paste this link: <br /><a href="${shareUrl}">${shareUrl}</a></p>
        <p style="margin-top: 18px; color: #666; font-size: 13px;">Sent with Card Genie · a GreetingCardUniverse card</p>
      </div>
    `,
  }
}

// Same rules as the main app's /api/deliver-card (confirmed-phone session, SMS consent), but the
// credits are checked and taken here on the server, and each request is one recipient.
const handleSend = async (request, env, pid, deps) => {
  const db = env.ACCOUNT_DB
  const session = await deps.getSession(request)
  if (!session) return json({ error: 'Confirm your mobile number before sending. We’ll text you a one-time code.', needSignIn: true }, 401)

  const body = (await request.json().catch(() => null)) || {}
  const method = body.method === 'text' ? 'text' : body.method === 'email' ? 'email' : null
  if (!method) return json({ error: 'Choose email or text delivery.' }, 400)
  if (method === 'text' && body.recipientConsentConfirmed !== true) return json({ error: 'Check the box to send this card by text.' }, 400)

  let destination, fromName, toName
  try {
    destination = method === 'email' ? deps.normalizeEmailAddress(String(body.destination || '')) : deps.normalizePhoneNumber(String(body.destination || ''))
    fromName = cleanName(body.fromName, 'your name', true)
    toName = cleanName(body.toName, 'their name', false)
  } catch (error) {
    return json({ error: error.message }, 400)
  }
  const note = String(body.note || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 300)

  const row = await getRow(db, pid)
  if (!row) return json({ error: 'Open the card page again, then send.' }, 404)

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM gcu_sends WHERE user_id = ? AND created_at > ?')
    .bind(session.userId, hourAgo)
    .first()
  if ((recent?.n || 0) >= SENDS_PER_HOUR) return json({ error: 'You’ve sent a lot of cards in the last hour. Please try again a little later.' }, 429)

  await ensureAccountUser(env, { userId: session.userId, phoneE164: session.phoneE164 })
  const now = new Date().toISOString()
  // Conditional update so two quick taps can't spend the same credits twice.
  const charged = await db
    .prepare(
      `UPDATE users SET credit_balance = credit_balance - ?, credits_spent = credits_spent + ?, last_used_at = ?, updated_at = ?
       WHERE id = ? AND credit_balance >= ?`,
    )
    .bind(SEND_CREDIT_COST, SEND_CREDIT_COST, now, now, session.userId, SEND_CREDIT_COST)
    .run()
  if (!charged.meta?.changes) {
    const account = await getAccountForSession(env, session.userId)
    const balance = account?.creditBalance ?? 0
    return json(
      {
        error: `Sending uses ${SEND_CREDIT_COST} credits and you have ${balance}. Buy more credits to send this card.`,
        needCredits: true,
        creditBalance: balance,
      },
      402,
    )
  }
  const creditEvent = async (delta, kind, reason) => {
    const user = await db.prepare('SELECT credit_balance FROM users WHERE id = ?').bind(session.userId).first()
    await db
      .prepare(
        `INSERT INTO credit_events (id, user_id, created_at, kind, reason, credits_delta, balance_after, actor_type, payment_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?)`,
      )
      .bind(crypto.randomUUID(), session.userId, new Date().toISOString(), kind, reason, delta, user?.credit_balance ?? 0, `GCU Card# ${pid}`)
      .run()
      .catch((error) => console.error('gcu credit event', error))
    return user?.credit_balance ?? 0
  }
  let balance = await creditEvent(-SEND_CREDIT_COST, 'adjustment', 'card_send')

  const id = newSendId()
  const shareUrl = `${appUrl(env)}/gcu/${pid}?s=${id}`
  await db
    .prepare(
      `INSERT INTO gcu_sends (id, pid, user_id, method, destination, from_name, to_name, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(id, pid, session.userId, method, destination, fromName, toName || null, note || null, now)
    .run()

  const copy = giftCopy({ fromName, toName, shareUrl, imageUrl: row.image3d_url || row.front_url, title: row.title, escapeHtml: deps.escapeHtml })
  try {
    if (method === 'email') await deps.sendEmailDelivery({ env, to: destination, copy })
    else await deps.sendTextDelivery({ env, to: destination, copy })
  } catch (error) {
    console.error('gcu send', pid, error)
    await db
      .prepare(
        `UPDATE users SET credit_balance = credit_balance + ?, credits_spent = MAX(0, credits_spent - ?), updated_at = ? WHERE id = ?`,
      )
      .bind(SEND_CREDIT_COST, SEND_CREDIT_COST, new Date().toISOString(), session.userId)
      .run()
    balance = await creditEvent(SEND_CREDIT_COST, 'grant', 'card_send_refund')
    await db.prepare(`UPDATE gcu_sends SET status = 'failed', error = ? WHERE id = ?`).bind(String(error?.message || error).slice(0, 500), id).run()
    const what = method === 'email' ? 'Email' : 'Text'
    return json({ error: `${what} delivery isn’t working right now, so your credits weren’t used. Please try again in a few minutes.`, creditBalance: balance }, 502)
  }
  await db.prepare(`UPDATE gcu_sends SET status = 'sent' WHERE id = ?`).bind(id).run()
  return json({
    ok: true,
    shareUrl,
    deliveredTo: destination,
    creditBalance: balance,
    message: `Card sent to ${destination}. ${SEND_CREDIT_COST} credits used.`,
  })
}

const handleGift = async (env, pid, id) => {
  const db = env.ACCOUNT_DB
  const gift = id && (await db.prepare(`SELECT * FROM gcu_sends WHERE id = ? AND pid = ? AND status = 'sent'`).bind(id, pid).first())
  if (!gift) return json({ error: 'This card link has expired or is incorrect.' }, 404)
  await db
    .prepare('UPDATE gcu_sends SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run()
  return json({ from: gift.from_name, to: gift.to_name || '', note: gift.note || '' })
}

const route = async (request, env, url, { pid, action, id }, deps) => {
  await ensureTable(env.ACCOUNT_DB)
  const { method } = request
  if (method === 'GET' && action === 'page') return handlePage(env, pid, url.origin)
  if (method === 'GET' && action === 'info') return handleInfo(env, pid)
  if (method === 'GET' && action === 'preview') return handlePreview(env, pid)
  if (method === 'GET' && action === 'inside.jpg') return handleInsideImage(env, pid)
  if (method === 'POST' && action === 'inside') return handleInsideUpload(request, env, pid, url)
  if (method === 'POST' && action === 'send') return handleSend(request, env, pid, deps)
  if (method === 'GET' && action === 'gift') return handleGift(env, pid, id)
  if (method === 'GET' && action === 'tab') return handleTab(env, id, url.searchParams.get('o') === 'l')
  return json({ error: 'Not found.' }, 404)
}

// The page is usually shown on www.card-genie.com (GitHub Pages) and calls back here cross-origin.
// GCU's Size/Quality, Pricing and Shipping tabs, cleaned of scripts and handlers so the replica can show them inline.
const handleTab = async (env, tab, landscape) => {
  const key = `gcu-tab:${tab}:${landscape ? 'l' : 'p'}`
  let html = env.CARD_STORE ? await env.CARD_STORE.get(key) : null
  if (!html) {
    const orientation = encodeURIComponent(landscape ? '7" x 5"' : '5" x 7"')
    const res = await fetchGcu(`${SITE}/community/card_details_tabs.asp?ajax=true&tab_num=${tab}&orientation=${orientation}`)
    if (!res.ok) return json({ error: `GreetingCardUniverse returned ${res.status}.` }, 502)
    html = (await res.text())
      .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\b(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
      .replace(/\b(href|src)\s*=\s*(["'])(\/(?!\/)[^"']*)\2/gi, (_, attr, q, path) => `${attr}=${q}${SITE}${path}${q}`)
    if (env.CARD_STORE) await env.CARD_STORE.put(key, html, { expirationTtl: 86400 })
  }
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}

export const handleGcuRequest = async (request, env, url, match, corsHeaders, deps) => {
  const res = await route(request, env, url, match, deps)
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v)
  // Without this, a copy cached from a same-origin visit (no CORS headers) is reused cross-origin.
  out.headers.set('Vary', 'Origin')
  return out
}
