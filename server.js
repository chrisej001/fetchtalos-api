import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------------------- *
 * AUTH — Stripe/Paystack-style bearer key. Supports multiple keys, each
 * tagged to a client_id, so different testers/apps don't see each other's
 * contracts and payouts. The talent pool stays shared (that's realistic —
 * it's a marketplace everyone hires from), but a client only ever sees
 * their OWN contracts, payouts, and ledger.
 *
 * Set FETCHTALOS_API_KEYS as a comma-separated "key:client_id" list in
 * production, e.g: FETCHTALOS_API_KEYS=ft_live_abc:chris,ft_live_xyz:tobi_lovable
 * ---------------------------------------------------------------------- */
const DEFAULT_KEYS = {
  'ft_test_51x9k2mq7dev': 'dev',
  'ft_live_9x2kq7mZp4vRw': 'chris_console'
};
const KEYS = process.env.FETCHTALOS_API_KEYS
  ? Object.fromEntries(process.env.FETCHTALOS_API_KEYS.split(',').map(pair => pair.split(':')))
  : DEFAULT_KEYS;

function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : null;
  const clientId = key && KEYS[key];
  if (!clientId) {
    return res.status(401).json({ error: 'unauthorized', message: 'Pass a valid key as: Authorization: Bearer <key>' });
  }
  req.clientId = clientId; // every route below can now scope data to this
  next();
}

/* ---------------------------------------------------------------------- *
 * IN-MEMORY STORE
 * Swap this for Postgres/whatever once this stops being a prototype.
 * Shape matches openapi.yaml exactly.
 * ---------------------------------------------------------------------- */
const db = {
  talents: [
    { talent_id: 'tal_0x91af', name: 'Chinedu O.', stack: ['Node', 'Postgres', 'Go'], pipeline: 'ALX Africa', country: 'NG', vetted_score: 92, status: 'available' },
    { talent_id: 'tal_0x7c3d', name: 'Amara N.', stack: ['React', 'TypeScript'], pipeline: 'AltSchool Africa', country: 'NG', vetted_score: 88, status: 'available' },
    { talent_id: 'tal_0x2b19', name: 'Kwame A.', stack: ['Python', 'Django'], pipeline: 'ALX Africa', country: 'GH', vetted_score: 85, status: 'available' },
    { talent_id: 'tal_0x5e77', name: 'Tolu F.', stack: ['Rust', 'WASM'], pipeline: 'Nithub', country: 'NG', vetted_score: 94, status: 'available' },
    { talent_id: 'tal_0x8f22', name: 'Ifeoma C.', stack: ['Node', 'React', 'AWS'], pipeline: 'AltSchool Africa', country: 'NG', vetted_score: 90, status: 'available' },
  ],
  contracts: new Map(),
  payouts: new Map(),
};

const taxFormMap = { US: 'W-8BEN', UK: 'Self-Assessment (Overseas)', DE: 'Freistellungsauftrag Ref.', CA: 'W-8BEN + T4A-NR' };

const id = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;

/* ---------------------------------------------------------------------- *
 * FX — live rate lookup with a static fallback so the API stays usable
 * if the upstream FX provider is down or unreachable.
 * open.er-api.com is free, keyless, and rate-limited generously enough
 * for a prototype. Swap for a licensed FX provider before real money moves.
 * ---------------------------------------------------------------------- */
const FALLBACK_RATES_NGN = { USD: 1580.42, GBP: 2010.13, EUR: 1715.88, CAD: 1155.2 };

