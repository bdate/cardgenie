// Makes a .webp copy next to every occasion and style sample .jpg, and shrinks the header logo.
// The .jpg files stay for og:image previews. Run with: node scripts/occasion-pages/webp.mjs
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '../../public')

const jpgDirs = [join(publicDir, 'styles')]
for (const entry of readdirSync(publicDir)) {
  const imgDir = join(publicDir, entry, 'img')
  try {
    if (statSync(imgDir).isDirectory()) jpgDirs.push(imgDir)
  } catch {}
}

let made = 0
for (const dir of jpgDirs) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jpg')) continue
    const output = join(dir, file.replace(/\.jpg$/, '.webp'))
    await sharp(join(dir, file)).webp({ quality: 75 }).toFile(output)
    made += 1
  }
}

const logo = join(publicDir, 'logo-mark.png')
const { width } = await sharp(logo).metadata()
if (width > 216) {
  const resized = await sharp(logo).resize({ width: 216 }).png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer()
  await sharp(resized).toFile(logo)
}

console.log(`made ${made} webp files; logo-mark.png is ${Math.min(width, 216)}px wide`)
