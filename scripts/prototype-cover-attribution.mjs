/**
 * Prototype: digital-only cover attribution (NOT for print).
 *
 * Samples the lower-left corner luminance and composites a small
 * "card-genie.com" mark in black, white, or gray.
 *
 * Usage:
 *   node scripts/prototype-cover-attribution.mjs \
 *     --in public/new-baby-cards/img/baby-girl-nursery.jpg \
 *     --out /tmp/attributed.jpg
 *
 * Or batch marketing samples into an output directory:
 *   node scripts/prototype-cover-attribution.mjs --demo --out-dir /tmp/attr-demo
 *
 * Requires: npm install sharp  (dev-only for this prototype; not wired into the Worker yet)
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEXT = 'card-genie.com'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const DEMO_SAMPLES = [
  ['light-watercolor', 'public/birthday-cards/img/grandma-80th-watercolor.jpg'],
  ['dark-comic', 'public/birthday-cards/img/dad-50th-comic.jpg'],
  ['busy-poster', 'public/fathers-day-cards/img/dad-fishing-poster.jpg'],
  ['soft-storybook', 'public/birthday-cards/img/nephew-6th-storybook.jpg'],
  ['dark-editorial', 'public/sympathy-cards/img/friend-loss-editorial.jpg'],
  ['pale-nursery', 'public/new-baby-cards/img/baby-girl-nursery.jpg'],
  ['vibrant-collage', 'public/congratulations-cards/img/promotion-collage.jpg'],
  ['vintage-warm', 'public/anniversary-cards/img/parents-40th-vintage.jpg'],
]

function parseArgs(argv) {
  const out = { demo: false, in: null, out: null, outDir: null, fontFrac: 0.0135 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--demo') out.demo = true
    else if (a === '--in') out.in = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--out-dir') out.outDir = argv[++i]
    else if (a === '--font-frac') out.fontFrac = Number(argv[++i])
  }
  return out
}

function relativeLuminance([r, g, b]) {
  const channel = (c) => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function chooseInk(meanLum, contrast) {
  if (contrast > 0.12) return { fill: '#787878', name: 'gray', halo: true }
  if (meanLum >= 0.62) return { fill: '#1c1c1c', name: 'black', halo: false }
  if (meanLum <= 0.38) return { fill: '#f5f5f5', name: 'white', halo: false }
  if (meanLum >= 0.5) return { fill: '#373737', name: 'gray', halo: true }
  return { fill: '#d2d2d2', name: 'gray', halo: true }
}

async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    console.error(
      'This prototype needs sharp. Install with:\n  npm install --no-save sharp\n',
    )
    process.exit(1)
  }
}

async function sampleCorner(sharp, input, width, height) {
  const left = Math.round(width * 0.02)
  const top = Math.round(height * 0.92)
  const boxW = Math.max(8, Math.round(width * 0.26))
  const boxH = Math.max(8, Math.round(height * 0.065))
  const { data, info } = await sharp(input)
    .extract({ left, top, width: Math.min(boxW, width - left), height: Math.min(boxH, height - top) })
    .resize(24, 8, { fit: 'fill', kernel: 'box' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = []
  for (let i = 0; i < data.length; i += info.channels) {
    pixels.push([data[i], data[i + 1], data[i + 2]])
  }
  const lums = pixels.map(relativeLuminance)
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length
  const variance = lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length
  return { meanLum: mean, contrast: Math.sqrt(variance) }
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildSvg({ width, height, fontSize, ink }) {
  const x = Math.round(width * 0.028)
  const y = Math.round(height * (1 - 0.028))
  const opacity = ink.name === 'white' ? 0.72 : 0.68
  const halo =
    ink.halo
      ? `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" fill="${
          ink.fill === '#787878' || ink.fill === '#373737' ? '#ffffff' : '#000000'
        }" fill-opacity="0.35" stroke="${
          ink.fill === '#787878' || ink.fill === '#373737' ? '#ffffff' : '#000000'
        }" stroke-opacity="0.28" stroke-width="2" paint-order="stroke">${escapeXml(TEXT)}</text>`
      : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${halo}
  <text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}"
    fill="${ink.fill}" fill-opacity="${opacity}">${escapeXml(TEXT)}</text>
</svg>`
}

async function attributeImage(sharp, inputPath, outputPath, fontFrac) {
  const base = sharp(inputPath)
  const meta = await base.metadata()
  const width = meta.width
  const height = meta.height
  const { meanLum, contrast } = await sampleCorner(sharp, inputPath, width, height)
  const ink = chooseInk(meanLum, contrast)
  const fontSize = Math.max(12, Math.round(height * fontFrac))
  const svg = Buffer.from(buildSvg({ width, height, fontSize, ink }))
  await sharp(inputPath)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(outputPath)
  return { ink: ink.name, meanLum, contrast, fontSize, width, height }
}

async function main() {
  const args = parseArgs(process.argv)
  const sharp = await loadSharp()

  if (args.demo) {
    const outDir = path.resolve(args.outDir || path.join(root, 'tmp/cover-attribution-demo'))
    await mkdir(outDir, { recursive: true })
    const summary = []
    for (const [label, rel] of DEMO_SAMPLES) {
      const input = path.join(root, rel)
      const output = path.join(outDir, `${label}.jpg`)
      const result = await attributeImage(sharp, input, output, args.fontFrac)
      summary.push({ label, ...result, output })
      console.log(`${label}: ${result.ink} (lum ${result.meanLum.toFixed(3)}) → ${output}`)
    }
    await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
    return
  }

  if (!args.in || !args.out) {
    console.error('Provide --in and --out, or --demo --out-dir <dir>')
    process.exit(1)
  }
  const result = await attributeImage(sharp, path.resolve(args.in), path.resolve(args.out), args.fontFrac)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
