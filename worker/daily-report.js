// Nightly business report: one Pacific day of funnel, sales, delivery, problem and cost numbers.
import { getAdminCosts } from './costs.js'

const TIME_ZONE = 'America/Los_Angeles'
const WELCOME_EXPERIMENT = 'welcome-v2'

const FUNNEL_STEPS = [
  ['view', 'Saw the welcome page'],
  ['sample_open', 'Opened a sample'],
  ['create_start', 'Clicked "Create My Card"'],
  ['form_start', 'Started filling in the form'],
  ['generation_complete', 'Card created'],
  ['account_created', 'Created an account'],
  ['card_sent', 'Sent a card'],
  ['checkout_start', 'Started checkout'],
  ['purchase', 'Bought credits'],
]

const COST_LABELS = {
  images: 'Card images',
  voice: 'Genie voice',
  texts: 'Text messages',
  emails: 'Emails',
  printing: 'Printing',
  stripe: 'Stripe fees',
  textAi: 'Message writing (AI)',
  fixed: 'Fixed daily costs',
}

const TOTAL_LABELS = {
  view: 'saw page',
  create_start: 'clicked Create',
  generation_complete: 'created a card',
  card_sent: 'sent a card',
  purchase: 'bought credits',
}

const pacificParts = (date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  const offset = /GMT([+-]\d+)?(?::(\d+))?/.exec(parts.timeZoneName || '')
  const offsetMinutes = offset?.[1] ? Number(offset[1]) * 60 + Math.sign(Number(offset[1])) * Number(offset[2] || 0) : 0
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), offsetMinutes }
}

export const pacificNow = (date = new Date()) => pacificParts(date)

const dayStartUtc = (dayKey) => {
  const [year, month, day] = dayKey.split('-').map(Number)
  const noonUtc = Date.UTC(year, month - 1, day, 12)
  const { offsetMinutes } = pacificParts(new Date(noonUtc))
  return new Date(Date.UTC(year, month - 1, day) - offsetMinutes * 60 * 1000)
}

const nextDayKey = (dayKey) => {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

const rows = async (db, sql, params = []) => {
  try {
    const result = await db.prepare(sql).bind(...params).all()
    return result.results || []
  } catch (error) {
    console.error('daily report query failed', error)
    return []
  }
}

const money = (value) =>
  (Number(value) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })

const escape = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])

const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '–')

const PERIODS = {
  daily: { title: 'daily report', word: 'today' },
  weekly: { title: 'weekly report', word: 'this week' },
  monthly: { title: 'monthly report', word: 'this month' },
}

const shortDate = (dayKey, withYear = false) =>
  new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  })

