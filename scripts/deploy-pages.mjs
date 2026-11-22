#!/usr/bin/env node
/**
 * Upload www.card-genie.com.
 *
 *   node scripts/deploy-pages.mjs            rebuild the card app, then upload
 *   node scripts/deploy-pages.mjs --only reports
 *       copy one public folder, then upload, without rebuilding the card app
 *
 * A side project is its own folder under public/. --only never rebuilds the
 * card app. If scripts/build-<folder>.mjs exists, it runs first. The upload
 * still stops when the card app would call the website instead of
 * api.card-genie.com.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let only = ''
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--only') only = String(args[index + 1] || '')
  else if (!args[index].startsWith('-') && !only) only = args[index]
}

const reserved = new Set(['assets'])

if (only && (reserved.has(only) || !/^[a-z0-9-]+$/i.test(only))) {
  console.error('Use one public folder name, such as --only reports. The card app itself is not a side project.')
  process.exit(1)
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status || 1)
}

if (only) {
  const source = path.join(root, 'public', only)
  const dest = path.join(root, 'dist', only)
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    console.error('dist/ is missing a card app build. Refusing to rebuild the app for a folder upload.')
    process.exit(1)
  }
  if (!existsSync(source)) {
    console.error(`public/${only} does not exist. Add the project there, then publish with --only ${only}.`)
    process.exit(1)
  }
  const builders = [`scripts/build-${only}.mjs`]
  for (const builder of builders) {
    if (!existsSync(path.join(root, builder))) continue
    run(process.execPath, [builder])
    break
  }
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })
  for (const fileName of ['_redirects', '_routes.json', '_headers']) {
    const filePath = path.join(root, 'public', fileName)
    if (existsSync(filePath)) cpSync(filePath, path.join(root, 'dist', fileName))
  }
  console.log(`Updated dist/${only} without rebuilding the card app.`)
} else {
  run(process.execPath, ['scripts/build-pages.mjs'])
}

run(process.execPath, ['scripts/assert-pages-api.mjs'])
run('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', 'cardgenie', '--branch', 'main', '--commit-dirty=true'])
