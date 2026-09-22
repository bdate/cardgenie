#!/usr/bin/env node
/**
 * Pull recent Lamp Genie Realtime test session logs and print them.
 *
 * Usage:
 *   DEPLOY_NOTIFY_SECRET=$(cat .cursor/deploy-notify.secret) npm run lamp:sessions
 *   DEPLOY_NOTIFY_SECRET=… npm run lamp:sessions -- <sessionId>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiBase = (process.env.DEPLOY_NOTIFY_API || 'https://cardgenie-api.autumn-base-7bd2.workers.dev').replace(
  /\/$/,
  '',
)
const secret = String(process.env.DEPLOY_NOTIFY_SECRET || '').trim()
const sessionId = String(process.argv[2] || '').trim()

if (!secret) {
  console.error('Missing DEPLOY_NOTIFY_SECRET')
  process.exit(1)
}

const url = sessionId
  ? `${apiBase}/api/admin/lamp-sessions?id=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(secret)}`
  : `${apiBase}/api/admin/lamp-sessions?secret=${encodeURIComponent(secret)}`

const response = await fetch(url)
const data = await response.json().catch(() => ({}))
if (!response.ok) {
  console.error(data.error || `Request failed (${response.status})`)
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.cursor')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'lamp-genie-test-sessions.json')

if (sessionId) {
  console.log(JSON.stringify(data.session, null, 2))
  writeFileSync(outFile, JSON.stringify({ pulledAt: new Date().toISOString(), session: data.session }, null, 2))
} else {
  console.log(JSON.stringify(data.sessions || [], null, 2))
  writeFileSync(outFile, JSON.stringify({ pulledAt: new Date().toISOString(), sessions: data.sessions || [] }, null, 2))
}

console.error(`Wrote ${outFile}`)
