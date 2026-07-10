# FetchTalos API

The actual thing: an employer pays in **USD / GBP / EUR / CAD**, a talent in Nigeria
receives **NGN**, converted at a live FX rate at the moment of payout. No Felicity
dependency — this runs standalone.

Talent discovery and contracts are here too because payroll needs *something* to
disburse against, but the core of what you asked for is `/v1/payroll/disburse`.

## Run it

```bash
npm install
npm start
# → FetchTalos API listening on :3000
```

Requires Node 18+ (uses native `fetch`, no extra HTTP client dependency).

**Auth:** every `/v1/*` route requires an API key. Dev default is
`ft_test_51x9k2mq7dev` (set in `server.js`) — send it as
`Authorization: Bearer ft_test_51x9k2mq7dev`. Override it with a real value
via `FETCHTALOS_API_KEY` before you deploy anywhere public:
```bash
FETCHTALOS_API_KEY=your_real_key npm start
```

---

## Three ways to actually use this

### 1. Test it locally right now
Open `console.html` in your browser (just double-click it, no server needed
for the HTML itself). Base URL defaults to `http://localhost:3000`, key
defaults to the dev key above — hit **Connect**, then click through Talent
Pool → Contracts → Payroll → Ledger. Every action is a real HTTP call to your
locally running API, visible in your browser's Network tab if you want to see
the raw requests.

Or skip the UI and use `curl`/Postman/Thunder Client directly — see the
endpoint examples above.

### 2. Connect it to your Lovable project
Lovable runs in the browser, so it can't reach `localhost:3000` on your
machine — you need a public URL. Two options, in order of effort:

**Fast (minutes, temporary):** use ngrok to tunnel your local server publicly.
```bash
npm start                    # your API on :3000
ngrok http 3000               # gives you https://xxxx.ngrok-free.app
```
Use that ngrok URL as the base URL in your Lovable app's fetch calls. It stays
live only while both `npm start` and `ngrok` are running on your machine —
fine for a working session, not for something that needs to stay up.

**Proper (stays up, free tier available):** deploy to Render or Railway —
both auto-deploy a Node app from a GitHub repo with zero config beyond
setting `FETCHTALOS_API_KEY` as an environment variable. Push this folder to
a repo, connect it, and you get a permanent
`https://fetchtalos-api.onrender.com`-style URL. Use that in Lovable.

Either way, in your Lovable frontend code:
```js
const res = await fetch('https://your-fetchtalos-url.com/v1/payroll/disburse', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your_real_key'
  },
  body: JSON.stringify({ contract_id, amount, idempotency_key })
});
```
CORS is already open (`app.use(cors())`), so the browser call will work
without extra config. **One real caveat:** putting your API key directly in
Lovable's frontend JS means it's visible to anyone who views page source —
fine while you're the only one testing, not fine once anyone else can open
that Lovable app. Fix later by routing the call through a tiny backend
function instead of calling FetchTalos directly from the browser.

### 3. Show it to friends
Once you've deployed (option 2, proper route), you have a real public URL.
Two ways to show people:
- **Send them `console.html` + the deployed URL.** They open the file, type
  your URL and a key you've given them into the connect bar, and click
  through it themselves — they're hitting your real, live API.
- **Give them the base URL** and let them hit it directly with curl or
  Postman if they're the type of friend who'd rather do that. The endpoint
  examples above work as-is against any deployed URL.

Don't hand out your real production key for this — generate a separate
throwaway key (just a different string, since there's no key-management
system yet — see the dashboard note below) for anyone outside your own
testing.

## The flow

```
1. GET  /v1/talents/discover        — find someone to hire
2. POST /v1/contracts/create        — bind talent + employer currency to a contract
3. POST /v1/payroll/disburse        — employer pays in their currency, talent gets NGN
4. GET  /v1/ledger                  — running totals across every payout
```

### 1. Find a talent
```bash
curl "localhost:3000/v1/talents/discover?skill=node"
```

### 2. Create a contract — this is where you set the employer's currency
```bash
curl -X POST localhost:3000/v1/contracts/create \
  -H "Content-Type: application/json" \
  -d '{
    "talent_id": "tal_0x91af",
    "employer_country": "US",
    "employer_currency": "USD",
    "coverage_plan": "remote_contractor_plus"
  }'
```
Supported `employer_currency` values right now: `USD`, `GBP`, `EUR`, `CAD`.
Add more by extending `FALLBACK_RATES_NGN` in `server.js` — the live rate lookup
already supports any currency `open.er-api.com` knows about.

