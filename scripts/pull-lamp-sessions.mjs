#!/usr/bin/env node
/**
 * Pull recent Lamp Genie / Ask Genie test session logs and print them.
 *
 * Usage:
 *   ADMIN_SECRET=… npm run lamp:sessions   (or keep the key in .cursor/admin.secret)
 *   npm run lamp:sessions -- ask
 *   npm run lamp:sessions -- lamp
 *   npm run lamp:sessions -- <sessionId>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiBase = (process.env.DEPLOY_NOTIFY_API || 'https://cardgenie-api.autumn-base-7bd2.workers.dev').replace(
  /\/$/,
  '',
)
const adminKeyFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.cursor', 'admin.secret')
const secret = String(process.env.ADMIN_SECRET || (existsSync(adminKeyFile) ? readFileSync(adminKeyFile, 'utf8') : '')).trim()
const auth = { headers: { Authorization: `Bearer ${secret}` } }
const arg = String(process.argv[2] || '').trim()

if (!secret) {
  console.error('Missing ADMIN_SECRET (or .cursor/admin.secret)')
  process.exit(1)
}

const isFilter = arg === 'ask' || arg === 'lamp'
const sessionId = isFilter ? '' : arg

const url = sessionId
  ? `${apiBase}/api/admin/lamp-sessions?id=${encodeURIComponent(sessionId)}`
  : `${apiBase}/api/admin/lamp-sessions`

const response = await fetch(url, auth)
const data = await response.json().catch(() => ({}))
if (!response.ok) {
  console.error(data.error || `Request failed (${response.status})`)
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.cursor')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'lamp-genie-test-sessions.json')

const inferMode = (id, mode) => {
  if (mode === 'ask' || mode === 'lamp') {
    return mode
  }
  return String(id || '').startsWith('ask') ? 'ask' : 'lamp'
}

if (sessionId) {
  const session = data.session
  if (session) {
    session.mode = inferMode(session.id, session.mode)
  }
  console.log(JSON.stringify(session, null, 2))
  writeFileSync(outFile, JSON.stringify({ pulledAt: new Date().toISOString(), session }, null, 2))
} else {
  let sessions = Array.isArray(data.sessions) ? data.sessions : []
  sessions = sessions.map((entry) => ({
    ...entry,
    mode: inferMode(entry.id, entry.mode),
  }))
  if (isFilter) {
    sessions = sessions.filter((entry) => entry.mode === arg)
  }
  console.log(JSON.stringify(sessions, null, 2))
  writeFileSync(outFile, JSON.stringify({ pulledAt: new Date().toISOString(), sessions }, null, 2))
}

console.error(`Wrote ${outFile}`)
