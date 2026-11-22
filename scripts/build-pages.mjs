#!/usr/bin/env node
/**
 * Build the card site for www.card-genie.com.
 * The local .env leaves VITE_API_BASE_URL blank for dev. This fills it in
 * before Vite runs, so a production build cannot forget the texting service.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!String(process.env.VITE_API_BASE_URL || '').trim()) {
  process.env.VITE_API_BASE_URL = 'https://api.card-genie.com'
}

const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status || 1)
}

run(['node_modules/typescript/bin/tsc', '-b'])
run(['node_modules/vite/bin/vite.js', 'build'])
run(['scripts/assert-pages-api.mjs'])