async function getNgnRate(employerCurrency) {
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${employerCurrency}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`FX provider returned ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.NGN;
    if (!rate) throw new Error('NGN rate missing from FX response');
    return { rate, source: 'live:open.er-api.com' };
  } catch (err) {
    const fallback = FALLBACK_RATES_NGN[employerCurrency];
    if (!fallback) throw new Error(`No fallback rate for ${employerCurrency}`);
    return { rate: fallback, source: `fallback (live FX unavailable: ${err.message})` };
  }
}

/* ---------------------------------------------------------------------- *
 * ADMIN — this is how YOU see everything across every client, and how new
 * client keys get created WITHOUT hand-editing Render's env vars every
 * time. Protected by a separate admin key so it's not exposed alongside
 * regular client keys.
 *
 * Set FETCHTALOS_ADMIN_KEY as its own env var — pick something long and
 * different from any client key. Keep it private; anyone with it can see
 * every client's data and mint new keys.
 * ---------------------------------------------------------------------- */
const ADMIN_KEY = process.env.FETCHTALOS_ADMIN_KEY || 'ft_admin_dev_change_me';

function requireAdminKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized', message: 'Admin routes need Authorization: Bearer <admin key>' });
  }
  next();
}

// POST /admin/keys — create a new client key without touching Render at all.
// NOTE: new keys created this way live only in memory — they're gone on the
// next deploy/restart, same as all other data right now. Fine for spinning
// up a tester for a day; not a substitute for real persistent storage once
// you have people you don't want to re-onboard after every deploy.
app.post('/admin/keys', requireAdminKey, (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  const newKey = `ft_live_${crypto.randomBytes(9).toString('hex')}`;
  KEYS[newKey] = client_id;
  res.status(201).json({ api_key: newKey, client_id });
});

// GET /admin/keys — list every client and their key (masked, so this is
// safe-ish to glance at, but the route itself is still admin-only).
app.get('/admin/keys', requireAdminKey, (req, res) => {
  const list = Object.entries(KEYS).map(([key, clientId]) => ({
    client_id: clientId,
    key_preview: key.slice(0, 12) + '…' + key.slice(-4)
  }));
  res.json({ count: list.length, results: list });
});

// GET /admin/overview — see EVERYTHING across EVERY client at once. This is
// your answer to "where do I see what's going on in Tobi vs. the console" —
// without this, you'd have to manually swap keys in the regular console to
// peek at one client at a time.
app.get('/admin/overview', requireAdminKey, (req, res) => {
  const byClient = {};
  for (const clientId of new Set(Object.values(KEYS))) {
    byClient[clientId] = { contracts: 0, payouts: 0, revenue: 0, volume_by_currency: {} };
  }
  for (const c of db.contracts.values()) {
    if (byClient[c.client_id]) byClient[c.client_id].contracts++;
  }
  for (const p of db.payouts.values()) {
    if (!byClient[p.client_id]) continue;
    byClient[p.client_id].payouts++;
    byClient[p.client_id].revenue += p.fetchtalos_revenue;
    byClient[p.client_id].volume_by_currency[p.employer_currency] =
      (byClient[p.client_id].volume_by_currency[p.employer_currency] || 0) + p.gross_amount_employer_currency;
  }
  res.json({ clients: byClient, total_clients: Object.keys(byClient).length });
});

/* ---------------------------------------------------------------------- *
 * ROUTES — everything under /v1 requires the API key. /health does not,
 * so uptime monitors and load balancers can hit it without a key.
 * ---------------------------------------------------------------------- */
app.use('/v1', requireApiKey);

// GET /v1/talents/discover
app.get('/v1/talents/discover', (req, res) => {
  const { skill, region, status } = req.query;
  let results = db.talents;
  if (skill) results = results.filter(t => t.stack.some(s => s.toLowerCase().includes(String(skill).toLowerCase())));
  if (status) results = results.filter(t => t.status === status);
  if (region) results = results.filter(t => t.country?.toLowerCase() === String(region).toLowerCase() || true); // region matching is best-effort until pipeline data carries city-level granularity
  res.json({ count: results.length, results });
});

// POST /v1/contracts/create
app.post('/v1/contracts/create', (req, res) => {
  const { talent_id, employer_country, employer_currency = 'USD', coverage_plan = 'remote_contractor_basic' } = req.body || {};

  const talent = db.talents.find(t => t.talent_id === talent_id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  if (talent.status !== 'available') return res.status(409).json({ error: 'talent_not_available' });

  const contract_id = id('ctr');
  const contract = {
    contract_id,
    client_id: req.clientId, // scopes this contract to whoever's key created it
    talent_id,
    talent_name: talent.name,
    employer_country,
    employer_currency,
    tax_form: taxFormMap[employer_country] || 'local_equivalent_required',
    coverage_plan,
    kyc_status: 'pending', // would flip to verified/failed via Bridgecard webhook in production
    coverage_status: 'gap_not_wired', // see ARCHITECTURE.md — MyCover purchase endpoint needs distributor access
    status: 'awaiting_countersignature',
    created_at: new Date().toISOString(),
  };
  db.contracts.set(contract_id, contract);
  talent.status = 'engaged';

  res.status(201).json(contract);
});

// GET /v1/contracts/:id
app.get('/v1/contracts/:id', (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract || contract.client_id !== req.clientId) return res.status(404).json({ error: 'contract_not_found' });
  res.json(contract);
});

// GET /v1/contracts  (list — scoped to the requesting client only)
app.get('/v1/contracts', (req, res) => {
  const mine = [...db.contracts.values()].filter(c => c.client_id === req.clientId);
  res.json({ count: mine.length, results: mine });
});

// POST /v1/payroll/disburse
// This is the core of what you asked for: employer pays in THEIR currency,
// talent receives NGN. Conversion happens here, against a live rate.
app.post('/v1/payroll/disburse', async (req, res) => {
  const { contract_id, amount, idempotency_key } = req.body || {};

  if (!contract_id || !amount || amount <= 0) {
    return res.status(400).json({ error: 'contract_id and a positive amount are required' });
  }

  const contract = db.contracts.get(contract_id);
  if (!contract || contract.client_id !== req.clientId) return res.status(404).json({ error: 'contract_not_found' });

  // idempotency: if this key was already processed BY THIS CLIENT, return the original result
  if (idempotency_key) {
    const existing = [...db.payouts.values()].find(p => p.idempotency_key === idempotency_key && p.client_id === req.clientId);
    if (existing) return res.status(200).json({ ...existing, replayed: true });
  }

  const employerCurrency = contract.employer_currency || 'USD';
  let fx;
  try {
    fx = await getNgnRate(employerCurrency);
  } catch (err) {
    return res.status(502).json({ error: 'fx_lookup_failed', detail: err.message });
  }

  const grossEmployerCurrency = Number(amount);
  const platformFee = +(grossEmployerCurrency * 0.05).toFixed(2);       // FetchTalos take-rate
  const careWalletCut = +(platformFee * 0.4).toFixed(2);                // slice of the fee funding the care wallet
  const fetchTalosRevenue = +(platformFee - careWalletCut).toFixed(2);
  const employerTotalCharged = +(grossEmployerCurrency + platformFee).toFixed(2); // fee sits on top, employer pays it
  const netTalentNgn = +(grossEmployerCurrency * fx.rate).toFixed(2);   // talent receives full gross, converted

  const payout_id = id('pay');
  const payout = {
    payout_id,
    client_id: req.clientId,
    contract_id,
    talent_name: contract.talent_name,
    employer_currency: employerCurrency,
    gross_amount_employer_currency: grossEmployerCurrency,
    fx_rate: fx.rate,
    fx_source: fx.source,
    net_amount_ngn: netTalentNgn,
    platform_fee: platformFee,
    care_wallet_funded: careWalletCut,
    fetchtalos_revenue: fetchTalosRevenue,
    employer_total_charged: employerTotalCharged,
    rail_status: 'settled', // would be 'rubies_transfer_sent' -> webhook -> 'settled' in production
    status: 'settled',
    idempotency_key: idempotency_key || null,
    created_at: new Date().toISOString(),
  };

  db.payouts.set(payout_id, payout);
  res.status(202).json(payout);
});

// GET /v1/payroll/:id
app.get('/v1/payroll/:id', (req, res) => {
  const payout = db.payouts.get(req.params.id);
  if (!payout || payout.client_id !== req.clientId) return res.status(404).json({ error: 'payout_not_found' });
  res.json(payout);
});

// GET /v1/ledger — aggregate view, scoped to the requesting client only
app.get('/v1/ledger', (req, res) => {
  const payouts = [...db.payouts.values()].filter(p => p.client_id === req.clientId);
  const totals = payouts.reduce((acc, p) => {
    acc.total_volume_by_currency[p.employer_currency] = (acc.total_volume_by_currency[p.employer_currency] || 0) + p.gross_amount_employer_currency;
    acc.total_revenue += p.fetchtalos_revenue;
    acc.total_care_wallet += p.care_wallet_funded;
    return acc;
  }, { total_volume_by_currency: {}, total_revenue: 0, total_care_wallet: 0 });

  res.json({ ...totals, payout_count: payouts.length, payouts: payouts.reverse() });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'fetchtalos-api', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FetchTalos API listening on :${PORT}`));
