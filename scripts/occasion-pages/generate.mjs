// Generates sample card art for occasion pages that don't have it yet, using the live Card Genie API.
// Saves covers to public/<page>/img/<sample>.jpg and inside messages to messages.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { occasions } from './occasions.mjs'

const API = process.env.CARD_GENIE_API || 'https://api.card-genie.com'
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '../../public')
const messagesPath = join(here, 'messages.json')
const messages = existsSync(messagesPath) ? JSON.parse(readFileSync(messagesPath, 'utf8')) : {}
const CONCURRENCY = 6

const jobs = occasions.flatMap((page) =>
  page.samples
    .filter((sample) => !existsSync(join(publicDir, page.slug, 'img', `${sample.slug}.jpg`)))
    .map((sample) => ({ page, sample })),
)
console.log(`${jobs.length} sample cards to generate`)

const generate = async ({ page, sample }) => {
  const details = {
    senderName: 'Sam',
    tone: 'Heartfelt',
    length: 'Medium, 20-40 words',
    occasion: page.occasion,
    recipientName: sample.recipientName,
    recipientType: sample.recipientType,
    imageStyle: sample.imageStyle,
    keyDetails: sample.keyDetails,
    ...(sample.tone ? { tone: sample.tone } : {}),
    ...(sample.occasion ? { occasion: sample.occasion } : {}),
  }
  const start = await (await fetch(`${API}/api/generate-card`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(details) })).json()
  if (!start.jobId) throw new Error(`${page.slug}/${sample.slug}: ${JSON.stringify(start)}`)
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 4000))
    const job = await (await fetch(`${API}/api/generate-jobs/${start.jobId}`)).json()
    if (job.imageUrl) {
      const png = job.imageUrl.startsWith('data:')
        ? Buffer.from(job.imageUrl.slice(job.imageUrl.indexOf(',') + 1), 'base64')
        : Buffer.from(await (await fetch(job.imageUrl.startsWith('http') ? job.imageUrl : API + job.imageUrl)).arrayBuffer())
      const dir = join(publicDir, page.slug, 'img')
      mkdirSync(dir, { recursive: true })
      const tmp = join(dir, `${sample.slug}.src`)
      writeFileSync(tmp, png)
      execFileSync('python3', ['-c', `from PIL import Image; im=Image.open(${JSON.stringify(tmp)}).convert('RGB').resize((528,736), Image.LANCZOS); im.save(${JSON.stringify(join(dir, `${sample.slug}.jpg`))}, quality=82, optimize=True, progressive=True)`])
      unlinkSync(tmp)
      messages[`${page.slug}/${sample.slug}`] = { message: job.message, closing: job.closing, variants: job.messageVariants }
      writeFileSync(messagesPath, JSON.stringify(messages, null, 2))
      console.log('done', `${page.slug}/${sample.slug}`)
      return
    }
    if (job.status === 'failed' || job.status === 'error') throw new Error(`${page.slug}/${sample.slug}: ${job.error}`)
  }
  throw new Error(`${page.slug}/${sample.slug}: timed out`)
}

const queue = [...jobs]
const failures = []
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift()
      try {
        await generate(job)
      } catch (error) {
        failures.push(error.message)
        console.log('FAILED', String(error.message).slice(0, 200))
      }
    }
  }),
)
console.log(`finished; ${failures.length} failed`)
