# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FetchTalos: an employer pays in USD/GBP/EUR/CAD (or NGN directly), a talent in Nigeria receives NGN.
Talent discovery and contracts exist because payroll needs something to disburse against — the core
product is `/v1/payroll/disburse` and, for NGN-native contracts, the automatic Felicity settlement
pipeline. This is a working prototype connected to several real (sandbox-capable) third-party APIs,
not a toy — money-shaped logic here is meant to be taken seriously even though persistence and some
integrations gracefully degrade when unconfigured.

## Commands

```bash
npm install
npm start          # node server.js — listens on :3000 (or $PORT)
npm run dev         # node --watch server.js — auto-restart on change
```

No test suite, linter, or build step exists in this repo — there is nothing to run beyond starting
the server. Node >=18 is required (native `fetch`, no HTTP client dependency).

Manual verification loop: start the server, then open `console.html`, `admin.html`, or
`hub-dashboard.html` directly in a browser (no build/serve step needed for the HTML files — they're
static and call the API by URL). `console.html` defaults to `http://localhost:3000` and the dev key
below.

Auth for `/v1/*` routes: `Authorization: Bearer ft_test_51x9k2mq7dev` (dev default, set in
`server.js`'s `DEFAULT_KEYS`). Admin routes (`/admin/*`) use a separate key:
`FETCHTALOS_ADMIN_KEY` (defaults to `ft_admin_dev_change_me`).

## Architecture

Everything server-side lives in one file, `server.js` (~3600 lines), organized into clearly
commented sections (search for `/* ----` block headers) in roughly this order: auth/keys, in-memory
store, offer-letter PDF generation, FX lookup, email, MyCover/Felicity insurance, Fincra/USD-rail
salary accounts, pay periods, Felicity NGN rail, Dropbox Sign (W-8BEN), persistence, admin routes,
then the `/v1/*` route handlers, then webhooks. When making a change, find the relevant section
comment first rather than assuming route handlers are self-contained — most business logic lives in
helper functions above the routes, not inline in the `app.get/post` callbacks.

There are three static frontends, each a single self-contained HTML file with inline JS/CSS (no
bundler, no framework): `console.html` (enterprise/API console — talent pool, contracts, payroll,
ledger), `admin.html` (cross-client admin view + key minting), `hub-dashboard.html` (a hub's
self-serve view of its own markup/settlement/stats). Follow the existing inline-script style when
editing these — don't introduce a build step.

### Data model & flow

In-memory store (`db` in `server.js`): `talents` (array, seeded), `engagements` (Map),
`contracts` (Map), `payouts` (Map), `payPeriods` (Map), `ngnSettlements` (array, append-only
history). The pipeline is:

```
talent discovery → engagement (interview-invite stage, pre-contract) → contract (accepted → active)
  → payroll (recurring, one pay period per cycle)
```

A **contract**'s `employer_currency` determines which of two structurally different settlement
rails it's on — this split matters for almost every payment-related change:

- **NGN rail** (`employer_currency === 'NGN'`): domestic NG-enterprise → NG-talent. Each talent gets
  a real Rubies NUBAN via Felicity (`onboard_talent`). Insurance is bought directly against that
  balance. Settlement is *automatic*, fired by the `talent.va_credited` webhook
  (`settleNgnPayment()`), which explicitly sends out platform fee → hub markup (if any) → talent
  salary, in that order, every time money lands. There is no automatic split — the code does each
  transfer itself via `sendNgn`. If balance can't cover salary + fee + markup in full, **nothing is
  sent to anyone** (salary is never reduced to absorb a shortfall — this was a real bug once).
- **USD/foreign-currency rail** (`disburseOneContract()`, called from `POST /v1/payroll/disburse`):
  the older, purely local Fincra-simulation path — computes FX via `getNgnRate()`, no real Fincra
  deposit happens. This function actively **refuses** to run against an NGN contract
  (`error: 'wrong_rail_for_ngn'`) specifically to prevent silently marking a pay period paid without
  real money moving.

`computeAmountDueThisCycle()` is the single source of truth for what a contract owes this cycle —
used both to *display* the amount before an enterprise wires anything and internally by
`settleNgnPayment()` to compute the real split, so the displayed number and the charged number can
never drift apart. Don't duplicate this math elsewhere.

Pay period status (`due` / `overdue` / `paid`) is computed live at read time from `due_date` /
`paid_at`, never stored — there's no cron/scheduler. `settleOldestUnpaidPeriod()` does FIFO matching:
the oldest open period closes on each real settlement, and a fresh next period opens immediately so
there is always exactly one open period per contract.

### Auth model

Two API key types, both bearer tokens checked in `KEYS` (built from `FETCHTALOS_API_KEYS` env var,
or `DEFAULT_KEYS` in dev):
- **enterprise** — sees the full shared talent pool across all pipelines.
- **hub** — locked via `hub_scope` to one pipeline (e.g. "ALX Africa"); a hub's white-labeled page
  only ever shows its own graduates. Hubs can have their own markup (`hub_markup_bps`, capped by
  admin-set `hub_markup_cap_bps`) and settlement account, both self-serve editable via
  `PATCH /v1/hub/*` routes, always re-clamped to the cap server-side.

Contracts/payouts/ledger are scoped by `client_id` regardless of key type.

### Persistence

Fully optional and gracefully degrading: if `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
aren't set, everything is in-memory only and resets on restart (this matters in practice because
Render's free tier restarts after 15 minutes idle, not just on deploy). When set, `saveState()` /
`loadState()` snapshot the whole `db` (plus `KEYS`) to/from a single Redis key. `loadState()`
back-fills any fields missing from a stale persisted talent record using `SEED_TALENTS` as the
schema source of truth — a pattern to follow if you add new talent fields.

### Third-party integrations (all optional, all gracefully degrade)

Each integration checks its own env var(s) and no-ops with an honest status field rather than faking
success when unconfigured — follow this pattern for any new integration:
- **MyCover / Felicity insurance proxy** — `MYCOVER_MODE=direct|proxy`, product IDs per coverage
  plan via `MYCOVER_PRODUCT_ID_*`.
- **Fincra (via Felicity proxy)** — USD virtual accounts for the older rail, `FELICITY_FINCRA_KEY`.
- **Felicity NGN rail** — Rubies NUBANs, direct sends; reuses whichever Felicity key is already set
  (`FELICITY_NGN_PARTNER_KEY` is only an explicit override, not required).
- **Dropbox Sign** — real IRS Form W-8BEN e-signature for US-employer contracts only (the only
  country mapped to W-8BEN in `taxFormMap`). Sends the actual government PDF (`assets/fw8ben.pdf`).
- **Resend** — real email; without `RESEND_API_KEY`, emails log to console instead of failing, so
  flows are still testable end-to-end. Resend sandbox mode only delivers to the signup address —
  use `PATCH /admin/talents/:id` to point a seed talent's email at your own for testing.
- **FX (`open.er-api.com`)** — free/keyless live NGN rate lookup with a static `FALLBACK_RATES_NGN`
  fallback; response always reports `fx_source` (`live` vs `fallback`) rather than hiding a
  degraded lookup.

Webhooks (`/webhooks/felicity`, `/webhooks/mycover`, `/webhooks/felicity-fincra`,
`/webhooks/dropbox-sign`) are verified with HMAC-SHA256 timing-safe comparison
(`verifyFelicitySignature`); Felicity uses one shared secret across all three of its webhook
families by design, not a bug.

### Conventions worth preserving when extending this file

- Money amounts on a contract/payout are always derived from server-stored state
  (`contract.proposed_amount`, etc.), never trusted from the request body — this is deliberate, not
  an oversight, so a client can never pay a talent more/less than what was actually agreed.
- New integrations/features should be optional-by-env-var and fail into a clearly labeled status
  string, never a silent success or a hard crash of the whole request.
- Idempotency keys on payroll disbursement are checked against existing payouts before doing any
  work — preserve this when touching `disburseOneContract` or the NGN settlement path.
- Long block comments before a function often encode a past bug and why the current approach avoids
  it (e.g. the "salary as leftover subtraction" bug in `settleNgnPayment`). Read them before
  "simplifying" logic that looks redundant — it usually isn't.
