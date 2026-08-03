# IA Map — Deploy Instructions

NetBramha Studios · Confidential · 2026

---

## What this is
Enter any company URL → scrapes site + competitors → Claude proposes a new IA → renders as interactive explorer.

---

## 1. Deploy the Cloudflare Worker

```bash
npm install -g wrangler
wrangler login

cd IA-Map/worker

# Set secrets (you'll be prompted to type each value)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ALLOWED_ORIGIN   # e.g. https://nb-ia-map.netlify.app

# Deploy
wrangler deploy ia-worker.js --name ia-map-worker --compatibility-date 2024-01-01
```

Note the Worker URL output — you need it for step 2.

---

## 2. Wire the Worker URL into the frontend

In `IA-Map/app.js`, line 9:
```js
const WORKER_URL = 'https://ia-map-worker.YOUR-SUBDOMAIN.workers.dev';
```

Replace `YOUR-SUBDOMAIN` with your Cloudflare account subdomain.

---

## 3. Deploy the frontend to Netlify

```bash
# Option A — Netlify CLI
npm install -g netlify-cli
netlify deploy --dir IA-Map --prod

# Option B — GitHub + Netlify dashboard
# 1. Push this repo to GitHub
# 2. Connect repo in Netlify dashboard
# 3. Set publish directory: IA-Map
# 4. Deploy
```

---

## 4. Test with mock data (no Worker needed)

Open the app with `?mock` in the URL:
```
file:///path/to/IA-Map/index.html?mock
https://your-netlify-url.netlify.app?mock
```

This loads the built-in MOCK_DATA from `app.js` — no API key required.

---

## 5. Update the AI instructions

Edit the `systemPrompt` string inside `worker/ia-worker.js`, then:
```bash
cd IA-Map/worker
wrangler deploy ia-worker.js --name ia-map-worker --compatibility-date 2024-01-01
```
No frontend changes needed.

---

## 6. Rotate the Anthropic API key

```bash
wrangler secret put ANTHROPIC_API_KEY
# Enter new key when prompted
wrangler deploy ia-worker.js --name ia-map-worker --compatibility-date 2024-01-01
```

---

## File structure

```
IA-Map/
├── index.html        ← 3-state frontend (input / loading / result)
├── styles.css        ← All styles
├── renderer.js       ← Canvas renderer (data-driven from AI JSON)
├── app.js            ← State machine, Worker calls, mock data
├── worker/
│   └── ia-worker.js  ← Cloudflare Worker (scrape + Claude synthesis)
├── netlify.toml      ← Netlify config
└── README.md         ← This file
```

---

## Important

The existing `bharti-ia-prototype.html` at the project root is a client deliverable.
**Do not move, modify, or delete it.**
