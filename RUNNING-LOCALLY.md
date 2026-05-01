# Running Locally

The repo now contains the Vite + React app for PKL Universe.

## Recommended

From PowerShell in the project root:

```powershell
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Then open:

- `http://127.0.0.1:5173/#/`

## Blank page or Vite 504 dependency errors

This repo is often run from a Dropbox-synced folder on Windows. To avoid file-lock issues with Vite's optimized dependency cache, `vite.config.js` stores the dev cache under local AppData instead of `node_modules/.vite`.

If the page is blank and the browser console shows errors like `504 (Outdated Optimize Dep)` for `/node_modules/.vite/deps/...`, the browser is using stale Vite module URLs. Fix it by clearing the page cache:

1. Open browser DevTools.
2. Go to the Network tab.
3. Check Disable cache.
4. Press `Ctrl+F5`.

If needed, close all `127.0.0.1:5173` tabs and reopen:

- `http://127.0.0.1:5173/?fresh=1#/`

## Firebase setup for local auth

1. Copy `.env.example` to `.env`.
2. Fill in the Firebase web app values.
3. Restart the Vite dev server if it was already running.

Until `.env` is configured, the app still loads but protected routes will show a Firebase setup message instead of allowing sign-in.

## Production build check

To verify the static build locally:

```powershell
npm run build
```

If Windows has a file lock on `dist`, use a fresh output folder instead:

```powershell
npx vite build --outDir dist-pages-check
```

## GitHub Pages path

The rebuilt app is now set up to live at the site root for its own dedicated repo/domain.

If you later host it on GitHub Pages, the expected URL shape is the root site, for example:

- `https://yourname.github.io/your-repo/`

If you connect a custom domain, that custom domain becomes the primary app URL.

## Deployment notes

For the quickest repeatable GitHub Pages push flow, see:

- `PUSHING-TO-GITHUB-PAGES.md`

## Legacy files

The old single-team implementation is still in the repo as reference material:

- `hawks2026.html`
- `roster-app.js`
- `roster-styles.css`

Those files are no longer the primary local run path for the rebuild.
