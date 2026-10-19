# Statement Dashboard

Static dashboard (vanilla HTML/CSS/JS, no build step) for the bank-statement
parser. Reads/writes through a Cloudflare Worker → Koofr. Mobile-first,
Material Design 3.

**This repo is front-end only** — it contains no statement PDFs and no parsed
financial data. All data lives behind the Worker.

## Run locally

Serve over HTTP (ES modules need it; opening the file directly won't work):

```sh
python -m http.server 8099
# open http://localhost:8099
```

## Deploy (GitHub Pages)

Pushing to `main` triggers `.github/workflows/deploy.yml`, which publishes the
repo root to Pages. One-time setup:

1. Create a GitHub repo and push this folder to it (see commands below).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`; the Action deploys to `https://<user>.github.io/<repo>/`.

```sh
git init -b main
git add .
git commit -m "Statement dashboard"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

## Configuration

`js/config.js`:
- `API_BASE` — the Worker URL (no trailing slash).
- `AUTH_SECRET` — bearer token the Worker expects. **Public once deployed**
  (anyone can read it in the browser) — treat as obfuscation, not a real
  secret. See the Worker's README for hardening options (Cloudflare Access).
- `LLM_BRIDGE` — local Python bridge URL for the Merchants tab's 🤖 Suggest
  button. Only works when the dashboard is opened on the same PC running
  `python llm_bridge.py`; ignored elsewhere.

## Tabs

Overview · Cards · Transactions · Add · Merchants · Cash Back · Instalments ·
Settings.

## Android app

`mobile/` wraps the **same** `index.html` + `app.css` + `js/` in a Capacitor WebView
(same approach as the cashback_sspn app). `mobile/scripts/build-www.mjs` copies them into
`mobile/www`, vendors Chart.js (boots offline), and leaves out two things the phone can't use:

- the **Merchants** tab (merchant clean-up runs through the local enrichment flow on the PC);
- the **local LLM bridge** (`LLM_BRIDGE`, its Settings rows and health probe).

The edits must match the source exactly — if `app.js`/`settings.js`/`config.js` change shape,
the build fails and names the file to update in the script.

- **Worker / CORS**: served in the WebView as `https://jgjy926.github.io`
  (`server.hostname`), which the Worker's allowlist already accepts.
- **Back button**: closes the bottom sheet → returns to Overview → backgrounds the app.
  Returning after 2+ minutes re-reads the Worker (`js/mobile.js`).

Build (needs Android Studio for its JDK + Android SDK):
```bash
cd mobile
npm install
# PowerShell: $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
npm run android:apk
# -> mobile/android/app/build/outputs/apk/debug/app-debug.apk
```
