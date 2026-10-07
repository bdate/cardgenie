// www.card-genie.com/gcu/<card#> (any case): envelope reveal for a GreetingCardUniverse card.
// The worker scrapes the product once and keeps it in D1; the visitor's browser re-typesets the
// inside message at print size (it needs canvas + web fonts) and uploads it to KV for next time.
import pageHtml from './gcu-page.html'

const SITE = 'https://www.greetingcarduniverse.com'
// Bump when the browser-side inside renderer changes so stored inside images are rebuilt.
const INSIDE_VERSION = 3
const MAX_INSIDE_BYTES = 6 * 1024 * 1024
const insideKey = (pid) => `gcu:inside:${pid}`
// GCU's bot protection challenges clients that claim to be a browser but don't act like one.
const GCU_HEADERS = { 'User-Agent': 'CardGenie/1.0 (+https://www.card-genie.com)', Accept: '*/*' }

export const matchGcuPath = (pathname) => {
  const m = pathname.match(/^\/gcu\/0*(\d{1,10})(?:\/(info|preview|inside|inside\.jpg))?\/?$/i)
  return m ? { pid: m[1], action: (m[2] || 'page').toLowerCase() } : null
}

let tableReady = false
const ensureTable = async (db) => {
  if (tableReady) return
  await db
    .prepare(
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
    )
    .run()
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
    .replace(/&amp;/g, '&')

const parseZoom = (zoom) => {
  const paths = {}
  for (const side of ['front', 'inside']) {
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
  const printUrl = paths.front.replace('_hres.', '_print.')
  const front = printUrl !== paths.front && (await exists(printUrl)) ? printUrl : paths.front
  return {
    title: parseTitle(page, pid),
    productUrl: pageRes.url,
    front,
    insidePreview: paths.inside,
    lines: parseInsideText(page),
  }
}

const getRow = (db, pid) => db.prepare('SELECT * FROM gcu_cards WHERE pid = ?').bind(pid).first()

const rowInfo = (row) => {
  const ready = Boolean(row.inside_ready) && row.inside_version >= INSIDE_VERSION
  return {
    pid: row.pid,
    title: row.title || '',
    productUrl: row.product_url,
    front: row.front_url,
    hasPreview: Boolean(row.inside_preview_url),
    lines: JSON.parse(row.inside_lines_json || '[]'),
    inside: ready ? `/gcu/${row.pid}/inside.jpg?v=${encodeURIComponent(row.updated_at)}` : null,    width: row.front_w || null,
    height: row.front_h || null,
    landscape: row.landscape == null ? null : Boolean(row.landscape),
  }
}

const handleInfo = async (env, pid) => {
  const db = env.ACCOUNT_DB
  let row = await getRow(db, pid)
  if (!row) {
    let card
    try {
      card = await scrape(pid)
    } catch (error) {
      console.error('gcu scrape', pid, error)
      return json({ error: `Couldn't reach GreetingCardUniverse for GCU Card# ${pid}. Please try again.` }, 502)
    }
    if (!card) return json({ error: `GCU Card# ${pid} was not found.` }, 404)
    const now = new Date().toISOString()
    await db
      .prepare(
        `INSERT OR IGNORE INTO gcu_cards (pid, title, product_url, front_url, inside_preview_url, inside_lines_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(pid, card.title, card.productUrl, card.front, card.insidePreview, JSON.stringify(card.lines), now, now)
      .run()
    row = await getRow(db, pid)
  }
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
  await env.CARD_STORE.put(insideKey(pid), bytes)
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
  const bytes = await env.CARD_STORE.get(insideKey(pid), 'arrayBuffer')
  if (!bytes) return json({ error: 'Not built yet.' }, 404)
  return new Response(bytes, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' },
  })
}

const handlePage = async (env, pid, origin) => {
  const row = await getRow(env.ACCOUNT_DB, pid).catch(() => null)
  const page = pageHtml
    .replaceAll('__PID__', pid)
    .replace('"__API__"', JSON.stringify(origin))
    .replace('"__TITLE__"', JSON.stringify(row?.title || '').replace(/</g, '\\u003c'))
  return new Response(page, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

const route = async (request, env, url, { pid, action }) => {
  await ensureTable(env.ACCOUNT_DB)
  const { method } = request
  if (method === 'GET' && action === 'page') return handlePage(env, pid, url.origin)
  if (method === 'GET' && action === 'info') return handleInfo(env, pid)
  if (method === 'GET' && action === 'preview') return handlePreview(env, pid)
  if (method === 'GET' && action === 'inside.jpg') return handleInsideImage(env, pid)
  if (method === 'POST' && action === 'inside') return handleInsideUpload(request, env, pid, url)
  return json({ error: 'Not found.' }, 404)
}

// The page is usually shown on www.card-genie.com (GitHub Pages) and calls back here cross-origin.
export const handleGcuRequest = async (request, env, url, match, corsHeaders) => {
  const res = await route(request, env, url, match)
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v)
  return out
}
