#!/usr/bin/env node
/**
 * Refuse a Pages upload whose card app would call www.card-genie.com.
 * The live site is one folder. Other public folders ride along with the app,
 * so a blank API address in that app breaks sign-in even when the edit was elsewhere.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const origin = 'https://api.card-genie.com'
const replaceCall = '.replace(/\\/$/,"")'

export const bundleUsesLiveApi = (text) =>
  text.includes(`"${origin}"${replaceCall}`) && !text.includes(`""${replaceCall}`)

const assertPagesApi = () => {
  const assetsDir = path.join(root, 'dist', 'assets')
  if (!existsSync(assetsDir)) {
    throw new Error('dist/assets is missing. Build the card app with npm run build before uploading the site.')
  }
  const bundles = readdirSync(assetsDir).filter((name) => name.startsWith('App-') && name.endsWith('.js'))
  const app = bundles
    .map((name) => ({ name, text: readFileSync(path.join(assetsDir, name), 'utf8') }))
    .find((entry) => entry.text.includes('/api/auth/otp/start'))
  if (!app) {
    throw new Error('No card app bundle with sign-in was found in dist/assets.')
  }
  if (!bundleUsesLiveApi(app.text)) {
    throw new Error(
      `${app.name} would send sign-in to www.card-genie.com. Refusing to upload. Run npm run build so the app keeps ${origin}.`,
    )
  }
  console.log(`Pages check ok: ${app.name} calls ${origin}`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    assertPagesApi()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
