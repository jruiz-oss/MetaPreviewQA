# Social Ad QA Tool

Internal QA tool for reviewing social ad previews against work orders. Built with Next.js + Claude AI.

## What it does

1. Paste the work order description
2. Add ad unit names + preview links (one per format — static, carousel, etc.)
3. Claude fetches each preview link, reads the copy, and checks against the WO for:
   - Copy/creative alignment
   - Correct promo month & dates
   - URL/CTA destination
   - Grammar & typos
4. Returns a pass/fail checklist per ad unit + a summary of critical issues

---

## Setup (local dev)

**Requirements:** Node.js 18+, npm

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_ORG/social-ad-qa.git
cd social-ad-qa

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env.local
# Edit .env.local and fill in all three values (see below)

# 4. Run locally
npm run dev
# Opens at http://localhost:3000
```

### Environment variables (`.env.local`)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key — get from [console.anthropic.com](https://console.anthropic.com) |
| `SITE_PASSWORD` | The shared team password (e.g. `commit2026`) |
| `AUTH_TOKEN` | Any long random string used as the auth cookie value (e.g. `x7k2mq9r4j`) |

---

## Deploy to Vercel

```bash
# Push to GitHub first
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_ORG/social-ad-qa.git
git push -u origin main
```

Then:

1. Go to [vercel.com](https://vercel.com) → **Add New Project** → import your GitHub repo
2. Vercel auto-detects Next.js — no build settings to change
3. Go to **Settings → Environment Variables** and add:
   - `ANTHROPIC_API_KEY`
   - `SITE_PASSWORD`
   - `AUTH_TOKEN`
4. Click **Deploy**

Every push to `main` auto-deploys. Done.

---

## Notes

- **Preview link access:** Links must be publicly viewable without a Meta login. If a link requires login, Claude will flag it as unverifiable and mark that check as a warning.
- **No database:** Stateless by design — nothing is saved. Each QA run is independent.
- **Auth:** Single shared password stored as an env variable. The cookie lasts 30 days per device.
- **Model:** Uses `claude-sonnet-4-6` by default (set in `app/api/qa/route.ts`).
