#!/usr/bin/env node
/**
 * Pull the last 7 days of card history (inputs, messages, covers) for admin review.
 *
 * Usage:
 *   DEPLOY_NOTIFY_SECRET=$(cat .cursor/deploy-notify.secret) npm run card:history
 *   DEPLOY_NOTIFY_SECRET=… npm run card:history -- --kind generate --q birthday --phone 925 --images
 *   DEPLOY_NOTIFY_SECRET=… npm run card:history -- --id <historyId>
 *
 * Kinds: generate, refine-image, refine-copy, save
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiBase = (process.env.DEPLOY_NOTIFY_API || 'https://cardgenie-api.autumn-base-7bd2.workers.dev').replace(
  /\/$/,
  '',
)
const secret = String(process.env.DEPLOY_NOTIFY_SECRET || '').trim()

if (!secret) {
  console.error('Missing DEPLOY_NOTIFY_SECRET')
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? String(args[index + 1] || '') : ''
}
const withImages = args.includes('--images')

const params = new URLSearchParams({ secret })
for (const name of ['id', 'kind', 'q', 'phone', 'limit']) {
  const value = flag(name)
  if (value) params.set(name, value)
}

const response = await fetch(`${apiBase}/api/admin/card-history?${params}`)
const data = await response.json().catch(() => ({}))
if (!response.ok) {
  console.error(data.error || `Request failed (${response.status})`)
  process.exit(1)
}

const entries = data.entry ? [data.entry] : Array.isArray(data.entries) ? data.entries : []
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.cursor', 'card-history')
mkdirSync(outDir, { recursive: true })

if (withImages || data.entry) {
  const imageDir = join(outDir, 'images')
  mkdirSync(imageDir, { recursive: true })
  for (const entry of entries.filter((item) => item.hasImage)) {
    const imageResponse = await fetch(
      `${apiBase}/api/admin/card-history?${new URLSearchParams({ secret, id: entry.id, image: '1' })}`,
    )
    if (!imageResponse.ok) continue
    const ext = (imageResponse.headers.get('content-type') || 'image/png').includes('jpeg') ? 'jpg' : 'png'
    const file = join(imageDir, `${entry.at.slice(0, 19).replace(/[:T]/g, '-')}-${entry.kind}-${entry.id.slice(0, 8)}.${ext}`)
    writeFileSync(file, Buffer.from(await imageResponse.arrayBuffer()))
    entry.imageFile = file
  }
}

for (const entry of entries) {
  const d = entry.details || {}
  console.log(
    [
      entry.at,
      entry.kind,
      entry.status,
      entry.phone || '-',
      `${d.recipientName || '?'} (${d.recipientType || '-'}) from ${d.senderName || '?'}`,
      d.occasion,
      entry.peopleOnCover ? `people:${entry.peopleOnCover}` : '',
    ]
      .filter(Boolean)
      .join(' | '),
  )
}

const outFile = join(outDir, 'card-history.json')
writeFileSync(outFile, JSON.stringify({ pulledAt: new Date().toISOString(), count: entries.length, entries }, null, 2))
console.error(`Wrote ${entries.length} entries to ${outFile}`)
