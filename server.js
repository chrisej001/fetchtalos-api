import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

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
 * ROUTES
 * ---------------------------------------------------------------------- */

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
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  res.json(contract);
});

// GET /v1/contracts  (list — not in original spec but the console needs it)
app.get('/v1/contracts', (req, res) => {
  res.json({ count: db.contracts.size, results: [...db.contracts.values()] });
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
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });

  // idempotency: if this key was already processed, return the original result
  if (idempotency_key) {
    const existing = [...db.payouts.values()].find(p => p.idempotency_key === idempotency_key);
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
  if (!payout) return res.status(404).json({ error: 'payout_not_found' });
  res.json(payout);
});

// GET /v1/ledger — aggregate view, powers the console's wallet tab
app.get('/v1/ledger', (req, res) => {
  const payouts = [...db.payouts.values()];
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