### 3. Run payroll — the actual FX conversion happens here
```bash
curl -X POST localhost:3000/v1/payroll/disburse \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "ctr_xxxxxxxx",
    "amount": 2400,
    "idempotency_key": "payroll-2026-07-ctr_xxxxxxxx"
  }'
```
Response includes `fx_rate`, `fx_source` (`live` or `fallback`), and
`net_amount_ngn` — what actually lands with the talent.

`idempotency_key` matters: send the same key twice and you get the same payout
back instead of paying the talent twice. Always set this from something stable
on your side (e.g. `payroll_run_id + contract_id`), not a random value.

### 4. Check the ledger
```bash
curl localhost:3000/v1/ledger
```

## How the FX conversion actually works

`getNgnRate()` in `server.js`:
1. Calls `https://open.er-api.com/v6/latest/{employer_currency}` — free, no API
   key, updates roughly hourly. Fine for validating the idea; **not** a licensed
   FX rate for real money movement.
2. If that call fails (network down, rate-limited, currency not found), it falls
   back to a static rate baked into `FALLBACK_RATES_NGN` and tells you it did so
   via the `fx_source` field in the response. The API never hard-fails a payout
   just because the FX provider hiccuped — it degrades and tells you honestly.

**Before this touches real money**, swap `open.er-api.com` for a licensed FX data
provider (or whatever feed your settlement bank gives you) — a free keyless API
is fine for demos, not for pricing actual payroll.

## Should FetchTalos customers have a dashboard? (Yes — here's when)

Short answer: yes, and it's not optional long-term. Every API-first company
you're benchmarking against — Stripe, Paystack, Flutterwave, Bridgecard
itself — pairs the API with a dashboard, because employers using this need
to see it without writing code: transaction history, contract status,
current API keys, webhook logs. An API with no dashboard is a tool for your
own engineers, not a product an HR person at a client company can use.

**What that dashboard actually needs, roughly in build order:**
1. **API key management** — generate/revoke keys, see which key made which
   call. Right now there's exactly one hardcoded key; that's the first real
   gap versus Stripe/Paystack.
2. **A read-only log view** — this is the closest thing that already exists:
   `/v1/ledger` returns exactly the data a "Payments" tab needs. `console.html`
   is functionally a rough dashboard prototype already, minus multi-tenant
   login.
3. **Docs, embedded** — Stripe's docs live inside the dashboard, not just on
   a separate marketing site. The `openapi.yaml` from earlier can generate
   this automatically (Swagger UI/Redoc) once you're ready.
4. **Sandbox vs. live mode toggle** — Paystack's biggest UX pattern. Lets
   employers integrate against fake money before touching real payroll.
5. **Webhook configuration** — where an employer tells you their endpoint
   URL for `payout.settled` events, since polling isn't how real integrations
   work.

**When to actually build it:** not yet. Right now you have one user (you) and
zero paying employers. A dashboard is worth real weeks of work once you have
even 2-3 employers actually trying to integrate — building it before that
is building for a customer that doesn't exist yet. The API + `console.html`
combination is a reasonable stand-in until that point.

## What's real vs. what's a stub

| Piece | Status |
|---|---|
| FX rate lookup | Real live call, with graceful fallback |
| Fee math (5% platform fee, 40% of that funds care wallet) | Real, computed |
| Idempotency on payroll runs | Real |
| Talent discovery, contract creation | Real logic, fake data — talents are hardcoded, not pulled from ALX/AltSchool APIs |
| `rail_status: 'settled'` on disburse | **Stub.** No money actually moves. This is the one line to replace with a real Rubies MFB (or equivalent) transfer call — see `ARCHITECTURE.md` from the earlier conversation for what that integration needs |
| KYC (`kyc_status: 'pending'`) | **Stub.** Needs Bridgecard `register_cardholder` wired in |
| Coverage (`coverage_status: 'gap_not_wired'`) | **Stub, honestly labeled.** MyCover.ai's purchase endpoint needs a distributor agreement — not something to fake |

## Project shape

```
server.js       — everything. One file on purpose: easy to read top to bottom,
                   easy to hand to someone else, easy to split later once it
                   actually needs to be split.
package.json
```

Two dependencies: `express`, `cors`. Nothing else — no ORM, no FX SDK, no auth
library, because none of that is real yet. Add them when the corresponding stub
above gets replaced with a real integration, not before.
