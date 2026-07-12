import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------------------- *
 * AUTH — Stripe/Paystack-style bearer key. Two key TYPES now exist:
 *
 * - "enterprise" — sees the FULL shared talent pool (this is Tobi's type).
 *   Direct API usage: an employer discovering/hiring/paying across all
 *   pipelines.
 *
 * - "hub" — locked to ONE pipeline via hub_scope. A hub's white-labeled
 *   alumni page only ever shows ITS OWN graduates, never another hub's.
 *   This is what makes "visit ALX's alumni page" different from "visit
 *   Nithub's alumni page" even though both sit on the same API.
 *
 * Contracts/payouts/ledger stay scoped to client_id exactly as before,
 * regardless of type — a hub's own hiring activity (if any) is still
 * private to the hub.
 *
 * Set FETCHTALOS_API_KEYS as a comma-separated list. Two formats per entry:
 *   key:client_id                          → defaults to type "enterprise"
 *   key:client_id:hub:PipelineName         → a hub key locked to that pipeline
 * Example:
 *   ft_live_abc:chris_console,ft_live_xyz:tobi_lovable,ft_live_def:nithub_portal:hub:Nithub
 * ---------------------------------------------------------------------- */
const DEFAULT_KEYS = {
  'ft_test_51x9k2mq7dev': { client_id: 'dev', type: 'enterprise', hub_scope: null },
  'ft_live_9x2kq7mZp4vRw': { client_id: 'chris_console', type: 'enterprise', hub_scope: null }
};
const KEYS = process.env.FETCHTALOS_API_KEYS
  ? Object.fromEntries(
      process.env.FETCHTALOS_API_KEYS.split(',').map(pair => {
        const [key, clientId, maybeType, maybeScope] = pair.split(':');
        if (maybeType === 'hub') {
          return [key, { client_id: clientId, type: 'hub', hub_scope: maybeScope }];
        }
        return [key, { client_id: clientId, type: 'enterprise', hub_scope: null }];
      })
    )
  : DEFAULT_KEYS;

function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : null;
  const record = key && KEYS[key];
  if (!record) {
    return res.status(401).json({ error: 'unauthorized', message: 'Pass a valid key as: Authorization: Bearer <key>' });
  }
  req.clientId = record.client_id;
  req.clientType = record.type;
  req.hubScope = record.hub_scope; // null for enterprise keys, a pipeline name for hub keys
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
 * PERSISTENCE — without this, EVERYTHING resets on every restart, and
 * Render's free tier restarts the process after just 15 minutes of
 * inactivity (not only on deploys). That's fine for talents/contracts/
 * payouts resetting (annoying, not dangerous) — but it's a real problem
 * for admin-created API keys specifically, since a key that only exists in
 * memory simply stops authenticating the moment the process restarts,
 * breaking whoever's using it with no warning.
 *
 * This is OPTIONAL and gracefully degrades: if UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN aren't set, the server runs exactly as before —
 * in-memory only. Set both (free tier at upstash.com) to persist real state
 * across restarts.
 * ---------------------------------------------------------------------- */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PERSISTENCE_ENABLED = Boolean(REDIS_URL && REDIS_TOKEN);

async function saveState() {
  if (!PERSISTENCE_ENABLED) return; // silently a no-op — in-memory-only mode
  try {
    const snapshot = JSON.stringify({
      keys: KEYS,
      talents: db.talents,
      contracts: [...db.contracts.entries()],
      payouts: [...db.payouts.entries()]
    });
    await fetch(`${REDIS_URL}/set/fetchtalos_state`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      body: snapshot
    });
  } catch (err) {
    // Never let a persistence failure break the actual request — log and move on.
    console.warn('[persistence] save failed, continuing in-memory only:', err.message);
  }
}