const periodLabel = (kind, startDay, endDay) => {
  if (kind === 'monthly') {
    return new Date(`${startDay}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  }
  if (kind === 'weekly') return `${shortDate(startDay)} – ${shortDate(endDay, true)}`
  return new Date(`${startDay}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export const shiftDay = (dayKey, days) => {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** Monday of the Pacific week containing dayKey. */
export const weekStartDay = (dayKey) => {
  const weekday = new Date(`${dayKey}T12:00:00Z`).getUTCDay()
  return shiftDay(dayKey, -((weekday + 6) % 7))
}

export const isLastDayOfMonth = (dayKey) => shiftDay(dayKey, 1).slice(8) === '01'

export const buildDailyReport = (env, dayKey) => buildReport(env, { kind: 'daily', startDay: dayKey, endDay: dayKey })

export const buildReport = async (env, { kind = 'daily', startDay, endDay }) => {
  const db = env.ACCOUNT_DB
  if (!db) throw new Error('Account database is not available.')
  const period = PERIODS[kind] || PERIODS.daily
  const start = dayStartUtc(startDay).toISOString()
  const end = dayStartUtc(nextDayKey(endDay)).toISOString()
  const range = [start, end]

  const [funnelRows, cardRows, accountRows, deliveryRows, failedRows, paymentRows, printRows, adRows, errorRows, occasionRows, reviewRows, testTotalsRows] =
    await Promise.all([
      rows(
        db,
        `SELECT source, variant, event, COUNT(DISTINCT visitor) AS people
         FROM landing_events WHERE experiment = ? AND created_at >= ? AND created_at < ?
         GROUP BY source, variant, event`,
        [WELCOME_EXPERIMENT, ...range],
      ),
      rows(db, `SELECT COUNT(*) AS n FROM cards WHERE created_at >= ? AND created_at < ?`, range),
      rows(db, `SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?`, range),
      rows(
        db,
        `SELECT method, COUNT(*) AS deliveries, COUNT(DISTINCT card_id) AS cards FROM deliveries
         WHERE created_at >= ? AND created_at < ? AND status = 'sent' AND COALESCE(is_sender_copy, 0) = 0
         GROUP BY method`,
        range,
      ),
      rows(
        db,
        `SELECT method, COUNT(*) AS n FROM deliveries
         WHERE created_at >= ? AND created_at < ? AND status != 'sent' GROUP BY method`,
        range,
      ),
      rows(
        db,
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents - COALESCE(amount_refunded_cents, 0)), 0) AS cents,
                COALESCE(SUM(credits_purchased), 0) AS credits
         FROM payments WHERE status = 'paid' AND COALESCE(paid_at, created_at) >= ? AND COALESCE(paid_at, created_at) < ?`,
        range,
      ),
      rows(
        db,
        `SELECT order_source, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM print_orders
         WHERE created_at >= ? AND created_at < ? GROUP BY order_source`,
        range,
      ),
      rows(
        db,
        `SELECT COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS cents FROM ad_conversions
         WHERE reported_at >= ? AND reported_at < ?`,
        range,
      ),
      rows(
        db,
        `SELECT COUNT(DISTINCT visitor) AS n FROM landing_events
         WHERE event = 'generation_error' AND created_at >= ? AND created_at < ?`,
        range,
      ),
      rows(
        db,
        `SELECT LOWER(REPLACE(REPLACE(TRIM(occasion), '  ', ' '), '  ', ' ')) AS occasion, COUNT(*) AS n FROM cards
         WHERE created_at >= ? AND created_at < ? AND TRIM(COALESCE(occasion, '')) != ''
         GROUP BY 1 ORDER BY n DESC LIMIT 5`,
        range,
      ),
      rows(db, `SELECT COUNT(*) AS n FROM testimonials WHERE created_at >= ? AND created_at < ?`, range),
      rows(
        db,
        `SELECT variant, event, COUNT(DISTINCT visitor) AS people FROM landing_events
         WHERE experiment = ? AND source = 'paid' GROUP BY variant, event`,
        [WELCOME_EXPERIMENT],
      ),
    ])

  let costs = null
  try {
    const adminCosts = await getAdminCosts(env)
    if (kind === 'monthly' && adminCosts?.summaries?.month && startDay === `${adminCosts.today.slice(0, 8)}01`) {
      const month = adminCosts.summaries.month
      costs = {
        cost: Number(month.cost) || 0,
        net: (Number(month.revenue) || 0) - (Number(month.cost) || 0),
        categories: Object.fromEntries(Object.entries(month.categories || {}).map(([id, value]) => [id, Number(value?.cost ?? value) || 0])),
      }
    } else {
      const days = (adminCosts?.daily || []).filter((entry) => entry.day >= startDay && entry.day <= endDay)
      if (days.length) {
        const categories = {}
        for (const entry of days) {
          for (const [id, value] of Object.entries(entry.categories || {})) categories[id] = (categories[id] || 0) + (Number(value) || 0)
        }
        const cost = days.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0)
        const revenue = days.reduce((sum, entry) => sum + (Number(entry.revenue) || 0), 0)
        costs = { cost, net: revenue - cost, categories }
      }
    }
  } catch (error) {
    console.error('daily report costs failed', error)
  }

  const count = (list, source, variant, event) =>
    Number(list.find((row) => row.source === source && row.variant === variant && row.event === event)?.people || 0)
  const paidFunnel = FUNNEL_STEPS.map(([event, label]) => {
    const a = count(funnelRows, 'paid', 'a', event)
    const b = count(funnelRows, 'paid', 'b', event)
    return { label, a, b, total: a + b }
  })
  const otherViews = count(funnelRows, 'other', 'a', 'view') + count(funnelRows, 'other', 'b', 'view')
  const otherStarts = count(funnelRows, 'other', 'a', 'create_start') + count(funnelRows, 'other', 'b', 'create_start')
  const totalsCount = (variant, event) =>
    Number(testTotalsRows.find((row) => row.variant === variant && row.event === event)?.people || 0)
  const testTotals = ['view', 'create_start', 'generation_complete', 'card_sent', 'purchase'].map((event) => ({
    event,
    a: totalsCount('a', event),
    b: totalsCount('b', event),
  }))

  const sent = Object.fromEntries(deliveryRows.map((row) => [row.method, row]))
  const failed = failedRows.reduce((sum, row) => sum + Number(row.n || 0), 0)
  const payment = paymentRows[0] || {}
  const prints = printRows.reduce((sum, row) => sum + Number(row.n || 0), 0)
  const recipientRow = printRows.find((row) => row.order_source === 'recipient') || {}
  const recipientPrints = { n: Number(recipientRow.n || 0), cents: Number(recipientRow.cents || 0) }
  const ads = adRows[0] || {}
  const paidViews = paidFunnel[0].total
  const paidStarts = paidFunnel[2].total
  const cardsSent = Number(sent.email?.cards || 0) + Number(sent.text?.cards || 0)

  const dateLabel = periodLabel(kind, startDay, endDay)

  const highlights = [
    ['Revenue', `${money(Number(payment.cents || 0) / 100)} from ${Number(payment.n || 0)} credit purchase${Number(payment.n) === 1 ? '' : 's'}`],
    ['Cards created', String(Number(cardRows[0]?.n || 0))],
    ['New accounts', String(Number(accountRows[0]?.n || 0))],
    ['Cards sent', `${cardsSent} (email ${Number(sent.email?.deliveries || 0)}, text ${Number(sent.text?.deliveries || 0)} deliveries)`],
    [
      'Printed card orders',
      recipientPrints.n
        ? `${prints} (${recipientPrints.n} paid directly by recipients, ${money(recipientPrints.cents / 100)})`
        : String(prints),
    ],
    ['Ad visitors (paid)', `${paidViews} saw the welcome page, ${paidStarts} clicked Create (${pct(paidStarts, paidViews)})`],
    ['Purchases reported to Google Ads', `${Number(ads.n || 0)} (${money(Number(ads.cents || 0) / 100)})`],
  ]
  if (costs) {
    highlights.push(['Estimated costs', `${money(costs.cost)} · net ${money(costs.net)}`])
  }

  const problems = []
  if (failed) problems.push(`${failed} delivery attempt${failed === 1 ? '' : 's'} failed`)
  const generationErrors = Number(errorRows[0]?.n || 0)
  if (generationErrors) problems.push(`${generationErrors} welcome-page visitor${generationErrors === 1 ? '' : 's'} hit a card-creation error`)

  const costLines = costs
    ? Object.entries(costs.categories || {})
        .filter(([, value]) => Number(value) >= 0.005)
        .sort((left, right) => right[1] - left[1])
        .map(([id, value]) => `${COST_LABELS[id] || id}: ${money(value)}`)
    : []
  const occasions = occasionRows.map((row) => `${row.occasion} (${row.n})`)
  const reviews = Number(reviewRows[0]?.n || 0)

  const text = [
    `Card Genie ${period.title} – ${dateLabel} (Pacific time)`,
    '',
    ...highlights.map(([label, value]) => `${label}: ${value}`),
    '',
    `Ad visitors through the welcome page ${period.word} (paid traffic, test v2):`,
    ...paidFunnel.map((row) => `  ${row.label}: A ${row.a} · B ${row.b} · total ${row.total}`),
    `Other (non-ad) welcome visitors: ${otherViews} saw it, ${otherStarts} clicked Create.`,
    '',
    `Problems: ${problems.length ? problems.join('; ') : 'none'}`,
    `Top occasions: ${occasions.length ? occasions.join(', ') : 'none'}`,
    `New reviews submitted: ${reviews}`,
    costLines.length ? `Cost breakdown: ${costLines.join(', ')}` : '',
    '',
    'Welcome test v2 totals since Oct 27 (paid): ' +
      testTotals.map((row) => `${TOTAL_LABELS[row.event]} A ${row.a}/B ${row.b}`).join(' · '),
    '',
    'Google Ads clicks and spend are not included; see Google Ads for those.',
  ]
    .filter((line) => line !== null)
    .join('\n')

  const cell = 'padding:6px 10px;border-bottom:1px solid #e3ece9;text-align:left;'
  const num = 'padding:6px 10px;border-bottom:1px solid #e3ece9;text-align:right;'
  const html = `<div style="font-family:Arial,sans-serif;color:#2d4b48;max-width:640px;">
<h2 style="margin:0 0 4px;color:#3f9b91;">Card Genie ${escape(period.title)}</h2>
<p style="margin:0 0 16px;color:#5f6b6a;">${escape(dateLabel)} · Pacific time</p>
<table style="border-collapse:collapse;width:100%;margin-bottom:20px;">${highlights
    .map(([label, value]) => `<tr><td style="${cell}font-weight:bold;">${escape(label)}</td><td style="${cell}">${escape(value)}</td></tr>`)
    .join('')}</table>
<h3 style="margin:0 0 8px;">Ad visitors through the welcome page ${escape(period.word)}</h3>
<p style="margin:0 0 8px;color:#5f6b6a;font-size:13px;">Paid traffic, welcome test v2. Version A = finished sample cards, Version B = photo to card.</p>
<table style="border-collapse:collapse;width:100%;margin-bottom:8px;">
<tr><th style="${cell}">Step</th><th style="${num}">Version A</th><th style="${num}">Version B</th><th style="${num}">Total</th></tr>
${paidFunnel
  .map((row) => `<tr><td style="${cell}">${escape(row.label)}</td><td style="${num}">${row.a}</td><td style="${num}">${row.b}</td><td style="${num}">${row.total}</td></tr>`)
  .join('')}
</table>
<p style="margin:0 0 20px;color:#5f6b6a;font-size:13px;">Other (non-ad) welcome visitors: ${otherViews} saw it, ${otherStarts} clicked Create.</p>
<h3 style="margin:0 0 8px;">Also ${escape(period.word)}</h3>
<ul style="margin:0 0 20px;padding-left:20px;line-height:1.6;">
<li><strong>Problems:</strong> ${escape(problems.length ? problems.join('; ') : 'none')}</li>
<li><strong>Top occasions:</strong> ${escape(occasions.length ? occasions.join(', ') : 'none')}</li>
<li><strong>New reviews submitted:</strong> ${reviews}</li>
${costLines.length ? `<li><strong>Cost breakdown:</strong> ${escape(costLines.join(', '))}</li>` : ''}
<li><strong>Welcome test v2 totals since Oct 27 (paid):</strong> ${escape(
    testTotals.map((row) => `${TOTAL_LABELS[row.event]} A ${row.a} / B ${row.b}`).join(' · '),
  )}</li>
</ul>
<p style="margin:0;color:#5f6b6a;font-size:12px;">Google Ads clicks and spend are not included; see Google Ads for those. Small counts swing a lot, so judge the A/B test on the running totals.</p>
</div>`

  return { subject: `Card Genie ${period.title} – ${dateLabel}`, text, html, dayKey: endDay, startDay, kind }
}
