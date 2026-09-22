#!/usr/bin/env node
/**
 * Email a live-deploy summary via Card Genie’s worker (SendGrid/Postmark).
 *
 * Usage:
 *   DEPLOY_NOTIFY_SECRET=... node scripts/notify-deploy.mjs "Summary text here"
 *   node scripts/notify-deploy.mjs --file summary.txt
 *
 * Env:
 *   DEPLOY_NOTIFY_SECRET (required) — worker secret
 *   DEPLOY_NOTIFY_API (optional) — defaults to production worker
 *   DEPLOY_NOTIFY_TO (optional) — defaults to cardgenie@gcuniverse.com
 */
import { readFileSync } from 'node:fs'

const apiBase = (process.env.DEPLOY_NOTIFY_API || 'https://cardgenie-api.autumn-base-7bd2.workers.dev').replace(
  /\/$/,
  '',
)
const secret = String(process.env.DEPLOY_NOTIFY_SECRET || '').trim()
const to = String(process.env.DEPLOY_NOTIFY_TO || 'cardgenie@gcuniverse.com').trim()

const args = process.argv.slice(2)
let summary = ''
if (args[0] === '--file' && args[1]) {
  summary = readFileSync(args[1], 'utf8')
} else if (args.length) {
  summary = args.join(' ')
} else if (!process.stdin.isTTY) {
  summary = readFileSync(0, 'utf8')
}

summary = summary.trim()
if (!secret) {
  console.error('Missing DEPLOY_NOTIFY_SECRET')
  process.exit(1)
}
if (!summary) {
  console.error('Missing summary text (pass as args, --file, or stdin)')
  process.exit(1)
}

const stamp = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
}).format(new Date())

const subject = `Card Genie latest code - ${stamp}`

const response = await fetch(`${apiBase}/api/admin/deploy-summary`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify({ summary, to, subject }),
})

const data = await response.json().catch(() => ({}))
if (!response.ok) {
  console.error(data.error || `HTTP ${response.status}`)
  process.exit(1)
}

console.log(`Sent: ${data.subject} → ${data.to}`)
