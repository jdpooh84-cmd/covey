# PulseCore — AI Business Intelligence Platform

AI-powered competitive analysis, grant discovery, marketing strategy, and content creation for any business.

---

## Files in This Repo

| File | Purpose |
|---|---|
| `index.html` | The entire frontend — all screens, logic, and styles |
| `server_index.js` | Express backend — API proxy, auth, Stripe billing, DB |
| `manifest.json` | PWA manifest — makes app installable on mobile |
| `sw.js` | Service worker — offline shell caching |
| `schema.sql` | Postgres schema reference (server creates tables automatically) |
| `package.json` | Node dependencies |
| `Procfile` | Render start command |
| `.env.example` | Environment variable template — copy to `.env` for local dev |
| `.gitignore` | Keeps secrets and node_modules out of git |
| `icon-192.png` | **YOU MUST ADD THIS** — 192×192 app icon |
| `icon-512.png` | **YOU MUST ADD THIS** — 512×512 app icon |

---

## Deploy to Render (5 steps)

### 1. Push this repo to GitHub
All files above must be in the root of your repo.

### 2. Create a new Web Service on Render
- Connect your GitHub repo
- Runtime: **Node**
- Build command: `npm install`
- Start command: `node server_index.js` (or leave blank — Procfile handles it)

### 3. Add a Postgres Database on Render
- In your Render dashboard: New → PostgreSQL
- Name it anything (e.g. `pulsecore-db`)
- Render automatically sets `DATABASE_URL` on your web service

### 4. Set Environment Variables in Render
Go to your Web Service → Environment → Add each of these:

| Variable | Where to get it | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com | **Yes** |
| `JWT_SECRET` | Any 64-char random string | **Yes** |
| `APP_URL` | Your Render URL (e.g. `https://pulsecore.onrender.com`) | **Yes** |
| `DATABASE_URL` | Auto-set by Render when you add Postgres | **Yes** |
| `STRIPE_SECRET_KEY` | dashboard.stripe.com → Developers → API keys | Optional |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks | Optional |
| `STRIPE_PRICE_ID_PRO` | Stripe Dashboard → Products | Optional |
| `STRIPE_PRICE_ID_AGENCY` | Stripe Dashboard → Products | Optional |
| `ADMIN_EMAIL` | Your email address | Optional |
| `NODE_ENV` | `production` | Recommended |

### 5. Deploy
Render deploys automatically on every push to your main branch.
The server creates the database tables on first startup — no manual migration needed.

---

## Adding App Icons (Required for PWA)

Create two PNG images and add them to the root of your repo:
- `icon-192.png` — 192×192 pixels, your logo
- `icon-512.png` — 512×512 pixels, your logo

Without these files the PWA install prompt will not appear on mobile, but the app still works.

---

## Setting Up Stripe (Optional — for real billing)

1. Create a Stripe account at stripe.com
2. In Stripe Dashboard → Products, create two products:
   - **PulseCore Pro** — $29/month recurring → copy the Price ID
   - **PulseCore Agency** — $99/month recurring → copy the Price ID
3. In Stripe Dashboard → Developers → Webhooks, add an endpoint:
   - URL: `https://your-app.onrender.com/api/billing/webhook`
   - Events to listen for: `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Copy the Signing Secret
4. Add all four Stripe env vars to Render

Without Stripe keys, the app runs in demo mode — upgrades apply instantly without real payment.

---

## Running Locally

```bash
git clone https://github.com/your-username/pulsecore
cd pulsecore
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY and JWT_SECRET
node server_index.js
# Open http://localhost:3000
```

---

## Tech Stack

- **Frontend:** Single-file HTML/CSS/JS — no framework, no build step
- **Backend:** Node.js + Express
- **Database:** Postgres (via `pg` driver) with in-memory fallback
- **AI:** Anthropic Claude (Haiku for speed, Sonnet for quality)
- **Billing:** Stripe Checkout + webhooks
- **Hosting:** Render.com
- **PWA:** manifest.json + service worker

---

## Viewing the App

**Do not open `index.html` directly in your browser or via GitHub's raw/preview viewer.**
The app requires the backend server for API calls to work. Always access it via:
- Local: `http://localhost:3000`
- Production: `https://your-app.onrender.com`
