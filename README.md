# Digital Legacy Manager

A secure web application prototype for managing and protecting digital
assets — social media accounts, emails, cloud storage, financial accounts and
important documents — with vault storage, trusted beneficiaries, digital-will
instructions, security controls and full audit logging.

**Problem-Based Learning Project — Department of CSE, HITAM (2026–2027)**

Team: M. Nandhini, M. Sahasrika, M. Upagnya, Neha Deepak
Guide: Mr. Dharmendra K Roy

## What this is

This is a **full-stack application** — a real Express + PostgreSQL backend
behind the same front-end UI from the original prototype. Every piece of app
data (accounts, assets, beneficiaries, digital-will instructions, legacy
messages, the audit log, security settings) lives in a real Postgres
database and is served over a real HTTP API, not `localStorage`.

What's genuinely real:
- **Passwords** are hashed with bcrypt — never stored or transmitted in
  plain text.
- **Login sessions** are signed JWTs backed by a `sessions` table, so
  logging out (or an admin revoking a session) invalidates the token
  immediately, server-side — not just in the browser.
- **Verification codes** (email verification, login 2FA, password reset,
  beneficiary email verification) are generated server-side with
  `crypto.randomInt`, only their salted hash is stored, and they expire
  after 10 minutes with a 5-attempt lockout.
- **Every list, form and delete** goes through a real validated REST
  endpoint scoped to the logged-in user — one user can never see or modify
  another user's data.

What's still a deliberate prototype simplification, by design:
- **No real email delivery.** Instead of wiring up an email provider, every
  endpoint that would send a verification code returns it directly in the
  API response, and the UI shows it on screen labeled "Prototype demo — no
  real email sent." The code itself is real (freshly generated, hashed,
  checked server-side, expires, rate-limited) — only the delivery channel
  is short-circuited for local demoing.
- **No TLS / production hardening.** This runs over plain HTTP on
  `localhost`, which is fine for a local demo but not how you'd deploy it.

## Project structure

```
digital-legacy-manager-project/
├── index.html              # Page structure (landing page, auth screen, app shell, views)
├── css/
│   └── styles.css          # All styling — design tokens, layout, components, light/dark themes
├── js/
│   ├── api.js               # Fetch client for the backend — every network call lives here
│   └── app.js                # UI state, rendering, forms — calls js/api.js for all data
├── server/
│   ├── docker-compose.yml    # One-command local Postgres
│   ├── .env.example          # Copy to .env and adjust if needed
│   ├── package.json
│   ├── db/
│   │   └── schema.sql        # Full Postgres schema
│   └── src/
│       ├── index.js          # Express app entry point
│       ├── db/
│       │   ├── pool.js       # Postgres connection pool
│       │   ├── migrate.js    # Applies schema.sql
│       │   └── seed.js       # Seeds the demo@vault.app account with sample data
│       ├── middleware/
│       │   └── auth.js       # JWT verification + live session-revocation check
│       ├── routes/            # assets, beneficiaries, instructions, messages, audit, security, auth
│       └── utils/             # otp, jwt, serialize, validators, audit, asyncHandler
└── README.md
```

## Running it

You need [Node.js](https://nodejs.org) (18+) and [Docker](https://www.docker.com/)
installed. Two things need to run: the backend API + database, and the
front-end (any static file server).

### 1. Start Postgres

```bash
cd server
docker compose up -d
```

This starts a Postgres 16 container on `localhost:5432` with a database
called `dlm_db`. Data persists in a Docker volume between restarts. To stop
it later: `docker compose down` (add `-v` to also wipe the data).

### 2. Set up and start the backend

```bash
cd server
cp .env.example .env      # defaults already match docker-compose.yml
npm install
npm run migrate           # creates all tables
npm run seed               # creates the demo@vault.app account with sample data
npm run dev                 # starts the API on http://localhost:4000
```

Leave this running. You should see `Digital Legacy Manager API listening on
http://localhost:4000` in the terminal.

### 3. Serve the front-end

In a second terminal, from the project root (not `server/`):

```bash
python3 -m http.server 5500
```

(Any static server works — VS Code's Live Server extension on port 5500 is
fine too. Port 5500 matches the default `CLIENT_ORIGIN` in `.env`; if you use
a different port, update `CLIENT_ORIGIN` in `server/.env` and restart the
backend.)

Then open **http://localhost:5500** in your browser.

## Using the demo

- On the landing page, click **Enter the vault** or **Log in**.
- Click **use the demo vault** to sign in as `demo@vault.app` / `demo1234`
  (a pre-seeded account with 8 sample assets, 3 beneficiaries, instructions,
  messages and an audit trail) — or sign up with your own name/email to
  start from an empty vault.
- Every login and signup asks for a 6-digit code. Since there's no real
  email service wired up, the code is shown right on screen in a "Prototype
  demo" banner — just read it and type it in (or paste it).
- Everything is editable: add, edit and delete assets, beneficiaries,
  digital-will instructions and legacy messages from their respective pages
  — every change is now saved to the real Postgres database, not just your
  browser.
- Toggle light/dark mode from the top bar.

If the frontend ever shows "Can't reach the server," it means the backend
in `server/` isn't running — go back to step 2.

## Features implemented (mapped to the abstract)

- **Digital vault** — catalog assets across 6 categories (social media,
  email, cloud storage, financial accounts, documents, crypto & wallets)
- **Beneficiary management** — trusted nominees with relationship, contact,
  trust level, and a real per-beneficiary email verification flow (a
  genuine server-issued code, not a checkbox)
- **Digital will & legacy messages** — instructions with configurable
  trigger conditions (inactivity period, verified death certificate, manual
  release by executor) and scheduled messages
- **Authentication** — signup/login with hashed passwords and mandatory
  email-code verification, forgot-password flow, change-password
- **Security controls** — real two-factor authentication (server-issued and
  verified codes), login alerts, inactivity trigger period, and active
  session management with genuine server-side revocation
- **Audit logging** — every action is recorded server-side, time-stamped,
  filterable by status, exportable as CSV
- **Legacy readiness dashboard** — a checklist and percentage score
  summarizing how complete a user's plan is

## A note on the earlier prototype

An earlier version of this project was a single static HTML page that kept
all its data in the browser's `localStorage` — no server, no database,
anyone opening it got a fresh demo. That version is superseded by this one:
a real backend can't run inside a static page or a hosted single-file
artifact, so if you have a link to that earlier prototype floating around,
this repository (with the `server/` folder) is the one to use going forward.

## Notes for submission / demo

- This is a real client-server application: Express + PostgreSQL on the
  backend, talking to the same UI from the original prototype over a REST
  API secured with JWTs and bcrypt-hashed passwords.
- The one deliberate shortcut is email delivery — verification codes are
  shown on screen instead of emailed, so the project can be demoed entirely
  offline/locally without needing a real mail provider's credentials.
- Natural next steps, per the "Future Work" section of the project: wire up
  a real email provider (e.g. SendGrid) in place of the on-screen dev code,
  add HTTPS + a production deployment, platform integrations, AI-assisted
  categorization, blockchain verification, and a mobile app.
