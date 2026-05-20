# Running Locally

This repo contains a Vite + React frontend and a small Express API server.

## Recommended

From the project root:

```bash
npm install
npm run dev
```

Then open:

- `http://localhost:5173/`

The `dev` script starts both services:

- Vite frontend: `http://localhost:5173/`
- Express API: `http://localhost:8787/`

## If the Latest Changes Do Not Show

First do a hard refresh in the browser. If the page still looks stale, stop any old local server processes and restart:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:8787 -sTCP:LISTEN
kill <PID>
npm run dev
```

If port `5173` is still busy, Vite may start on another port such as `5174`. Use the `Local:` URL printed by Vite, or stop the old process and restart to get back to `5173`.

## macOS Dependency Permission Fixes

If copied files or downloaded dependencies lose executable permissions, `npm run dev` may fail with errors like `Permission denied`, `EACCES`, or macOS blocking Rollup/esbuild. Fix the local dependency permissions, then restart:

```bash
chmod +x node_modules/.bin/*
chmod +x node_modules/@esbuild/darwin-x64/bin/esbuild
xattr -dr com.apple.quarantine node_modules || true
npm run dev
```

If that still fails, reinstall dependencies:

```bash
rm -rf node_modules
npm install
npm run dev
```

## Local API Setup

Copy `.env.example` to `.env` and fill in the needed values for local API-backed features:

```bash
cp .env.example .env
```

Until `.env` is configured, the app may still load, but API-backed card generation will not work without a valid `OPENAI_API_KEY`.

## Blank Page or Vite 504 Dependency Errors

If the page is blank and the browser console shows errors like `504 (Outdated Optimize Dep)` for `/node_modules/.vite/deps/...`, the browser is using stale Vite module URLs. Fix it by clearing the page cache:

1. Open browser DevTools.
2. Go to the Network tab.
3. Check Disable cache.
4. Hard refresh the page.

If needed, close all local app tabs and reopen:

- `http://localhost:5173/?fresh=1`

## Production Build Check

To verify the static build locally:

```bash
npm run build
```

## GitHub Pages Path

The app is set up to live at the site root for its dedicated repo/domain.

Current custom domain:

- `https://www.card-genie.com/`

GitHub Pages should deploy from the GitHub Actions workflow artifact, not from the raw `main` branch root. If the live site serves `/src/main.tsx`, Pages is serving source files instead of the built Vite `dist` output.