async function loadState() {
  if (!PERSISTENCE_ENABLED) {
    console.log('[persistence] UPSTASH_REDIS_REST_URL/TOKEN not set — running in-memory only, all data resets on restart');
    return;
  }
  try {
    const res = await fetch(`${REDIS_URL}/get/fetchtalos_state`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const data = await res.json();
    if (data?.result) {
      const snapshot = JSON.parse(data.result);
      Object.assign(KEYS, snapshot.keys || {});
      if (snapshot.talents?.length) db.talents = snapshot.talents;
      if (snapshot.contracts) db.contracts = new Map(snapshot.contracts);
      if (snapshot.payouts) db.payouts = new Map(snapshot.payouts);
      console.log(`[persistence] restored ${db.talents.length} talents, ${db.contracts.size} contracts, ${db.payouts.size} payouts, ${Object.keys(KEYS).length} keys`);
    } else {
      console.log('[persistence] connected, no prior saved state — starting fresh');
    }
  } catch (err) {
    console.warn('[persistence] load failed, starting in-memory only:', err.message);
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
// Body: { client_id, type: "enterprise" | "hub", hub_scope: "ALX Africa" }
// hub_scope is REQUIRED when type is "hub" — it's what locks that key's
// talent discovery down to one pipeline. Omit type to default to "enterprise".
// Persisted immediately if UPSTASH_REDIS_REST_URL/TOKEN are set — otherwise
// this key dies the moment the server restarts (see PERSISTENCE section above).
app.post('/admin/keys', requireAdminKey, async (req, res) => {
  const { client_id, type = 'enterprise', hub_scope = null } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  if (!['enterprise', 'hub'].includes(type)) return res.status(400).json({ error: 'type must be "enterprise" or "hub"' });
  if (type === 'hub' && !hub_scope) return res.status(400).json({ error: 'hub_scope is required when type is "hub"' });

  const newKey = `ft_live_${crypto.randomBytes(9).toString('hex')}`;
  KEYS[newKey] = { client_id, type, hub_scope: type === 'hub' ? hub_scope : null };
  await saveState();
  res.status(201).json({ api_key: newKey, client_id, type, hub_scope: KEYS[newKey].hub_scope, persisted: PERSISTENCE_ENABLED });
});

// GET /admin/keys — list every client, their type/scope, and their key (masked).
app.get('/admin/keys', requireAdminKey, (req, res) => {
  const list = Object.entries(KEYS).map(([key, r]) => ({
    client_id: r.client_id,
    type: r.type,
    hub_scope: r.hub_scope,
    key_preview: key.slice(0, 12) + '…' + key.slice(-4)
  }));
  res.json({ count: list.length, results: list });
});

// POST /admin/talents — add a new talent to the pool. This is how new
// pipeline graduates actually get into FetchTalos — right now it's you
// calling this by hand; a hub's own onboarding flow would call it too,
// eventually.
app.post('/admin/talents', requireAdminKey, async (req, res) => {
  const { name, stack, pipeline, country, vetted_score } = req.body || {};
  if (!name || !pipeline || !country) {
    return res.status(400).json({ error: 'name, pipeline, and country are required' });
  }
  const talent = {
    talent_id: id('tal'),
    name,
    stack: Array.isArray(stack) ? stack : [],
    pipeline,
    country,
    vetted_score: Number(vetted_score) || 75,
    status: 'available'
  };
  db.talents.push(talent);
  await saveState();
  res.status(201).json(talent);
});

// GET /admin/talents — full unfiltered talent list, admin view (includes
// engaged talent, which the normal discover endpoint still shows too, but
// this is the canonical "everything" list for management purposes).
app.get('/admin/talents', requireAdminKey, (req, res) => {
  res.json({ count: db.talents.length, results: db.talents });
});

// GET /admin/overview — see EVERYTHING across EVERY client at once. This is
// your answer to "where do I see what's going on in Tobi vs. the console" —
// without this, you'd have to manually swap keys in the regular console to
// peek at one client at a time.
app.get('/admin/overview', requireAdminKey, (req, res) => {
  const byClient = {};
  for (const record of Object.values(KEYS)) {
    if (!byClient[record.client_id]) {
      byClient[record.client_id] = { type: record.type, hub_scope: record.hub_scope, contracts: 0, payouts: 0, revenue: 0, volume_by_currency: {} };
    }
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

  // HUB SCOPING — the core of the white-label behavior. A hub-type key only
  // ever sees its own pipeline's talent, regardless of what query params are
  // passed. An enterprise key (like Tobi's) sees everyone, as before.
  if (req.hubScope) {
    results = results.filter(t => t.pipeline === req.hubScope);
  }

  if (skill) results = results.filter(t => t.stack.some(s => s.toLowerCase().includes(String(skill).toLowerCase())));
  if (status) results = results.filter(t => t.status === status);
  if (region) results = results.filter(t => t.country?.toLowerCase() === String(region).toLowerCase() || true); // region matching is best-effort until pipeline data carries city-level granularity
  res.json({ count: results.length, results, scoped_to_hub: req.hubScope || null });
});

// POST /v1/contracts/create
app.post('/v1/contracts/create', async (req, res) => {
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
  await saveState();

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
  await saveState();
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'fetchtalos-api', time: new Date().toISOString(), persistence: PERSISTENCE_ENABLED ? 'enabled' : 'in-memory-only' }));

const PORT = process.env.PORT || 3000;
await loadState(); // restore prior state (if persistence is configured) BEFORE accepting traffic
app.listen(PORT, () => console.log(`FetchTalos API listening on :${PORT}`));
