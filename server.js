import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const multipartParser = multer(); // Dropbox Sign webhooks arrive as multipart/form-data, not JSON — see the DROPBOX SIGN section below

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })); // rawBody needed for webhook signature verification below
app.use(express.urlencoded({ extended: true })); // needed for the talent-facing KYC form below (real HTML forms POST this way, not JSON)

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
const SEED_TALENTS = [
  { talent_id: 'tal_0x91af', name: 'Chinedu O.', email: 'chinedu.demo@example.com', stack: ['Node', 'Postgres', 'Go'], pipeline: 'ALX Africa', country: 'NG', vetted_score: 92, status: 'available' },
  { talent_id: 'tal_0x7c3d', name: 'Amara N.', email: 'amara.demo@example.com', stack: ['React', 'TypeScript'], pipeline: 'AltSchool Africa', country: 'NG', vetted_score: 88, status: 'available' },
  { talent_id: 'tal_0x2b19', name: 'Kwame A.', email: 'kwame.demo@example.com', stack: ['Python', 'Django'], pipeline: 'ALX Africa', country: 'GH', vetted_score: 85, status: 'available' },
  { talent_id: 'tal_0x5e77', name: 'Tolu F.', email: 'tolu.demo@example.com', stack: ['Rust', 'WASM'], pipeline: 'Nithub', country: 'NG', vetted_score: 94, status: 'available' },
  { talent_id: 'tal_0x8f22', name: 'Ifeoma C.', email: 'ifeoma.demo@example.com', stack: ['Node', 'React', 'AWS'], pipeline: 'AltSchool Africa', country: 'NG', vetted_score: 90, status: 'available' },
];

const db = {
  talents: SEED_TALENTS,
  engagements: new Map(), // the interview-invite stage — created BEFORE any contract exists
  contracts: new Map(),
  payouts: new Map(),
  payPeriods: new Map(), // recurring salary pay periods per contract — see PAY PERIODS section below
};

const taxFormMap = { US: 'W-8BEN', UK: 'Self-Assessment (Overseas)', DE: 'Freistellungsauftrag Ref.', CA: 'W-8BEN + T4A-NR' };

const coveragePlanCopy = {
  remote_contractor_basic: {
    label: 'Remote Contractor — Basic',
    benefits: ['Health coverage via MyCover.ai (individual, basic tier)']
  },
  remote_contractor_plus: {
    label: 'Remote Contractor — Plus',
    benefits: ['Health coverage via MyCover.ai (individual, enhanced tier)', 'Priority claims processing']
  },
  remote_contractor_family: {
    label: 'Remote Contractor — Family',
    benefits: ['Health coverage via MyCover.ai (family tier — spouse + dependents)', 'Priority claims processing']
  }
};

/* ---------------------------------------------------------------------- *
 * OFFER LETTER PDF — generated per contract at send-time. This is a real
 * document (role, remuneration, KPIs, benefits), not just an email body.
 * Returns a Buffer. Kept deliberately plain-looking — this is prototype
 * output, not reviewed by counsel, and shouldn't LOOK more official than
 * it is.
 * ---------------------------------------------------------------------- */
function generateOfferLetterPdf({ engagement, contract }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const plan = coveragePlanCopy[engagement.coverage_plan] || coveragePlanCopy.remote_contractor_basic;

    doc.fontSize(18).font('Helvetica-Bold').text(engagement.employer_name || 'Employer', { continued: false });
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('Offer of Engagement');
    doc.moveDown(1.2);

    doc.fillColor('#000').fontSize(11).font('Helvetica').text(`Dear ${engagement.talent_name},`);
    doc.moveDown(0.8);
    doc.text(`We are pleased to offer you the role of ${engagement.role_title || 'Software Engineer'} with ${engagement.employer_name || 'the employer'}, engaged as an independent contractor through FetchTalos infrastructure. This letter sets out the key terms of that engagement.`);
    doc.moveDown(1);

    function section(title, rows) {
      doc.font('Helvetica-Bold').fontSize(12).text(title);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10.5);
      rows.forEach(([k, v]) => {
        doc.font('Helvetica-Bold').text(k + ':  ', { continued: true }).font('Helvetica').text(String(v));
      });
      doc.moveDown(0.9);
    }

    section('Role', [
      ['Title', engagement.role_title || 'Software Engineer'],
      ['Engagement type', 'Independent Contractor'],
      ['Employer jurisdiction', engagement.employer_country],
      ['Contractor jurisdiction', contract.talent_country || 'Nigeria'],
    ]);

    section('Remuneration', [
      ['Amount', `${engagement.proposed_amount} ${engagement.employer_currency} / month`],
      ['Payment method', 'FetchTalos Payroll API — converted to NGN at the live rate on each pay date'],
      ['Tax reporting', contract.tax_form],
    ]);

    doc.font('Helvetica-Bold').fontSize(12).text('Key Responsibilities / KPIs');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10.5);
    const kpis = engagement.kpis?.length ? engagement.kpis : [
      `Deliver against the ${engagement.role_title || 'role'} responsibilities agreed during interview`,
      'Maintain regular communication with the engaging team',
      'Meet delivery milestones as agreed with the employer'
    ];
    kpis.forEach(k => doc.text(`•  ${k}`));
    doc.moveDown(0.9);

    doc.font('Helvetica-Bold').fontSize(12).text('Benefits');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10.5);
    doc.text(`Coverage plan: ${plan.label}`);
    doc.text(`Coverage duration: ${engagement.coverage_months || 1} month(s), prepaid`);
    plan.benefits.forEach(b => doc.text(`•  ${b}`));
    doc.moveDown(1.2);

    doc.fontSize(9).fillColor('#888').text(
      'This document is generated by FetchTalos as a prototype and has not been reviewed by legal counsel. ' +
      'It is provided to communicate proposed terms and does not itself constitute a binding legal contract ' +
      'until countersigned through the acceptance link provided by email.',
      { width: 480 }
    );

    doc.end();
  });
}

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
 * EMAIL — sends real emails via Resend (resend.com). If RESEND_API_KEY
 * isn't set, this gracefully degrades to logging the email content to the
 * console instead of failing — so the hiring flow still WORKS end to end
 * for testing, you just won't get a real inbox notification until you add
 * a key.
 *
 * Set RESEND_API_KEY and RESEND_FROM_EMAIL (e.g. "FetchTalos <hire@yourdomain.com>").
 * NOTE: Resend's sandbox mode (no verified domain yet) only delivers to the
 * email address YOU signed up with — so early testing, a talent's "email"
 * needs to be your own address to actually receive anything. Use
 * PATCH /admin/talents/:id to change a seed talent's email for testing.
 * ---------------------------------------------------------------------- */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'FetchTalos <onboarding@resend.dev>';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://fetchtalos.onrender.com';

async function sendEmail({ to, subject, html, attachments }) {
  if (!RESEND_API_KEY) {
    console.log(`[email] RESEND_API_KEY not set — would have sent to ${to}:\nSubject: ${subject}\n${html}\n${attachments ? `[${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}]` : ''}`);
    return { sent: false, reason: 'no_api_key' };
  }
  try {
    const body = { from: RESEND_FROM, to, subject, html };
    if (attachments?.length) body.attachments = attachments; // [{ filename, content: base64string }]
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text();
      console.warn(`[email] Resend rejected the send (${res.status}):`, detail);
      return { sent: false, reason: `resend_error_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.warn('[email] send failed, continuing anyway:', err.message);
    return { sent: false, reason: err.message };
  }
}

/* ---------------------------------------------------------------------- *
 * MYCOVER.AI — real health coverage, not a label. Two modes, matching
 * Chris's own integration doc exactly:
 *
 * - "direct"  — calls MyCover.ai directly with your own MyCover keys.
 *   Good for dev/sandbox. Set MYCOVER_SECRET_KEY.
 * - "proxy"   — calls Felicity, which forwards to MyCover using Felicity's
 *   live keys, so policies/commissions/refunds live under Felicity's one
 *   KYC + ledger. Set FELICITY_PARTNER_KEY instead.
 *
 * Set MYCOVER_MODE=direct|proxy (defaults to direct). Both paths are
 * OPTIONAL — with neither key configured, coverage purchase gracefully
 * no-ops and coverage_status stays honestly labeled instead of faking
 * success.
 * ---------------------------------------------------------------------- */
const MYCOVER_MODE = process.env.MYCOVER_MODE === 'proxy' ? 'proxy' : 'direct';
const MYCOVER_SECRET_KEY = process.env.MYCOVER_SECRET_KEY;
const FELICITY_PARTNER_KEY = process.env.FELICITY_PARTNER_KEY;
const MYCOVER_CONFIGURED = MYCOVER_MODE === 'direct' ? Boolean(MYCOVER_SECRET_KEY) : Boolean(FELICITY_PARTNER_KEY);

const MYCOVER_BASE = MYCOVER_MODE === 'direct'
  ? 'https://v2.api.mycover.ai/v2'
  : 'https://jtotljjdyhxjbbsnpuml.supabase.co/functions/v1';
const MYCOVER_TOKEN = MYCOVER_MODE === 'direct' ? MYCOVER_SECRET_KEY : FELICITY_PARTNER_KEY;

// Path map so calling code doesn't care which mode it's in — same shape as Chris's reference client.
const MYCOVER_PATHS = MYCOVER_MODE === 'direct'
  ? {
      products: () => `/products`,
      product: (id) => `/products/${encodeURIComponent(id)}`,
      quote: () => `/products/quote`,
      buy: () => `/products/buy`,
      policy: (id) => `/policies/${encodeURIComponent(id)}`,
      cancel: (id) => `/policies/${encodeURIComponent(id)}/cancel`,
    }
  : {
      products: () => `/mycover-proxy-products`,
      product: (id) => `/mycover-proxy-product?id=${encodeURIComponent(id)}`,
      quote: () => `/mycover-proxy-quote`,
      buy: () => `/mycover-proxy-buy`,
      policy: (id) => `/mycover-proxy-policy?id=${encodeURIComponent(id)}`,
      cancel: (id) => `/mycover-proxy-cancel?id=${encodeURIComponent(id)}`,
    };

async function mycoverCall(path, init = {}) {
  const res = await fetch(`${MYCOVER_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${MYCOVER_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) { const err = new Error(`mycover_${res.status}: ${text}`); err.status = res.status; throw err; }
  return json;
}

const mycover = {
  listProducts: () => mycoverCall(MYCOVER_PATHS.products()),
  getProduct: (id) => mycoverCall(MYCOVER_PATHS.product(id)),
  quote: (body) => mycoverCall(MYCOVER_PATHS.quote(), { method: 'POST', body: JSON.stringify(body) }),
  buy: (body) => mycoverCall(MYCOVER_PATHS.buy(), { method: 'POST', body: JSON.stringify(body) }),
  getPolicy: (id) => mycoverCall(MYCOVER_PATHS.policy(id)),
  cancel: (id, body = {}) => mycoverCall(MYCOVER_PATHS.cancel(id), { method: 'POST', body: JSON.stringify(body) }),
};

// Coverage plan -> real MyCover product_id. These are YOUR live product IDs
// once you've looked them up — use GET /admin/mycover/products to find them,
// then set these three env vars. Until set, purchase is skipped gracefully.
const COVERAGE_PRODUCT_IDS = {
  remote_contractor_basic: process.env.MYCOVER_PRODUCT_ID_BASIC || null,
  remote_contractor_plus: process.env.MYCOVER_PRODUCT_ID_PLUS || null,
  remote_contractor_family: process.env.MYCOVER_PRODUCT_ID_FAMILY || null,
};

// MyCover doesn't always return a clean `status` field — this mirrors the
// exact "treat as active" logic from the integration doc.
function isPolicyActive(policyData) {
  if (!policyData) return false;
  if (policyData.is_active === true) return true;
  if (typeof policyData.status === 'string' && /active|issued|sold|success|completed/i.test(policyData.status)) return true;
  if (policyData.activation_date || policyData.start_date) {
    const expired = policyData.expiration_date && new Date(policyData.expiration_date) < new Date();
    return !expired;
  }
  return false;
}

/**
 * Actually purchase real health coverage for a talent on contract
 * acceptance. Gracefully no-ops (returns a clear status, never throws) if
 * MyCover isn't configured or the product_id for this plan isn't set —
 * the caller should never have a request fail because of this.
 */
// Maps a MyCover/Felicity `required_fields` name to how we'd source it from
// a talent record. Add to this as new products declare fields we haven't
// seen yet — don't assume every product wants the same shape.
function resolveRequiredField(fieldName, talent) {
  const map = {
    customer_name: talent.name,
    customer_first_name: talent.name?.split(' ')[0],
    customer_last_name: talent.name?.split(' ').slice(1).join(' ') || talent.name?.split(' ')[0],
    customer_email: talent.email,
    customer_phone: talent.phone,
    date_of_birth: talent.dob,
    customer_dob: talent.dob,
    customer_nin: talent.nin,
    image_url: talent.image_url,
  };
  return map[fieldName];
}

// Reverse of the above — which talent record property does a given
// required_field name actually write to? Only fields a talent can
// meaningfully self-submit are listed (name/email already exist by the
// time a contract exists, so they're deliberately not editable here).
const REQUIRED_FIELD_TO_TALENT_PROP = {
  customer_phone: 'phone',
  phone: 'phone',
  date_of_birth: 'dob',
  customer_dob: 'dob',
  customer_nin: 'nin',
  nin: 'nin',
  image_url: 'image_url',
  bvn: 'bvn',
  rubies_account_number: 'rubies_account_number',
  rubies_account_name: 'rubies_account_name',
  rubies_bank_code: 'rubies_bank_code',
};

const FIELD_LABELS = {
  customer_phone: 'Phone number',
  phone: 'Phone number',
  date_of_birth: 'Date of birth',
  customer_dob: 'Date of birth',
  customer_nin: 'NIN (National Identification Number) — 11 digits',
  nin: 'NIN (National Identification Number) — 11 digits',
  image_url: 'Selfie photo URL',
  bvn: 'BVN (Bank Verification Number)',
  rubies_account_number: 'Your Nigerian bank account number (for salary payout)',
  rubies_account_name: 'Your full name, exactly as it appears on your bank account (NOT your bank\'s name)',
  rubies_bank_code: 'Your bank\'s CBN code — e.g. GTBank = 058, Rubies MFB = 090175 (ask your bank if unsure)',
};

/**
 * What does THIS contract's plan actually require from the talent, and
 * which of those fields are still missing? Returns [] if MyCover isn't
 * configured or no product is mapped — no point asking for KYC data that
 * won't be used yet.
 */
async function getMissingCoverageFields(talent, contract) {
  if (!MYCOVER_CONFIGURED) return [];
  const product_id = COVERAGE_PRODUCT_IDS[contract.coverage_plan];
  if (!product_id) return [];

  let requiredFields;
  try {
    const productDetail = await mycover.getProduct(product_id);
    const product = productDetail?.data || productDetail;
    requiredFields = Array.isArray(product?.required_fields) && product.required_fields.length
      ? product.required_fields
      : ['customer_phone', 'date_of_birth'];
  } catch {
    requiredFields = ['customer_phone', 'date_of_birth']; // can't reach MyCover right now — ask for the common baseline rather than block entirely
  }

  return requiredFields
    .filter(f => REQUIRED_FIELD_TO_TALENT_PROP[f]) // only fields we can actually collect via a form (skip name/email — already set)
    .filter(f => !resolveRequiredField(f, talent));
}

async function purchaseCoverage({ talent, contract }) {
  if (!MYCOVER_CONFIGURED) {
    return { coverage_status: 'gap_not_wired', coverage_note: `MyCover not configured (MYCOVER_MODE=${MYCOVER_MODE}, no key set)` };
  }
  const product_id = COVERAGE_PRODUCT_IDS[contract.coverage_plan];
  if (!product_id) {
    return { coverage_status: 'gap_not_wired', coverage_note: `No product_id mapped for plan "${contract.coverage_plan}" — set MYCOVER_PRODUCT_ID_* env vars` };
  }

  const months = Number(contract.coverage_months) || 1;

  try {
    // Read the REAL product definition — don't assume field names or valid
    // durations match some other product we looked at earlier. Different
    // products (and different environments — sandbox vs. real catalog —
    // as we learned the hard way) can have different shapes entirely.
    const productDetail = await mycover.getProduct(product_id);
    const product = productDetail?.data || productDetail;
    if (!product) throw new Error(`Could not fetch product ${product_id}`);

    const basePremium = Number(product.base_premium ?? product.base_price);
    if (!basePremium) throw new Error(`Could not read a premium/price field for product ${product_id}`);

    // Validate the requested duration against what this SPECIFIC product
    // actually allows — e.g. this sandbox's family plan doesn't offer a
    // 1-month option even though the basic plan does.
    if (Array.isArray(product.duration_options) && product.duration_options.length && !product.duration_options.includes(months)) {
      return {
        coverage_status: 'invalid_duration',
        coverage_note: `${months} month(s) isn't valid for "${product.product_name || product.name}" — valid options: ${product.duration_options.join(', ')}`
      };
    }

    // Build the buy payload from the product's OWN declared required_fields
    // rather than a fixed guess. Fall back to a reasonable default set if
    // the product doesn't declare any (e.g. direct-mode products, which
    // don't expose this field the way this proxy sandbox does).
    const requiredFields = Array.isArray(product.required_fields) && product.required_fields.length
      ? product.required_fields
      : ['customer_email', 'customer_phone', 'customer_first_name', 'customer_last_name', 'customer_dob', 'customer_nin'];

    const missing = [];
    const body = { product_id, payment_plan: months, amount: Math.round(basePremium * months), bought_for_self: true };
    for (const field of requiredFields) {
      const value = resolveRequiredField(field, talent);
      if (value === undefined || value === null || value === '') missing.push(field);
      else body[field] = value;
    }
    if (missing.length) {
      return { coverage_status: 'gap_missing_kyc', coverage_note: `Talent missing required field(s) for this product: ${missing.join(', ')}. Use PATCH /admin/talents/:id to add them.` };
    }

    const result = await mycover.buy(body);

    const policyData = result?.data || result;
    const active = isPolicyActive(policyData);
    return {
      coverage_status: active ? 'active' : 'pending_activation',
      coverage_policy_id: policyData?.essential?.policy_id || policyData?.policy_id || policyData?.id || null,
      coverage_reference: result?.felicity_reference || null, // proxy mode only
      coverage_product_id: product_id,
      coverage_months: months,
      coverage_amount_paid: body.amount,
      coverage_note: null,
    };
  } catch (err) {
    console.warn('[mycover] purchase failed:', err.message);
    return { coverage_status: 'purchase_failed', coverage_note: err.message };
  }
}

/* ---------------------------------------------------------------------- *
 * FELICITY FINCRA PROXY — issues each talent a real USD virtual account.
 * The enterprise wires salary there in USD; Felicity auto-converts to NGN
 * and pays out to the talent's Rubies NUBAN — automatically, no code of
 * ours pushes that transfer.
 *
 * Critically, the `split` block on VA issuance is what makes this able to
 * cover MORE than just salary from one inflow: it can also skim a platform
 * fee leg and an insurance-premium reimbursement leg (paying back what
 * Felicity fronted via the MyCover proxy) before the remainder reaches the
 * talent. Without this, a single enterprise wire could only ever pay the
 * talent — nothing else. This is why insurance and salary can now settle
 * from ONE transaction instead of needing two separate payment rails.
 *
 * Mode is derived from the key's own prefix (test_ / live_), matching the
 * doc's own recommended pattern — no separate mode env var needed.
 * ---------------------------------------------------------------------- */
const FINCRA_BASE = 'https://jtotljjdyhxjbbsnpuml.supabase.co/functions/v1';
const FELICITY_FINCRA_KEY = process.env.FELICITY_FINCRA_KEY;
const FINCRA_CONFIGURED = Boolean(FELICITY_FINCRA_KEY);
const FINCRA_MODE = FELICITY_FINCRA_KEY?.startsWith('live_') ? 'live' : 'test';

async function fincraCall(path, init = {}) {
  const res = await fetch(`${FINCRA_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${FELICITY_FINCRA_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Felicity's error responses include a `detail` field with the REAL
    // rejection reason (e.g. invalid bank code, name mismatch) — this was
    // previously being discarded, leaving only the generic error code
    // behind and making failures impossible to diagnose without guessing.
    const reason = json?.detail ? `${json.error}: ${JSON.stringify(json.detail)}` : (json?.error || `fincra_${res.status}: ${text}`);
    const err = new Error(reason);
    err.status = res.status;
    throw err;
  }
  return json;
}

const fincra = {
  issueUsdVa: (payload) => fincraCall('/fincra-proxy-usd-va', { method: 'POST', body: JSON.stringify(payload) }),
  setPayoutPlan: (payload) => fincraCall('/fincra-proxy-payout-plan', { method: 'POST', body: JSON.stringify(payload) }),
  getVa: (talentRef) => fincraCall(`/fincra-proxy-va-get?talent_ref=${encodeURIComponent(talentRef)}`),
  payoutStatus: (talentRef, limit = 20) => fincraCall(`/fincra-proxy-payout-status?talent_ref=${encodeURIComponent(talentRef)}&limit=${limit}`),
  simulate: (talentRef, amount) => fincraCall('/fincra-proxy-simulate', { method: 'POST', body: JSON.stringify({ talent_ref: talentRef, amount }) }),
};

// Platform's own settlement accounts — where the fee and insurance-
// reimbursement legs actually land. Both optional; a leg is simply omitted
// from the split if its account isn't configured, rather than failing.
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS) || 500; // 500 bps = 5%, matches the existing platform fee elsewhere
const PLATFORM_ACCOUNT = process.env.FETCHTALOS_PLATFORM_ACCOUNT_NUMBER ? {
  account_number: process.env.FETCHTALOS_PLATFORM_ACCOUNT_NUMBER,
  account_name: process.env.FETCHTALOS_PLATFORM_ACCOUNT_NAME || 'FetchTalos Ltd',
  bank_code: process.env.FETCHTALOS_PLATFORM_BANK_CODE,
} : null;
const INSURANCE_POOL_ACCOUNT = process.env.FETCHTALOS_INSURANCE_POOL_ACCOUNT_NUMBER ? {
  account_number: process.env.FETCHTALOS_INSURANCE_POOL_ACCOUNT_NUMBER,
  account_name: process.env.FETCHTALOS_INSURANCE_POOL_ACCOUNT_NAME || 'FetchTalos Insurance Pool',
  bank_code: process.env.FETCHTALOS_INSURANCE_POOL_BANK_CODE,
} : null;

// Same fixed set every time — this endpoint (unlike MyCover's products)
// doesn't self-describe its required fields, so this list is hardcoded
// from the doc rather than discovered dynamically.
const FINCRA_REQUIRED_TALENT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'bvn', 'rubies_account_number', 'rubies_account_name', 'rubies_bank_code'];

function fincraMissingFields(talent) {
  const [firstName, ...rest] = (talent.name || '').split(' ');
  const values = {
    first_name: firstName,
    last_name: rest.join(' ') || firstName,
    email: talent.email,
    phone: talent.phone,
    bvn: talent.bvn,
    rubies_account_number: talent.rubies_account_number,
    rubies_account_name: talent.rubies_account_name,
    rubies_bank_code: talent.rubies_bank_code,
  };
  return FINCRA_REQUIRED_TALENT_FIELDS.filter(f => !values[f]);
}

// Form-worthy subset — excludes first_name/last_name/email, which come
// from the talent record itself and were never meant to be independently
// asked for on this form. Returns [] outright if Fincra isn't configured —
// no point asking for salary-account KYC that won't be used yet.
function fincraMissingFormFields(talent) {
  if (!FINCRA_CONFIGURED) return [];
  return fincraMissingFields(talent).filter(f => REQUIRED_FIELD_TO_TALENT_PROP[f]);
}

/**
 * Issues (or reuses — idempotent per talent_ref) a real USD virtual account
 * for this talent, with a split that reimburses the insurance premium
 * Felicity already fronted (if coverage was purchased) and skims the
 * platform fee, before the remainder is set up to reach the talent.
 * Gracefully no-ops if Fincra isn't configured or KYC is incomplete —
 * never throws back to the caller.
 */
async function issueSalaryAccount({ talent, contract }) {
  if (!FINCRA_CONFIGURED) {
    return { salary_status: 'gap_not_wired', salary_note: 'FELICITY_FINCRA_KEY not set' };
  }
  const missing = fincraMissingFields(talent);
  if (missing.length) {
    return { salary_status: 'gap_missing_kyc', salary_note: `Talent missing field(s) for salary account: ${missing.join(', ')}. Use PATCH /admin/talents/:id to add them.` };
  }

  const [firstName, ...rest] = talent.name.split(' ');
  const lastName = rest.join(' ') || firstName;

  const split = { extra_legs: [] };
  if (contract.coverage_status === 'active' && contract.coverage_amount_paid && INSURANCE_POOL_ACCOUNT) {
    split.extra_legs.push({
      label: 'insurance_premium',
      amount_ngn: contract.coverage_amount_paid, // MyCover/Bastion products are NGN-denominated already — no conversion needed here
      beneficiary: INSURANCE_POOL_ACCOUNT,
    });
  }
  if (PLATFORM_ACCOUNT) {
    split.platform_fee_bps = PLATFORM_FEE_BPS;
    split.platform_beneficiary = PLATFORM_ACCOUNT;
  }
  const hasSplit = split.extra_legs.length > 0 || split.platform_fee_bps;

  try {
    const result = await fincra.issueUsdVa({
      talent_ref: contract.contract_id,
      beneficiary: { first_name: firstName, last_name: lastName, email: talent.email, phone: talent.phone, bvn: talent.bvn },
      rubies_credit: { account_number: talent.rubies_account_number, account_name: talent.rubies_account_name, bank_code: talent.rubies_bank_code },
      ...(hasSplit ? { split } : {}),
    });

    return {
      salary_status: 'va_issued',
      salary_va_account_number: result?.account?.account_number || null,
      salary_va_routing_number: result?.account?.routing_number || null,
      salary_va_bank_name: result?.account?.bank_name || null,
      salary_talent_ref: contract.contract_id,
      salary_split_applied: hasSplit,
      salary_note: null,
    };
  } catch (err) {
    console.warn('[fincra] VA issuance failed:', err.message);
    return { salary_status: 'issuance_failed', salary_note: err.message };
  }
}

/* ---------------------------------------------------------------------- *
 * PAY PERIODS — the missing piece that made payment feel like a one-time
 * setup instead of real recurring payroll. A VA gets issued ONCE at
 * contract acceptance, but salary is owed every month — nothing before
 * this tracked "has this month actually been paid," so the enterprise had
 * no reminder and there was no history broken out by period.
 *
 * Status is computed LIVE at read time (paid_at set → paid; due_date
 * passed → overdue; else → due), not stored — no cron/scheduler needed to
 * keep it accurate, matching the graceful-degradation style used
 * everywhere else in this file.
 * ---------------------------------------------------------------------- */
const PAY_PERIOD_DAYS = Number(process.env.PAY_PERIOD_DAYS) || 30; // how often salary is owed

function payPeriodStatus(period) {
  if (period.paid_at) return 'paid';
  return new Date(period.due_date) < new Date() ? 'overdue' : 'due';
}

/**
 * Creates the NEXT unpaid pay period for a contract — called once when a
 * contract first goes active, and again every time a period is marked paid
 * (so there's always exactly one open period per contract, never zero and
 * never a backlog of duplicates).
 */
function createNextPayPeriod(contract, afterDate) {
  const periodNumber = [...db.payPeriods.values()].filter(p => p.contract_id === contract.contract_id).length + 1;
  const dueDate = new Date(afterDate || Date.now());
  dueDate.setDate(dueDate.getDate() + PAY_PERIOD_DAYS);

  const period = {
    period_id: id('pp'),
    contract_id: contract.contract_id,
    client_id: contract.client_id,
    period_number: periodNumber,
    amount_due: contract.proposed_amount || null,
    employer_currency: contract.employer_currency,
    due_date: dueDate.toISOString(),
    paid_at: null,
    matched_payout_id: null,
    created_at: new Date().toISOString(),
  };
  db.payPeriods.set(period.period_id, period);
  return period;
}

/**
 * Marks the OLDEST unpaid period for a contract as paid — called when
 * Felicity confirms a real NGN payout settled. FIFO matching: real salary
 * wires are expected to land roughly in order, one per period, so the
 * oldest still-open period is the correct one to close. Then opens the
 * next period so there's always exactly one active going forward.
 */
function settleOldestUnpaidPeriod(contractId) {
  const open = [...db.payPeriods.values()]
    .filter(p => p.contract_id === contractId && !p.paid_at)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const period = open[0];
  if (!period) return null;

  period.paid_at = new Date().toISOString();
  const contract = db.contracts.get(contractId);
  if (contract) createNextPayPeriod(contract, period.paid_at);
  return period;
}

/* ---------------------------------------------------------------------- *
 * FELICITY NGN RAIL — the domestic (NG enterprise -> NG talent) path.
 * Structurally different from the Fincra/USD flow, not a copy of it: each
 * talent gets their OWN real Rubies NUBAN with a real NGN balance
 * (`onboard_talent`), insurance is bought DIRECTLY against that balance
 * (`buy_insurance` — no separate reimbursement leg needed, since premium
 * and balance are already the same currency), and there is NO automatic
 * split — WE explicitly `send` out the platform fee, any hub markup, and
 * the talent's own salary, in that order, every time a payment lands.
 * Used when a contract's employer_currency is NGN; the existing Fincra/
 * W-8BEN paths are untouched and still handle everything else.
 * ---------------------------------------------------------------------- */
const FELICITY_NGN_API_KEY = process.env.FELICITY_NGN_PARTNER_KEY;
const FELICITY_NGN_CONFIGURED = Boolean(FELICITY_NGN_API_KEY);
const FELICITY_NGN_BASE = 'https://jtotljjdyhxjbbsnpuml.supabase.co/functions/v1/partner-api';

async function felicityNgn(action, payload = {}) {
  const res = await fetch(FELICITY_NGN_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FELICITY_NGN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(json?.error || json?.message || `felicity_ngn_${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// International format required — "2348012345678", not "08012345678".
// Confirmed explicitly in the integration brief as a real gotcha.
function toInternationalPhone(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return '234' + digits.slice(1);
  return '234' + digits;
}

// Same fields the Fincra KYC form already asks for, PLUS nin — the one
// genuinely new field this rail needs that nothing else in the system
// collects. name/email are assumed present by the time a contract exists.
function ngnMissingFormFields(talent) {
  if (!FELICITY_NGN_CONFIGURED) return [];
  // phone/dob/bvn/nin -> needed for onboard_talent. rubies_account_* ->
  // needed later, for THIS flow's own send-to-talent step in
  // settleNgnPayment — deliberately checked here directly rather than via
  // fincraMissingFormFields, since that helper is gated behind
  // FINCRA_CONFIGURED, which has nothing to do with whether the NGN rail
  // is configured. The NGN flow needs these fields on its own terms.
  const required = ['phone', 'dob', 'bvn', 'nin', 'rubies_account_number', 'rubies_account_name', 'rubies_bank_code'];
  return required.filter(prop => !talent[prop]).map(prop =>
    Object.entries(REQUIRED_FIELD_TO_TALENT_PROP).find(([, v]) => v === prop)?.[0] || prop
  );
}

/**
 * Issues the intermediate Rubies NUBAN a talent's salary actually lands on.
 * This is NOT the talent's own bank account — it's a pass-through balance;
 * the talent's real destination is their existing rubies_account_number
 * (already collected for the Fincra flow) and money only reaches them via
 * an explicit `send` call, made later when a payment settles.
 */
async function onboardTalentNgn({ talent, contract }) {
  if (!FELICITY_NGN_CONFIGURED) {
    return { ngn_status: 'gap_not_wired', ngn_note: 'FELICITY_NGN_PARTNER_KEY not set' };
  }
  const missing = ngnMissingFormFields(talent);
  if (missing.length) {
    return { ngn_status: 'gap_missing_kyc', ngn_note: `Talent missing field(s) for NGN onboarding: ${missing.join(', ')}` };
  }

  try {
    const [firstName, ...rest] = talent.name.split(' ');
    const result = await felicityNgn('onboard_talent', {
      talent_ref: contract.contract_id,
      first_name: firstName,
      last_name: rest.join(' ') || firstName,
      phone: toInternationalPhone(talent.phone),
      email: talent.email,
      date_of_birth: talent.dob,
      bvn: talent.bvn,
      nin: talent.nin,
    });
    const t = result.talent;
    return {
      ngn_status: 'onboarded',
      ngn_talent_ref: contract.contract_id,
      ngn_account_number: t.account_number,
      ngn_account_name: t.account_name,
      ngn_bank_name: t.bank_name,
      ngn_note: null,
    };
  } catch (err) {
    console.warn('[felicity-ngn] onboard_talent failed:', err.message);
    return { ngn_status: err.status === 409 ? 'already_onboarded' : 'onboard_failed', ngn_note: err.message };
  }
}

/**
 * Buys insurance DIRECTLY against the talent's NGN balance — no fronting,
 * no reimbursement leg, refunds are automatic on failure (per Felicity's
 * own doc). Reuses the SAME coverage_plan -> product_id mapping and the
 * SAME dynamic required-field resolution already built for the older
 * MyCover proxy, since this confirmed uses the identical product catalog
 * and required_fields shape — genuinely the same discovery-by-real-error
 * pattern applies here too (gender/address/benefits on some real products
 * aren't collected anywhere yet; a live purchase attempt will surface
 * exactly what's missing via Felicity's own real validation message,
 * passed through verbatim, same as the existing insurance flow).
 */
async function buyInsuranceNgn({ talent, contract }) {
  const product_id = COVERAGE_PRODUCT_IDS[contract.coverage_plan];
  if (!product_id) return { coverage_status: 'gap_not_configured', coverage_note: `No product_id mapped for plan "${contract.coverage_plan}"` };

  try {
    const [firstName, ...rest] = talent.name.split(' ');
    const payload = {
      action: 'buy_insurance',
      talent_ref: contract.contract_id,
      product_id,
      customer_first_name: firstName,
      customer_last_name: rest.join(' ') || firstName,
      customer_phone: talent.phone,
      date_of_birth: talent.dob,
      customer_nin: talent.nin,
    };
    const result = await felicityNgn('buy_insurance', payload);
    return {
      coverage_status: 'active',
      coverage_policy_id: result.policy.policy_number,
      coverage_reference: result.policy.policy_reference,
      coverage_product_id: product_id,
      coverage_amount_paid: result.policy.premium_naira,
      // ALWAYS null at this exact moment — the document doesn't exist yet
      // on ANY purchase, per the doc's explicit callout. It arrives later,
      // asynchronously, via a SECOND talent.policy_issued webhook (see
      // handleFelicityNgnWebhookEvent) — never poll for it synchronously.
      coverage_policy_document_url: result.policy.policy_document_url || null,
      coverage_start_date: result.policy.start_date || null,
      coverage_expiration_date: result.policy.expiration_date || null,
      coverage_note: null,
    };
  } catch (err) {
    console.warn('[felicity-ngn] buy_insurance failed:', err.message);
    return { coverage_status: 'purchase_failed', coverage_note: err.message };
  }
}

/** Thin wrapper around get_policy — same white-labeled shape as buy, used
 * to manually re-check whether the document has landed yet (useful for a
 * demo, or as a fallback if a webhook delivery was ever missed). */
async function getPolicyNgn(policy_reference) {
  return felicityNgn('get_policy', { policy_reference });
}

/**
 * Fired specifically when the policy DOCUMENT becomes available — not the
 * same moment as "insurance purchased." Per the doc, policy_document_url
 * is null on every purchase response, always, and only shows up later via
 * a SECOND talent.policy_issued webhook. This means the original "you've
 * been paid" email (sent right after purchase) can never include this
 * link — it genuinely doesn't exist yet at that point. This is the
 * separate notification that closes that gap once it's real.
 */
async function sendPolicyDocumentEmail(contract, talent) {
  if (!talent?.email) return { sent: false, reason: 'talent_missing_email' };
  return sendEmail({
    to: talent.email,
    subject: `Your health insurance policy document is ready`,
    html: `<p>Hi ${contract.talent_name},</p>
      <p>Your policy document for ${contract.employer_name}'s coverage is now available:</p>
      <ul>
        <li><b>Policy number:</b> ${contract.coverage_policy_id || ''}</li>
        ${contract.coverage_start_date ? `<li><b>Start date:</b> ${contract.coverage_start_date}</li>` : ''}
        ${contract.coverage_expiration_date ? `<li><b>Expires:</b> ${contract.coverage_expiration_date}</li>` : ''}
        <li><b>Document:</b> <a href="${contract.coverage_policy_document_url}">${contract.coverage_policy_document_url}</a></li>
      </ul>
      <p>Keep this email — it's your record.</p>
      <p>— FetchTalos</p>`
  });
}

/** Thin wrapper around the `send` action. */
async function sendNgn({ talent_ref, amount_naira, account_number, bank_code, account_name }) {
  return felicityNgn('send', { talent_ref, amount_naira, account_number, bank_code, account_name });
}

/**
 * The core automatic orchestration, fired every time a payment lands on a
 * talent's NGN balance (talent.va_credited webhook). In order:
 *   1. If this is the FIRST ever payment for this contract, buy insurance
 *      against the balance that just landed (debits the real premium).
 *   2. Re-check the ACTUAL current balance (never assume — the real
 *      premium can differ slightly from what was estimated when the
 *      enterprise was told what to wire).
 *   3. Send FetchTalos's platform fee to FetchTalos's own settlement account.
 *   4. Send the hub's markup (if this pipeline's hub key has one
 *      configured) to the HUB's own settlement account — the white-label
 *      revenue share.
 *   5. Send whatever's left to the talent's own real bank account.
 *   6. Settle the pay period, email the talent.
 * If the balance can't cover fee+markup after insurance, NOTHING is sent
 * and the contract is flagged clearly — never guess or send a partial,
 * wrong amount.
 */
async function settleNgnPayment(contract) {
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (!talent) return { ngn_settlement_note: 'talent_not_found' };

  const alreadyPaidCount = [...db.payPeriods.values()].filter(p => p.contract_id === contract.contract_id && p.paid_at).length;
  const isFirstPayment = alreadyPaidCount === 0;

  if (isFirstPayment) {
    const coverage = await buyInsuranceNgn({ talent, contract });
    Object.assign(contract, coverage);
  }

  let currentBalanceKobo;
  try {
    const t = await felicityNgn('get_talent', { talent_ref: contract.contract_id });
    currentBalanceKobo = t.talent.balance_kobo;
  } catch (err) {
    return { ngn_settlement_status: 'balance_check_failed', ngn_settlement_note: err.message };
  }

  const salaryNaira = Number(contract.proposed_amount) || 0;
  const platformFeeNaira = +(salaryNaira * PLATFORM_FEE_BPS / 10000).toFixed(2);

  const hubKeyRecord = Object.values(KEYS).find(k => k.type === 'hub' && k.hub_scope === talent.pipeline);
  const hubMarkupBps = hubKeyRecord?.hub_markup_bps || 0;
  const hubMarkupNaira = hubMarkupBps > 0 ? +(salaryNaira * hubMarkupBps / 10000).toFixed(2) : 0;
  const hubSettlement = hubKeyRecord?.hub_settlement_account || null;

  const currentBalanceNaira = currentBalanceKobo / 100;
  // The talent's salary is a FIXED, PROTECTED amount — never computed as
  // "whatever's left after fees." If the balance can't cover salary + fee
  // + markup IN FULL, nothing is sent to anyone rather than silently
  // shortchanging the talent to make the numbers fit. This was a real bug
  // caught in testing: an earlier version computed the talent's amount as
  // a leftover subtraction, which meant an enterprise underpayment reduced
  // what the TALENT received instead of being flagged as a shortfall —
  // directly contradicting the mark-up model's core guarantee that fees
  // are always additive, never deducted from the talent.
  const totalOwed = +(salaryNaira + platformFeeNaira + hubMarkupNaira).toFixed(2);
  const remainingForTalent = salaryNaira;

  if (currentBalanceNaira < totalOwed) {
    return {
      ngn_settlement_status: 'insufficient_balance',
      ngn_settlement_note: `Balance (₦${currentBalanceNaira}) is short of what's owed: ₦${salaryNaira} salary + ₦${platformFeeNaira} platform fee + ₦${hubMarkupNaira} hub markup = ₦${totalOwed}. Nothing was sent — the talent's salary is never reduced to cover a shortfall.`,
    };
  }
  if (hubMarkupNaira > 0 && !hubSettlement) {
    return {
      ngn_settlement_status: 'hub_settlement_account_missing',
      ngn_settlement_note: `This hub has a markup (${hubMarkupBps}bps) configured but no settlement account on file — set one via PATCH /admin/keys/:apiKey before payments can settle.`,
    };
  }

  try {
    if (platformFeeNaira > 0 && PLATFORM_ACCOUNT) {
      await sendNgn({ talent_ref: contract.contract_id, amount_naira: platformFeeNaira, account_number: PLATFORM_ACCOUNT.account_number, bank_code: PLATFORM_ACCOUNT.bank_code, account_name: PLATFORM_ACCOUNT.account_name });
    }
    if (hubMarkupNaira > 0 && hubSettlement) {
      await sendNgn({ talent_ref: contract.contract_id, amount_naira: hubMarkupNaira, account_number: hubSettlement.account_number, bank_code: hubSettlement.bank_code, account_name: hubSettlement.account_name });
    }
    if (remainingForTalent > 0) {
      await sendNgn({ talent_ref: contract.contract_id, amount_naira: remainingForTalent, account_number: talent.rubies_account_number, bank_code: talent.rubies_bank_code, account_name: talent.rubies_account_name });
    }
  } catch (err) {
    console.warn('[felicity-ngn] send failed mid-settlement:', err.message);
    return { ngn_settlement_status: 'send_failed', ngn_settlement_note: err.message };
  }

  const settledPeriod = settleOldestUnpaidPeriod(contract.contract_id);
  const nextPeriod = settledPeriod ? [...db.payPeriods.values()]
    .filter(p => p.contract_id === contract.contract_id && !p.paid_at)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0] : null;

  if (talent.email) {
    await sendEmail({
      to: talent.email,
      subject: `You've been paid — ₦${remainingForTalent.toLocaleString()} received`,
      html: `<p>Hi ${contract.talent_name},</p>
        <p>Your payment for this pay period has landed.</p>
        <ul>
          <li><b>Amount:</b> ₦${remainingForTalent.toLocaleString()}</li>
          ${isFirstPayment && contract.coverage_status === 'active' ? `<li><b>Health coverage:</b> Active — policy ${contract.coverage_policy_id} (your policy document follows in a separate email once it's ready)</li>` : ''}
          ${settledPeriod ? `<li><b>Pay period:</b> #${settledPeriod.period_number}</li>` : ''}
          ${nextPeriod ? `<li><b>Next payment due:</b> ${new Date(nextPeriod.due_date).toLocaleDateString()}</li>` : ''}
        </ul>
        <p>— FetchTalos</p>`
    });
  }

  return {
    ngn_settlement_status: 'settled',
    ngn_settlement_note: null,
    ngn_last_platform_fee: platformFeeNaira,
    ngn_last_hub_markup: hubMarkupNaira,
    ngn_last_talent_amount: remainingForTalent,
  };
}

/* ---------------------------------------------------------------------- *
 * DROPBOX SIGN — real IRS Form W-8BEN, real e-signature. Only applies to
 * US-employer contracts (that's the only country currently mapped to
 * W-8BEN in taxFormMap). The actual PDF sent for signature is the real
 * government file (assets/fw8ben.pdf) — an Adobe XFA form with an actual
 * cryptographic signature field, not something we recreated — Dropbox
 * Sign handles the parts of this that are genuinely hard to get right
 * ourselves: rendering, signature capture, audit trail, compliance.
 *
 * Auth: HTTP Basic, API key as username, blank password — confirmed
 * against Dropbox Sign's current docs, not assumed.
 * Webhooks: arrive as multipart/form-data with a field named "json" (NOT
 * a raw JSON body) — a real, easy-to-miss quirk of this specific API.
 * Verification: HMAC-SHA256 of (event_time + event_type), keyed by the
 * SAME API key used to authenticate requests — no separate webhook secret.
 * Response requirement: Dropbox Sign requires the literal response body
 * "Hello API Event Received" or it treats the callback as failed and
 * retries up to 6 times, then disables the URL after 10 failures.
 * ---------------------------------------------------------------------- */
const DROPBOX_SIGN_API_KEY = process.env.DROPBOX_SIGN_API_KEY;
const DROPBOX_SIGN_TEST_MODE = process.env.DROPBOX_SIGN_TEST_MODE !== 'false'; // defaults to TRUE — safe by default, must opt in to live
const DROPBOX_SIGN_CONFIGURED = Boolean(DROPBOX_SIGN_API_KEY);
const DROPBOX_SIGN_BASE = 'https://api.hellosign.com/v3';
const W8BEN_PDF_PATH = path.join(__dirname, 'assets', 'fw8ben.pdf');

function dropboxSignAuthHeader() {
  return 'Basic ' + Buffer.from(`${DROPBOX_SIGN_API_KEY}:`).toString('base64');
}

/**
 * Sends the REAL IRS W-8BEN PDF to the talent for signature via Dropbox
 * Sign. Gracefully no-ops (never throws) if not configured, if this
 * contract's employer isn't US-based (W-8BEN doesn't apply), or if the
 * talent has no email. Mirrors the exact structure of purchaseCoverage()
 * and issueSalaryAccount() — same graceful-degradation contract.
 */
/**
 * Explicit field placement for the real W-8BEN PDF. This exists because
 * Dropbox Sign's auto-detection does NOT understand this document's native
 * fields — it's an Adobe XFA form (confirmed via `pdfinfo`), and only the
 * one genuine PDF /Sig field got auto-recognized. Every coordinate below
 * was extracted directly from the real file with pdfplumber (exact point
 * positions, not eyeballed), so these line up with the actual printed
 * labels — Name (1), Country of citizenship (2), Permanent residence
 * address (3), Date of birth (8), then Part III's signature, date, and
 * printed name. Deliberately NOT included: mailing address (4), US TIN
 * (5), foreign tax ID (6a/6b), reference number (7), and all of Part II —
 * every one of those is genuinely optional per the form's own instructions
 * ("if required", "if different from above"), not skipped by oversight.
 */
function w8benFormFields(signerIndex) {
  const page = 1;
  return [
    { api_id: 'name', name: 'Name of beneficial owner', type: 'text', x: 40, y: 238, width: 335, height: 14, required: true, signer: signerIndex, page },
    { api_id: 'citizenship', name: 'Country of citizenship', type: 'text', x: 380, y: 238, width: 195, height: 14, required: true, signer: signerIndex, page },
    { api_id: 'address', name: 'Permanent residence address', type: 'text', x: 40, y: 262, width: 535, height: 36, required: true, signer: signerIndex, page },
    { api_id: 'dob', name: 'Date of birth (MM-DD-YYYY)', type: 'text', x: 298, y: 409, width: 270, height: 14, required: true, signer: signerIndex, page },
    { api_id: 'signature', name: 'Signature', type: 'signature', x: 36, y: 700, width: 420, height: 20, required: true, signer: signerIndex, page },
    { api_id: 'date_signed', name: 'Date signed', type: 'date_signed', x: 465, y: 700, width: 110, height: 20, required: true, signer: signerIndex, page },
    { api_id: 'print_name', name: 'Print name of signer', type: 'text', x: 36, y: 726, width: 535, height: 16, required: true, signer: signerIndex, page },
  ];
}

async function requestW8BenSignature({ contract, talent }) {
  if (contract.employer_country !== 'US') {
    return { w8ben_status: 'not_applicable', w8ben_note: `W-8BEN only applies to US-employer contracts (this one is ${contract.employer_country} — see taxFormMap for that jurisdiction's actual form)` };
  }
  if (!DROPBOX_SIGN_CONFIGURED) {
    return { w8ben_status: 'gap_not_wired', w8ben_note: 'DROPBOX_SIGN_API_KEY not set' };
  }
  if (!talent.email) {
    return { w8ben_status: 'gap_missing_kyc', w8ben_note: 'Talent has no email on file' };
  }

  try {
    const pdfBytes = fs.readFileSync(W8BEN_PDF_PATH);
    const form = new FormData();
    form.append('title', 'Form W-8BEN');
    form.append('subject', `W-8BEN for your contract with ${contract.employer_name}`);
    form.append('message', 'Please complete and sign your W-8BEN so this can be provided to your employer for their tax records. This does not get sent to the IRS.');
    form.append('signers[0][email_address]', talent.email);
    form.append('signers[0][name]', talent.name);
    form.append('metadata[contract_id]', contract.contract_id);
    form.append('test_mode', DROPBOX_SIGN_TEST_MODE ? '1' : '0');
    // Explicit placement, NOT auto-detection — see w8benFormFields() above for why.
    form.append('form_fields_per_document', JSON.stringify([w8benFormFields(0)]));
    form.append('files[]', new Blob([pdfBytes], { type: 'application/pdf' }), 'W-8BEN.pdf');

    const res = await fetch(`${DROPBOX_SIGN_BASE}/signature_request/send`, {
      method: 'POST',
      headers: { Authorization: dropboxSignAuthHeader() },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.error_msg || `dropbox_sign_${res.status}`);

    return {
      w8ben_status: 'sent',
      w8ben_signature_request_id: data.signature_request.signature_request_id,
      w8ben_test_mode: Boolean(data.signature_request.test_mode),
      w8ben_note: null,
    };
  } catch (err) {
    console.warn('[dropbox-sign] send failed:', err.message);
    return { w8ben_status: 'send_failed', w8ben_note: err.message };
  }
}

function verifyDropboxSignEventHash(eventTime, eventType, eventHash) {
  if (!DROPBOX_SIGN_API_KEY || !eventHash) return false;
  try {
    const expected = crypto.createHmac('sha256', DROPBOX_SIGN_API_KEY).update(String(eventTime) + eventType).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(eventHash));
  } catch {
    return false; // length mismatch etc.
  }
}

/**
 * Verifies a MyCover/Felicity webhook signature — exact logic from the
 * integration doc, both modes.
 */
function verifyMycoverWebhook(rawBody, headers, secret) {
  if (MYCOVER_MODE === 'direct') {
    const sig = headers['x-mycoverai-signature'] || headers['x-mycover-signature'] || headers['x-signature'] || headers['signature'];
    if (!sig) return false;
    const h = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    return sig === secret || sig.toLowerCase() === h;
  } else {
    const sig = headers['x-felicity-signature'];
    if (!sig) return false;
    const h = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return sig.toLowerCase() === h;
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
      engagements: [...db.engagements.entries()],
      contracts: [...db.contracts.entries()],
      payouts: [...db.payouts.entries()],
      payPeriods: [...db.payPeriods.entries()]
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
      if (snapshot.talents?.length) {
        // MIGRATION GUARD: a persisted snapshot saved before a field existed
        // (e.g. "email", added after persistence was already live) would
        // otherwise silently overwrite the current code's data and reintroduce
        // bugs that look fixed but aren't. Backfill any missing fields from
        // the seed data by talent_id before trusting the persisted version.
        let backfilled = 0;
        db.talents = snapshot.talents.map(t => {
          const seed = SEED_TALENTS.find(s => s.talent_id === t.talent_id);
          if (seed) {
            const missing = Object.keys(seed).filter(k => t[k] === undefined);
            if (missing.length) { backfilled++; return { ...seed, ...t }; } // seed fills gaps, persisted values win where both exist
          }
          return t;
        });
        if (backfilled) console.warn(`[persistence] backfilled missing fields on ${backfilled} talent(s) from seed data — persisted snapshot predated a schema change`);
      }
      if (snapshot.engagements) db.engagements = new Map(snapshot.engagements);
      if (snapshot.contracts) db.contracts = new Map(snapshot.contracts);
      if (snapshot.payouts) db.payouts = new Map(snapshot.payouts);
      if (snapshot.payPeriods) db.payPeriods = new Map(snapshot.payPeriods);
      console.log(`[persistence] restored ${db.talents.length} talents, ${db.contracts.size} contracts, ${db.payouts.size} payouts, ${db.payPeriods.size} pay periods, ${Object.keys(KEYS).length} keys`);
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
// Body: { client_id, type: "enterprise" | "hub", hub_scope: "ALX Africa",
//          hub_markup_bps, hub_settlement_account: {account_number, account_name, bank_code} }
// hub_scope is REQUIRED when type is "hub" — it's what locks that key's
// talent discovery down to one pipeline. Omit type to default to "enterprise".
// hub_markup_bps/hub_settlement_account are OPTIONAL and hub-only — this is
// the white-label revenue share: a hub can charge their own markup on top
// of FetchTalos's platform fee, paid to their OWN account, every time a
// talent under their pipeline gets paid. Deliberately admin-set, not
// hub-self-service — same trust boundary as hub_scope itself.
// Persisted immediately if UPSTASH_REDIS_REST_URL/TOKEN are set — otherwise
// this key dies the moment the server restarts (see PERSISTENCE section above).
app.post('/admin/keys', requireAdminKey, async (req, res) => {
  const { client_id, type = 'enterprise', hub_scope = null, hub_markup_bps = 0, hub_settlement_account = null } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  if (!['enterprise', 'hub'].includes(type)) return res.status(400).json({ error: 'type must be "enterprise" or "hub"' });
  if (type === 'hub' && !hub_scope) return res.status(400).json({ error: 'hub_scope is required when type is "hub"' });

  const newKey = `ft_live_${crypto.randomBytes(9).toString('hex')}`;
  KEYS[newKey] = {
    client_id, type, hub_scope: type === 'hub' ? hub_scope : null,
    hub_markup_bps: type === 'hub' ? Number(hub_markup_bps) || 0 : 0,
    hub_settlement_account: type === 'hub' ? (hub_settlement_account || null) : null,
  };
  await saveState();
  res.status(201).json({ api_key: newKey, client_id, type, hub_scope: KEYS[newKey].hub_scope, hub_markup_bps: KEYS[newKey].hub_markup_bps, hub_settlement_account: KEYS[newKey].hub_settlement_account, persisted: PERSISTENCE_ENABLED });
});

// PATCH /admin/keys/:apiKey — set/update a hub's markup rate and settlement
// account on a key that already exists. This is the endpoint you'd actually
// use day to day, since hub keys are usually created once and their
// commercial terms (markup %) negotiated/changed afterward.
app.patch('/admin/keys/:apiKey', requireAdminKey, async (req, res) => {
  const record = KEYS[req.params.apiKey];
  if (!record) return res.status(404).json({ error: 'key_not_found' });
  if (record.type !== 'hub') return res.status(400).json({ error: 'not_a_hub_key', message: 'Markup and settlement accounts only apply to hub-type keys.' });

  const { hub_markup_bps, hub_settlement_account } = req.body || {};
  if (hub_markup_bps !== undefined) record.hub_markup_bps = Number(hub_markup_bps) || 0;
  if (hub_settlement_account !== undefined) record.hub_settlement_account = hub_settlement_account;

  await saveState();
  res.json({ client_id: record.client_id, hub_scope: record.hub_scope, hub_markup_bps: record.hub_markup_bps, hub_settlement_account: record.hub_settlement_account });
});

// GET /admin/keys — list every client, their type/scope, and their key (masked).
app.get('/admin/keys', requireAdminKey, (req, res) => {
  const list = Object.entries(KEYS).map(([key, r]) => ({
    client_id: r.client_id,
    type: r.type,
    hub_scope: r.hub_scope,
    hub_markup_bps: r.hub_markup_bps || 0,
    hub_settlement_account: r.hub_settlement_account || null,
    key_preview: key.slice(0, 12) + '…' + key.slice(-4)
  }));
  res.json({ count: list.length, results: list });
});

// POST /admin/talents — add a new talent to the pool. This is how new
// pipeline graduates actually get into FetchTalos — right now it's you
// calling this by hand; a hub's own onboarding flow would call it too,
// eventually.
app.post('/admin/talents', requireAdminKey, async (req, res) => {
  const { name, email, stack, pipeline, country, vetted_score } = req.body || {};
  if (!name || !email || !pipeline || !country) {
    return res.status(400).json({ error: 'name, email, pipeline, and country are required' });
  }
  const talent = {
    talent_id: id('tal'),
    name,
    email,
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

// PATCH /admin/talents/:id — update any field, most commonly used to set a
// REAL email on a seed/demo talent so the interview/contract email flow
// below has somewhere to actually deliver to during testing.
app.patch('/admin/talents/:id', requireAdminKey, async (req, res) => {
  const talent = db.talents.find(t => t.talent_id === req.params.id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  Object.assign(talent, req.body || {});
  await saveState();
  res.json(talent);
});

// GET /admin/mycover/status — is coverage configured at all, and how
app.get('/admin/mycover/status', requireAdminKey, (req, res) => {
  res.json({
    mode: MYCOVER_MODE,
    configured: MYCOVER_CONFIGURED,
    product_ids: COVERAGE_PRODUCT_IDS,
    note: MYCOVER_CONFIGURED
      ? (Object.values(COVERAGE_PRODUCT_IDS).every(v => !v) ? 'Key is set but no product_id mapped yet — call GET /admin/mycover/products to find real ones, then set MYCOVER_PRODUCT_ID_* env vars.' : 'Ready.')
      : `Not configured — set ${MYCOVER_MODE === 'direct' ? 'MYCOVER_SECRET_KEY' : 'FELICITY_PARTNER_KEY'} (and MYCOVER_MODE if you want the other mode).`
  });
});

// GET /admin/fincra/status — is the salary-payment rail configured
app.get('/admin/fincra/status', requireAdminKey, (req, res) => {
  res.json({
    mode: FINCRA_MODE,
    configured: FINCRA_CONFIGURED,
    platform_fee_bps: PLATFORM_FEE_BPS,
    platform_account_configured: Boolean(PLATFORM_ACCOUNT),
    insurance_pool_account_configured: Boolean(INSURANCE_POOL_ACCOUNT),
    note: !FINCRA_CONFIGURED
      ? 'Not configured — set FELICITY_FINCRA_KEY (test_... or live_...).'
      : !PLATFORM_ACCOUNT && !INSURANCE_POOL_ACCOUNT
        ? 'VA issuance will work, but with no split — the full amount goes to the talent. Set FETCHTALOS_PLATFORM_ACCOUNT_* and FETCHTALOS_INSURANCE_POOL_ACCOUNT_* to enable fee/insurance skimming.'
        : 'Ready.'
  });
});

// GET /admin/felicity-ngn/status — is the NGN rail configured
app.get('/admin/felicity-ngn/status', requireAdminKey, (req, res) => {
  res.json({
    configured: FELICITY_NGN_CONFIGURED,
    platform_fee_bps: PLATFORM_FEE_BPS,
    platform_account_configured: Boolean(PLATFORM_ACCOUNT),
    hubs_with_markup: Object.values(KEYS).filter(k => k.type === 'hub' && (k.hub_markup_bps || 0) > 0).length,
    note: !FELICITY_NGN_CONFIGURED
      ? 'Not configured — set FELICITY_NGN_PARTNER_KEY, and ask Felicity to enable the "payments" and "insurance" capabilities on it (off by default, even for existing keys).'
      : 'Configured. Mode (test/live) is determined by Felicity based on the key itself, not reported here.'
  });
});

// POST /admin/felicity-ngn/retry-onboard/:contractId — retry a failed/
// skipped NGN onboarding (e.g. after correcting a talent's NIN/BVN).
app.post('/admin/felicity-ngn/retry-onboard/:contractId', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'contract_not_active' });
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  const ngn = await onboardTalentNgn({ talent, contract });
  Object.assign(contract, ngn);
  await saveState();
  res.json(contract);
});

// POST /admin/felicity-ngn/resettle/:contractId — manually re-trigger the
// insurance-buy + fee/markup/salary split without waiting for a real
// webhook. Mainly for demos and for recovering from a failed settlement
// (e.g. hub_settlement_account_missing) after fixing the underlying issue.
app.post('/admin/felicity-ngn/resettle/:contractId', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'contract_not_active' });
  const settlement = await settleNgnPayment(contract);
  Object.assign(contract, settlement);
  await saveState();
  res.json(contract);
});

// POST /admin/felicity-ngn/check-policy/:contractId — manually re-check
// whether the policy document has arrived yet, without waiting for the
// real (asynchronous, provider-timed) webhook — mainly for demos. Reuses
// the exact same "did the document just become available" detection as
// the real webhook handler, so the email fires correctly here too, not
// just on the real webhook path.
app.post('/admin/felicity-ngn/check-policy/:contractId', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (!contract.coverage_reference) return res.status(409).json({ error: 'no_policy_purchased_yet' });

  try {
    const result = await getPolicyNgn(contract.coverage_reference);
    const documentUrl = result.policy?.policy_document_url || null;
    const documentJustArrived = documentUrl && !contract.coverage_policy_document_url;

    if (documentUrl) contract.coverage_policy_document_url = documentUrl;
    if (result.policy?.start_date) contract.coverage_start_date = result.policy.start_date;
    if (result.policy?.expiration_date) contract.coverage_expiration_date = result.policy.expiration_date;

    if (documentJustArrived) {
      const talent = db.talents.find(t => t.talent_id === contract.talent_id);
      await sendPolicyDocumentEmail(contract, talent);
    }

    await saveState();
    res.json({ contract, document_just_arrived: documentJustArrived });
  } catch (err) {
    res.status(502).json({ error: 'get_policy_failed', message: err.message });
  }
});

// GET /admin/fincra/payout-status/:contractId — real ledger for this
// contract's salary VA, straight from Felicity.
app.get('/admin/fincra/payout-status/:contractId', requireAdminKey, async (req, res) => {
  if (!FINCRA_CONFIGURED) return res.status(422).json({ error: 'fincra_not_configured' });
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  try {
    const data = await fincra.payoutStatus(contract.contract_id);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'fincra_request_failed', message: err.message });
  }
});

// POST /admin/fincra/simulate/:contractId — the key demo tool. Fires a fake
// USD deposit through the ENTIRE real pipeline (test mode only, per
// Felicity's own guard) — VA credit → FX → split fan-out → NGN payouts —
// in seconds, live, in front of whoever you're demoing to.
app.post('/admin/fincra/simulate/:contractId', requireAdminKey, async (req, res) => {
  if (!FINCRA_CONFIGURED) return res.status(422).json({ error: 'fincra_not_configured' });
  if (FINCRA_MODE !== 'test') return res.status(403).json({ error: 'simulate_only_in_test_mode' });
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  const amount = Number(req.body?.amount) || 500;
  try {
    const data = await fincra.simulate(contract.contract_id, amount);
    res.json({ simulated_usd_amount: amount, result: data });
  } catch (err) {
    res.status(502).json({ error: 'fincra_request_failed', message: err.message });
  }
});

// GET /admin/mycover/products — real catalog, use this to find product_ids
// to paste into MYCOVER_PRODUCT_ID_BASIC/PLUS/FAMILY.
app.get('/admin/mycover/products', requireAdminKey, async (req, res) => {
  if (!MYCOVER_CONFIGURED) return res.status(422).json({ error: 'mycover_not_configured' });
  try {
    const data = await mycover.listProducts();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'mycover_request_failed', message: err.message });
  }
});

// GET /admin/mycover/products/:id — full detail for ONE product, including
// beneficiary/dependent requirements. Use this before picking a plan for
// the "family" tier specifically — a higher price doesn't by itself mean a
// product supports covering dependents.
app.get('/admin/mycover/products/:id', requireAdminKey, async (req, res) => {
  if (!MYCOVER_CONFIGURED) return res.status(422).json({ error: 'mycover_not_configured' });
  try {
    const data = await mycover.getProduct(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'mycover_request_failed', message: err.message });
  }
});

// POST /admin/mycover/retry/:contractId — retry a failed/skipped coverage
// purchase for an already-accepted contract (e.g. after fixing missing KYC
// fields or setting a product_id for the first time).
app.post('/admin/mycover/retry/:contractId', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'contract_not_active', message: 'Talent must have accepted the contract first.' });
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  const coverage = await purchaseCoverage({ talent, contract });
  Object.assign(contract, coverage);
  await saveState();
  res.json(contract);
});

// POST /admin/contracts/:id/resend-welcome-email — the welcome email (HMO
// policy + salary account details) only ever fires ONCE, at the exact
// moment a contract first goes active — by design, so re-visiting the
// accept link doesn't trigger a second insurance purchase. Use this to
// manually resend it for a contract that's already active, e.g. if the
// talent lost the original or you're re-testing an already-accepted
// contract from before this feature existed.
app.post('/admin/contracts/:id/resend-welcome-email', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'contract_not_active', message: 'Talent must have accepted the contract first.' });
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (!talent?.email) return res.status(422).json({ error: 'talent_missing_email' });
  await sendWelcomeEmail(contract, talent);
  res.json({ sent: true, to: talent.email });
});

// POST /admin/fincra/retry/:contractId — retry a failed/skipped salary VA
// issuance. Use this after fixing a talent's bank details (e.g. a bad
// account name or bank code) rather than needing them to re-do the whole
// acceptance form.
app.post('/admin/fincra/retry/:contractId', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'contract_not_active', message: 'Talent must have accepted the contract first.' });
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  const salary = await issueSalaryAccount({ talent, contract });
  Object.assign(contract, salary);
  await saveState();
  res.json(contract);
});

// GET /admin/dropbox-sign/status — is W-8BEN collection configured
app.get('/admin/dropbox-sign/status', requireAdminKey, (req, res) => {
  res.json({
    configured: DROPBOX_SIGN_CONFIGURED,
    test_mode: DROPBOX_SIGN_TEST_MODE,
    note: !DROPBOX_SIGN_CONFIGURED
      ? 'Not configured — set DROPBOX_SIGN_API_KEY.'
      : DROPBOX_SIGN_TEST_MODE
        ? 'Configured in TEST MODE — signatures are watermarked and not legally binding. Set DROPBOX_SIGN_TEST_MODE=false to go live.'
        : 'Configured, LIVE — signatures are real and legally binding.'
  });
});

// POST /admin/dropbox-sign/retry/:contractId — retry a failed/skipped
// W-8BEN send (e.g. after the talent's email was corrected).
app.post('/admin/dropbox-sign/retry/:contractId', requireAdminKey, async (req, res) => {
  const contract = db.contracts.get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'contract_not_active', message: 'Talent must have accepted the contract first.' });
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  const w8ben = await requestW8BenSignature({ talent, contract });
  Object.assign(contract, w8ben);
  await saveState();
  res.json(contract);
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

// GET /admin/pay-periods — every open/overdue pay period across EVERY
// client, in one view. This is the real answer to "is anyone late on
// payroll" — worth showing directly in a hub demo, since it's the kind of
// operational visibility a manual spreadsheet-based process doesn't have.
// Filter with ?status=overdue to see only what needs attention.
app.get('/admin/pay-periods', requireAdminKey, (req, res) => {
  let periods = [...db.payPeriods.values()].map(p => ({ ...p, status: payPeriodStatus(p) }));
  if (req.query.status) periods = periods.filter(p => p.status === req.query.status);
  periods.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  const withContext = periods.map(p => {
    const contract = db.contracts.get(p.contract_id);
    return { ...p, talent_name: contract?.talent_name || null, employer_name: contract?.employer_name || null };
  });

  res.json({
    count: withContext.length,
    overdue_count: withContext.filter(p => p.status === 'overdue').length,
    results: withContext
  });
});

/* ---------------------------------------------------------------------- *
 * ROUTES — everything under /v1 requires the API key EXCEPT the two
 * talent-facing "accept" links below, which are public (a talent has no
 * API key — they're clicking a link from an email).
 * ---------------------------------------------------------------------- */
/* ---------------------------------------------------------------------- *
 * ROUTES — everything under /v1 requires the API key EXCEPT the talent-
 * facing "accept" links below, which are public (a talent has no API
 * key — they're clicking a link from an email, or submitting a form from
 * one). GET on both engagement/contract accept links; POST only on the
 * contract one, since that's the one that may collect a KYC form.
 * ---------------------------------------------------------------------- */
app.use('/v1', (req, res, next) => {
  if (req.method === 'GET' && /^\/(engagements|contracts)\/[^/]+\/accept$/.test(req.path)) {
    return next();
  }
  if (req.method === 'POST' && /^\/contracts\/[^/]+\/accept$/.test(req.path)) {
    return next();
  }
  return requireApiKey(req, res, next);
});

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

/* ---------------------------------------------------------------------- *
 * HUB TALENT MANAGEMENT — self-service upload/read/edit of a hub's OWN
 * roster. Before this, only the admin key could add talent (one at a
 * time, via /admin/talents) — no hub could sync their own alumni database
 * without asking Chris to do it manually. These three endpoints are
 * hub-key-only (rejected outright for enterprise keys, which have no
 * "own roster" to speak of) and every write is silently forced into the
 * caller's own hub_scope — a hub can never read, create, or touch a
 * talent outside its own pipeline, no matter what the request body says.
 * ---------------------------------------------------------------------- */

// GET /v1/talents/roster — a hub's own full roster, every status, not just
// "available" — distinct from /discover, which is the enterprise-facing
// "who can I hire right now" view. This is the hub-facing "everyone I've
// ever uploaded" view.
app.get('/v1/talents/roster', (req, res) => {
  if (req.clientType !== 'hub') {
    return res.status(403).json({ error: 'hub_only', message: 'This endpoint returns your own hub roster — use /v1/talents/discover to browse the full pool instead.' });
  }
  const results = db.talents.filter(t => t.pipeline === req.hubScope);
  res.json({ count: results.length, results });
});

// POST /v1/talents/upload — bulk create/update. Body: { "talents": [ {...}, {...} ] }.
// Dedup key is EMAIL, scoped to the hub's own pipeline:
//   - email already exists in THIS hub's pipeline  -> update in place
//   - email already exists in a DIFFERENT hub's pipeline -> rejected as a
//     conflict for that one item, nothing overwritten
//   - email not seen before -> created, pipeline forced to this hub's scope
// Every item is processed independently and reported independently — one
// bad row in a 40-talent sync doesn't fail the other 39.
app.post('/v1/talents/upload', async (req, res) => {
  if (req.clientType !== 'hub') {
    return res.status(403).json({ error: 'hub_only', message: 'This endpoint is for hub-type keys only — each hub manages its own talent roster.' });
  }

  const items = Array.isArray(req.body?.talents) ? req.body.talents : null;
  if (!items || !items.length) {
    return res.status(400).json({ error: 'talents_array_required', message: 'Body must be { "talents": [ {...}, {...} ] } — at least one talent.' });
  }

  const results = items.map((item, index) => {
    const { name, email, stack, country, vetted_score } = item || {};
    if (!name || !email || !country) {
      return { index, error: 'missing_required_field', message: 'name, email, and country are required', input: item };
    }

    const existingSameHub = db.talents.find(t => t.email === email && t.pipeline === req.hubScope);
    const existingOtherHub = db.talents.find(t => t.email === email && t.pipeline !== req.hubScope);

    if (existingOtherHub) {
      return { index, error: 'email_conflict', message: `A talent with this email already exists under a different pipeline (${existingOtherHub.pipeline}) — not overwritten.`, email };
    }

    if (existingSameHub) {
      // UPDATE — status is deliberately NOT touched by a re-sync. It's a
      // lifecycle field this system manages (available/engaged/...), not
      // something a hub's own database necessarily tracks the same way.
      existingSameHub.name = name;
      if (Array.isArray(stack)) existingSameHub.stack = stack;
      existingSameHub.country = country;
      if (vetted_score !== undefined) existingSameHub.vetted_score = Number(vetted_score) || existingSameHub.vetted_score;
      return { index, action: 'updated', talent: existingSameHub };
    }

    // CREATE — pipeline is ALWAYS the caller's own hub_scope, never taken
    // from the request body. This is what makes it structurally impossible
    // for one hub to inject talent into another hub's pipeline.
    const talent = {
      talent_id: id('tal'),
      name,
      email,
      stack: Array.isArray(stack) ? stack : [],
      pipeline: req.hubScope,
      country,
      vetted_score: Number(vetted_score) || 75,
      status: 'available',
    };
    db.talents.push(talent);
    return { index, action: 'created', talent };
  });

  await saveState();

  res.status(201).json({
    count: results.length,
    created: results.filter(r => r.action === 'created').length,
    updated: results.filter(r => r.action === 'updated').length,
    failed: results.filter(r => r.error).length,
    results,
  });
});

// PATCH /v1/talents/:id — edit ONE talent already in the caller's own
// roster (fix a typo, update a stack/skill). Same hub-only + own-pipeline
// restriction as upload. Pipeline and status are not editable here, for
// the same reasons as above.
app.patch('/v1/talents/:id', async (req, res) => {
  if (req.clientType !== 'hub') {
    return res.status(403).json({ error: 'hub_only', message: 'This endpoint is for hub-type keys only.' });
  }
  const talent = db.talents.find(t => t.talent_id === req.params.id && t.pipeline === req.hubScope);
  // Deliberately the SAME error for "doesn't exist" and "exists but isn't
  // yours" — a hub shouldn't be able to probe whether a given talent_id
  // belongs to some other hub by watching which error code comes back.
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });

  const { name, stack, country, vetted_score } = req.body || {};
  if (name !== undefined) talent.name = name;
  if (Array.isArray(stack)) talent.stack = stack;
  if (country !== undefined) talent.country = country;
  if (vetted_score !== undefined) talent.vetted_score = Number(vetted_score) || talent.vetted_score;

  await saveState();
  res.json(talent);
});

/* ---------------------------------------------------------------------- *
 * THE HIRING FLOW — this is the real sequence, not one instant API call:
 *
 * 1. POST /v1/engagements/create  — enterprise clicks "Engage". Sends the
 *    TALENT an interview invite email (with whatever meeting/booking link
 *    the enterprise provides — Calendly, Zoom, Meet, anything). Talent
 *    status locks to "interviewing" so nobody else can engage them
 *    mid-process. Terms (currency, plan, proposed salary) are captured
 *    HERE and carried forward — the enterprise doesn't re-enter them later.
 *
 * 2. GET /v1/engagements/:id/accept — TALENT clicks the link in that
 *    email to confirm they're in for the interview. No API key needed;
 *    it's a public token-based link, same pattern as a DocuSign/Calendly
 *    confirmation link.
 *
 * 3. The interview itself happens OFF-PLATFORM — a real human conversation
 *    on whatever call tool was in the invite. FetchTalos doesn't try to be
 *    a video product.
 *
 * 4. POST /v1/engagements/:id/contract — enterprise clicks "Contract"
 *    (after the interview went well). Generates the real contract using
 *    the terms captured back in step 1, and emails THE TALENT the
 *    contract terms + an accept link. Nothing changes for the talent yet.
 *
 * 5. GET /v1/contracts/:id/accept — TALENT accepts the contract. ONLY NOW
 *    does status flip to "engaged" and the contract to "active". This is
 *    the step that was missing before — a talent should never be marked
 *    hired because an enterprise clicked a button with zero involvement
 *    from the talent themselves.
 * ---------------------------------------------------------------------- */

// POST /v1/engagements/create — "Engage": sends an interview invite
app.post('/v1/engagements/create', async (req, res) => {
  const {
    talent_id, employer_name, role_title, employer_country, employer_currency = 'USD', coverage_plan = 'remote_contractor_basic',
    coverage_months = 1, proposed_amount, interview_link, proposed_time, message, kpis
  } = req.body || {};

  if (!interview_link) return res.status(400).json({ error: 'interview_link is required — a Calendly/Zoom/Meet link, whatever the enterprise uses' });
  if (!employer_name) return res.status(400).json({ error: 'employer_name is required — this is the company name that will appear on the offer letter' });
  if (!role_title) return res.status(400).json({ error: 'role_title is required — e.g. "Backend Engineer"' });

  const talent = db.talents.find(t => t.talent_id === talent_id);
  if (!talent) return res.status(404).json({ error: 'talent_not_found' });
  if (talent.status !== 'available') return res.status(409).json({ error: 'talent_not_available' });
  if (!talent.email) {
    return res.status(422).json({ error: 'talent_missing_email', message: `${talent.name} has no email on file — use PATCH /admin/talents/${talent.talent_id} to set one before engaging them.` });
  }

  const engagement_id = id('eng');
  const accept_token = crypto.randomBytes(12).toString('hex');
  const engagement = {
    engagement_id,
    client_id: req.clientId,
    talent_id,
    talent_name: talent.name,
    employer_name, role_title,
    employer_country, employer_currency, coverage_plan, coverage_months: Number(coverage_months) || 1, proposed_amount: proposed_amount ? Number(proposed_amount) : null,
    interview_link, proposed_time: proposed_time || null, message: message || null,
    kpis: Array.isArray(kpis) ? kpis : null,
    status: 'interview_invited', // interview_invited -> interview_accepted -> contract_sent -> contract_accepted
    accept_token,
    created_at: new Date().toISOString(),
  };
  db.engagements.set(engagement_id, engagement);
  talent.status = 'interviewing';
  await saveState();

  const acceptUrl = `${PUBLIC_BASE_URL}/v1/engagements/${engagement_id}/accept?token=${accept_token}`;
  await sendEmail({
    to: talent.email,
    subject: `Interview invite from ${employer_name} via FetchTalos`,
    html: `<p>Hi ${talent.name},</p>
      <p><b>${employer_name}</b> would like to interview you for the <b>${role_title}</b> role, sourced through your pipeline.</p>
      ${proposed_time ? `<p><b>Proposed time:</b> ${proposed_time}</p>` : ''}
      <p><b>Meeting link:</b> <a href="${interview_link}">${interview_link}</a></p>
      ${message ? `<p><b>Note from ${employer_name}:</b> ${message}</p>` : ''}
      <p><a href="${acceptUrl}">Click here to confirm you're in for this interview</a></p>`
  });

  res.status(201).json({ ...engagement, accept_url: acceptUrl });
});

// GET /v1/engagements/:id/accept — TALENT-facing, public, no API key
app.get('/v1/engagements/:id/accept', async (req, res) => {
  const engagement = db.engagements.get(req.params.id);
  if (!engagement || engagement.accept_token !== req.query.token) {
    return res.status(404).send('<h2>Invalid or expired link.</h2>');
  }
  if (engagement.status === 'interview_invited') {
    engagement.status = 'interview_accepted';
    await saveState();
  }
  res.send(`<h2>Interview confirmed</h2><p>Thanks ${engagement.talent_name} — you're confirmed. See you there.</p>`);
});

// POST /v1/engagements/:id/contract — enterprise clicks "Contract" after the interview
app.post('/v1/engagements/:id/contract', async (req, res) => {
  const engagement = db.engagements.get(req.params.id);
  if (!engagement || engagement.client_id !== req.clientId) return res.status(404).json({ error: 'engagement_not_found' });
  if (engagement.status === 'contract_sent' || engagement.status === 'contract_accepted') {
    return res.status(409).json({ error: 'contract_already_sent' });
  }

  const talent = db.talents.find(t => t.talent_id === engagement.talent_id);
  const contract_id = id('ctr');
  const accept_token = crypto.randomBytes(12).toString('hex');
  const contract = {
    contract_id,
    engagement_id: engagement.engagement_id,
    client_id: req.clientId,
    talent_id: engagement.talent_id,
    talent_name: engagement.talent_name,
    employer_name: engagement.employer_name,
    role_title: engagement.role_title,
    employer_country: engagement.employer_country,
    employer_currency: engagement.employer_currency,
    proposed_amount: engagement.proposed_amount,
    tax_form: taxFormMap[engagement.employer_country] || 'local_equivalent_required',
    coverage_plan: engagement.coverage_plan,
    coverage_months: engagement.coverage_months || 1,
    kyc_status: 'pending', // would flip to verified/failed via Bridgecard webhook in production
    coverage_status: 'not_yet_purchased', // real purchase happens when the talent ACCEPTS the contract, not before
    coverage_policy_id: null,
    coverage_reference: null,
    coverage_product_id: null,
    coverage_note: null,
    status: 'pending_talent_signature', // flips to 'active' only when the TALENT accepts below
    accept_token,
    created_at: new Date().toISOString(),
  };
  db.contracts.set(contract_id, contract);
  engagement.status = 'contract_sent';
  await saveState();

  const acceptUrl = `${PUBLIC_BASE_URL}/v1/contracts/${contract_id}/accept?token=${accept_token}`;

  let attachments;
  try {
    const pdfBuffer = await generateOfferLetterPdf({ engagement, contract });
    attachments = [{ filename: `${engagement.employer_name.replace(/\s+/g, '_')}_Offer_Letter.pdf`, content: pdfBuffer.toString('base64') }];
  } catch (err) {
    console.warn('[pdf] offer letter generation failed, sending without attachment:', err.message);
  }

  await sendEmail({
    to: talent.email,
    subject: `Your offer from ${engagement.employer_name} is ready to review`,
    html: `<p>Hi ${engagement.talent_name},</p>
      <p>Following your interview, <b>${engagement.employer_name}</b> would like to move forward. Attached is
      your formal offer letter for the <b>${engagement.role_title}</b> role, covering remuneration,
      responsibilities, and benefits.</p>
      <ul>
        <li><b>Role:</b> ${engagement.role_title}</li>
        <li><b>Remuneration:</b> ${engagement.proposed_amount ? `${engagement.proposed_amount} ${engagement.employer_currency} / month` : 'see attached'}</li>
        <li><b>Tax form:</b> ${contract.tax_form}</li>
      </ul>
      <p><a href="${acceptUrl}">Click here to accept and sign</a></p>`,
    attachments
  });

  res.status(201).json({ ...contract, accept_url: acceptUrl, offer_letter_attached: Boolean(attachments) });
});

// GET /v1/contracts/:id/accept — TALENT-facing, public, no API key. THIS is
// the only place a talent's status is allowed to flip to "engaged".
function renderKycForm(contract, missingFields, token) {
  const PLACEHOLDERS = {
    rubies_account_name: 'e.g. Felix Okoye',
    rubies_account_number: 'e.g. 0123456789',
    rubies_bank_code: 'e.g. 058',
    bvn: 'e.g. 22222222222',
    customer_phone: 'e.g. 08012345678',
    phone: 'e.g. 08012345678',
  };
  const rows = missingFields.map(f => {
    const label = FIELD_LABELS[f] || f;
    const type = f === 'date_of_birth' || f === 'customer_dob' ? 'date' : 'text';
    const placeholder = PLACEHOLDERS[f] || '';
    return `<label style="display:block;margin:14px 0 4px;font-family:sans-serif;">${label}</label>
      <input name="${f}" type="${type}" ${placeholder ? `placeholder="${placeholder}"` : ''} required style="padding:8px;width:320px;max-width:90vw;font-size:14px;">`;
  }).join('');

  return `
    <div style="font-family:serif;max-width:520px;margin:40px auto;padding:0 20px;">
      <h2>Almost there, ${contract.talent_name}</h2>
      <p style="font-family:sans-serif;">Before your health coverage can be activated, we need a couple more details — this stays with your coverage provider, not with the employer.</p>
      <form method="POST" action="/v1/contracts/${contract.contract_id}/accept">
        <input type="hidden" name="token" value="${token}">
        ${rows}
        <button type="submit" style="margin-top:20px;padding:10px 22px;font-size:14px;">Submit and activate coverage</button>
      </form>
    </div>`;
}

async function finalizeContractAcceptance(contract) {
  contract.status = 'active';
  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (talent) talent.status = 'engaged';
  const engagement = contract.engagement_id ? db.engagements.get(contract.engagement_id) : null;
  if (engagement) engagement.status = 'contract_accepted';

  if (talent) {
    if (contract.employer_currency === 'NGN') {
      // NGN-to-NGN — a fundamentally different rail. No coverage purchase
      // here (that happens on FIRST PAYMENT, not at acceptance — see
      // settleNgnPayment), no Fincra USD VA. Just the intermediate NUBAN.
      const ngn = await onboardTalentNgn({ talent, contract });
      Object.assign(contract, ngn);
    } else {
      const coverage = await purchaseCoverage({ talent, contract });
      Object.assign(contract, coverage);

      // Issue AFTER coverage so the split can correctly reimburse whatever
      // was actually just purchased (or correctly omit that leg if it wasn't).
      const salary = await issueSalaryAccount({ talent, contract });
      Object.assign(contract, salary);
    }

    // W-8BEN — gracefully no-ops for non-US contracts (see taxFormMap),
    // which already correctly covers NGN-flow contracts (NG employer).
    const w8ben = await requestW8BenSignature({ talent, contract });
    Object.assign(contract, w8ben);
  }

  // First pay period starts NOW, regardless of whether VA issuance
  // succeeded — this tracks what's OWED, which begins the moment the
  // talent accepts, independent of whether the payment rail is fully
  // wired yet (a failed VA can be retried later; the period doesn't wait).
  createNextPayPeriod(contract, new Date());

  await sendWelcomeEmail(contract, talent);
  await saveState();
}

/**
 * The HMO policy and salary account details, sent somewhere the talent can
 * actually keep them (previously only ever shown on the confirmation
 * WEBPAGE — lost forever if they closed the tab). Extracted as its own
 * function so it can be manually resent via admin without needing to
 * re-run the entire acceptance flow (which would incorrectly re-purchase
 * insurance / re-issue a salary account).
 */
async function sendWelcomeEmail(contract, talent) {
  if (!talent?.email) return { sent: false, reason: 'talent_missing_email' };

  const coverageLine = contract.coverage_status === 'active'
    ? `<li><b>Health coverage:</b> Active — policy ${contract.coverage_policy_id || ''}</li>`
    : contract.coverage_status && contract.coverage_status !== 'not_yet_purchased'
      ? `<li><b>Health coverage:</b> ${contract.coverage_status}${contract.coverage_note ? ' — ' + contract.coverage_note : ''}</li>`
      : '';
  const salaryLine = contract.salary_status === 'va_issued'
    ? `<li><b>Salary account:</b> ${contract.salary_va_account_number} — ${contract.salary_va_bank_name}, routing ${contract.salary_va_routing_number}</li>`
    : contract.salary_status && contract.salary_status !== 'not_yet_purchased'
      ? `<li><b>Salary account:</b> ${contract.salary_status}${contract.salary_note ? ' — ' + contract.salary_note : ''}</li>`
      : '';
  const ngnLine = contract.ngn_status === 'onboarded'
    ? `<li><b>NGN payment account:</b> ${contract.ngn_account_number} — ${contract.ngn_bank_name} (this is a pass-through account — your actual salary lands in your own bank account each pay period)</li>`
    : contract.ngn_status && contract.ngn_status !== 'not_yet_purchased'
      ? `<li><b>NGN payment account:</b> ${contract.ngn_status}${contract.ngn_note ? ' — ' + contract.ngn_note : ''}</li>`
      : '';

  return sendEmail({
    to: talent.email,
    subject: `Welcome aboard, ${contract.talent_name} — your account details`,
    html: `<p>Hi ${contract.talent_name},</p>
      <p>Your contract with ${contract.employer_name} is now active. Here's what's set up for you:</p>
      <ul>${coverageLine}${salaryLine}${ngnLine}</ul>
      <p>Keep this email — it's your record of both.</p>
      <p>— FetchTalos</p>`
  });
}

function acceptedConfirmationHtml(contract) {
  const coverageLine = contract.coverage_status === 'active'
    ? `Your health coverage is active — policy ${contract.coverage_policy_id || ''}.`
    : contract.coverage_status === 'not_yet_purchased' ? ''
    : `Coverage status: ${contract.coverage_status}.`;

  const salaryLine = contract.salary_status === 'va_issued'
    ? `Salary account ready — wire instructions: ${contract.salary_va_account_number || ''} (${contract.salary_va_bank_name || ''}, routing ${contract.salary_va_routing_number || ''}).`
    : contract.salary_status === 'not_yet_purchased' || !contract.salary_status ? ''
    : `<span style="color:#b91c1c;">Salary account status: ${contract.salary_status}${contract.salary_note ? ' — ' + contract.salary_note : ''}. This needs attention before payroll can run for real.</span>`;

  const ngnLine = contract.ngn_status === 'onboarded'
    ? `NGN payment account ready: ${contract.ngn_account_number || ''} (${contract.ngn_bank_name || ''}).`
    : !contract.ngn_status ? ''
    : `<span style="color:#b91c1c;">NGN account status: ${contract.ngn_status}${contract.ngn_note ? ' — ' + contract.ngn_note : ''}. This needs attention before payroll can run for real.</span>`;

  return `<h2>Contract accepted</h2><p>Welcome aboard, ${contract.talent_name}. ${coverageLine}</p><p>${salaryLine}${ngnLine}</p>`;
}

// GET — talent clicks the link from their contract email. If MyCover needs
// info we don't have yet, show a form instead of finalizing immediately.
app.get('/v1/contracts/:id/accept', async (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract || contract.accept_token !== req.query.token) {
    return res.status(404).send('<h2>Invalid or expired link.</h2>');
  }
  if (contract.status !== 'pending_talent_signature') {
    return res.send(acceptedConfirmationHtml(contract)); // already accepted — idempotent, don't re-purchase
  }

  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  const isNgnFlow = contract.employer_currency === 'NGN';

  // NGN-flow contracts don't purchase coverage at acceptance time (that
  // happens on first payment — see settleNgnPayment), so there's no point
  // asking for the OLD MyCover proxy's required fields here. They DO still
  // need rubies_account_* (that's where their real salary eventually lands)
  // plus nin specifically, which nothing else in the system asks for.
  const missingCoverage = (talent && !isNgnFlow) ? await getMissingCoverageFields(talent, contract) : [];
  const missingSalary = (talent && !isNgnFlow) ? fincraMissingFormFields(talent) : [];
  const missingNgn = (talent && isNgnFlow) ? ngnMissingFormFields(talent) : [];
  // Dedup by underlying talent PROPERTY, not raw field name — MyCover and
  // Fincra sometimes use different names for the same thing (customer_phone
  // vs phone), and showing two inputs for the same actual field is confusing.
  const seenProps = new Set();
  const missing = [];
  for (const field of [...missingCoverage, ...missingSalary, ...missingNgn]) {
    const prop = REQUIRED_FIELD_TO_TALENT_PROP[field] || field;
    if (seenProps.has(prop)) continue;
    seenProps.add(prop);
    missing.push(field);
  }
  if (missing.length) {
    return res.send(renderKycForm(contract, missing, req.query.token));
  }

  await finalizeContractAcceptance(contract);
  res.send(acceptedConfirmationHtml(contract));
});

// POST — talent submitted the KYC form above. Save what they gave us, then
// finalize exactly as GET would have if nothing had been missing.
app.post('/v1/contracts/:id/accept', async (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract || contract.accept_token !== req.body.token) {
    return res.status(404).send('<h2>Invalid or expired link.</h2>');
  }
  if (contract.status !== 'pending_talent_signature') {
    return res.send(acceptedConfirmationHtml(contract));
  }

  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (talent) {
    for (const [field, value] of Object.entries(req.body)) {
      const prop = REQUIRED_FIELD_TO_TALENT_PROP[field];
      if (prop && value) talent[prop] = value;
    }
    await saveState();
  }

  await finalizeContractAcceptance(contract);
  res.send(acceptedConfirmationHtml(contract));
});

// GET /v1/engagements — list, scoped to requesting client
app.get('/v1/engagements', (req, res) => {
  const mine = [...db.engagements.values()].filter(e => e.client_id === req.clientId);
  res.json({ count: mine.length, results: mine });
});

// GET /v1/contracts/:id
app.get('/v1/contracts/:id', (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract || contract.client_id !== req.clientId) return res.status(404).json({ error: 'contract_not_found' });
  res.json(contract);
});

// GET /v1/contracts  (list — scoped to the requesting client only)
// GET /v1/rates?currency=USD — the same live rate payroll disbursement
// actually uses, exposed so callers (like the console) can compute an
// honest estimate instead of guessing or hardcoding a number.
app.get('/v1/rates', async (req, res) => {
  const currency = (req.query.currency || 'USD').toUpperCase();
  try {
    const fx = await getNgnRate(currency);
    res.json({ currency, rate: fx.rate, source: fx.source });
  } catch (err) {
    res.status(502).json({ error: 'fx_lookup_failed', detail: err.message });
  }
});

app.get('/v1/contracts', async (req, res) => {
  const mine = [...db.contracts.values()].filter(c => c.client_id === req.clientId);

  // Enrich each ACTIVE contract with whether its next payment would be its
  // FIRST (the only time insurance gets reimbursed), and if so, the REAL
  // live-converted estimate of that exact premium — not a placeholder
  // label. The premium itself (coverage_amount_paid, in NGN) is the exact
  // amount that was actually submitted to MyCover's real purchase call at
  // contract acceptance; only the FX conversion shown here is "live as of
  // right now" and can drift slightly from the rate at actual disburse time.
  const enriched = await Promise.all(mine.map(async (c) => {
    if (c.status !== 'active' || !c.coverage_amount_paid) return c;
    const alreadyPaid = [...db.payPeriods.values()].filter(p => p.contract_id === c.contract_id && p.paid_at).length;
    const isFirstPayment = alreadyPaid === 0;
    if (!isFirstPayment) return { ...c, insurance_due_next_payment: false };
    try {
      const fx = await getNgnRate(c.employer_currency || 'USD');
      return {
        ...c,
        insurance_due_next_payment: true,
        insurance_estimate_employer_currency: +(c.coverage_amount_paid / fx.rate).toFixed(2),
        insurance_estimate_fx_source: fx.source,
      };
    } catch {
      return { ...c, insurance_due_next_payment: true }; // FX lookup failed — still flag it's due, just can't show a number
    }
  }));

  res.json({ count: enriched.length, results: enriched });
});

// GET /v1/contracts/:id/pay-periods — recurring salary schedule for this
// contract, with LIVE status (paid/due/overdue) computed on every read.
app.get('/v1/contracts/:id/pay-periods', (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract || contract.client_id !== req.clientId) return res.status(404).json({ error: 'contract_not_found' });
  const periods = [...db.payPeriods.values()]
    .filter(p => p.contract_id === req.params.id)
    .sort((a, b) => a.period_number - b.period_number)
    .map(p => ({ ...p, status: payPeriodStatus(p) }));
  res.json({ count: periods.length, results: periods });
});

// GET /v1/contracts/:id/w8ben — downloads the REAL signed PDF from Dropbox
// Sign on demand (nothing is cached locally — always fetches the current
// signed document live). This is what an enterprise's dashboard would call;
// for now, the console has the same button, since there's no separate
// enterprise dashboard yet.
app.get('/v1/contracts/:id/w8ben', async (req, res) => {
  const contract = db.contracts.get(req.params.id);
  if (!contract || contract.client_id !== req.clientId) return res.status(404).json({ error: 'contract_not_found' });
  if (!contract.w8ben_signature_request_id) return res.status(404).json({ error: 'w8ben_not_requested', message: `Current status: ${contract.w8ben_status || 'none'}` });
  if (contract.w8ben_status !== 'signed') return res.status(409).json({ error: 'w8ben_not_yet_signed', status: contract.w8ben_status });
  if (!DROPBOX_SIGN_CONFIGURED) return res.status(422).json({ error: 'dropbox_sign_not_configured' });

  try {
    const dlRes = await fetch(`${DROPBOX_SIGN_BASE}/signature_request/files/${contract.w8ben_signature_request_id}?file_type=pdf`, {
      headers: { Authorization: dropboxSignAuthHeader() },
    });
    if (!dlRes.ok) throw new Error(`dropbox_sign_download_${dlRes.status}`);
    const buffer = Buffer.from(await dlRes.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="W-8BEN-${contract.talent_name.replace(/\s+/g, '_')}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'download_failed', message: err.message });
  }
});

// POST /v1/payroll/disburse
// This is the core of what you asked for: employer pays in THEIR currency,
// talent receives NGN. Conversion happens here, against a live rate.
/**
 * Processes payroll for ONE contract. The amount is always derived from
 * the contract itself (contract.proposed_amount) — never trusted from the
 * caller — so what the talent was actually promised is what they actually
 * get, every time. Insurance is only reimbursed on the contract's first
 * ever settled period, since that premium was a one-time cost at contract
 * acceptance, not a recurring monthly charge.
 */
async function disburseOneContract(contract, req_clientId, idempotencyKey) {
  if (contract.client_id !== req_clientId) return { contract_id: contract.contract_id, error: 'contract_not_found' };
  if (contract.status !== 'active') {
    return { contract_id: contract.contract_id, error: 'contract_not_active', message: `Contract is "${contract.status}" — the talent must accept the contract before payroll can run.` };
  }

  if (idempotencyKey) {
    const existing = [...db.payouts.values()].find(p => p.idempotency_key === idempotencyKey && p.client_id === req_clientId);
    if (existing) return { ...existing, replayed: true };
  }

  const employerCurrency = contract.employer_currency || 'USD';
  let fx;
  try {
    fx = await getNgnRate(employerCurrency);
  } catch (err) {
    return { contract_id: contract.contract_id, error: 'fx_lookup_failed', detail: err.message };
  }

  const grossEmployerCurrency = Number(contract.proposed_amount) || 0;
  if (!grossEmployerCurrency) {
    return { contract_id: contract.contract_id, error: 'no_agreed_amount', message: 'This contract has no proposed_amount on file — cannot run payroll against it.' };
  }
  const platformFee = +(grossEmployerCurrency * 0.05).toFixed(2);

  // Insurance reimbursement ONLY on the very first settled period for this
  // contract — a one-time premium cost at acceptance, not recurring.
  const alreadyPaidCount = [...db.payPeriods.values()].filter(p => p.contract_id === contract.contract_id && p.paid_at).length;
  const isFirstPayment = alreadyPaidCount === 0;
  const insuranceReimbursement = (isFirstPayment && contract.coverage_amount_paid)
    ? +(contract.coverage_amount_paid / fx.rate).toFixed(2) // stored in NGN from the MyCover purchase — converted back to employer currency for this invoice line
    : 0;

  const employerTotalCharged = +(grossEmployerCurrency + platformFee + insuranceReimbursement).toFixed(2);
  const netTalentNgn = +(grossEmployerCurrency * fx.rate).toFixed(2); // talent always receives the FULL agreed amount — fees and insurance are marked up, never deducted

  const payout_id = id('pay');
  const payout = {
    payout_id,
    client_id: req_clientId,
    contract_id: contract.contract_id,
    talent_name: contract.talent_name,
    employer_currency: employerCurrency,
    gross_amount_employer_currency: grossEmployerCurrency,
    fx_rate: fx.rate,
    fx_source: fx.source,
    net_amount_ngn: netTalentNgn,
    platform_fee: platformFee,
    insurance_reimbursement: insuranceReimbursement,
    fetchtalos_revenue: platformFee,
    employer_total_charged: employerTotalCharged,
    rail_status: 'settled', // would be 'rubies_transfer_sent' -> webhook -> 'settled' in production
    status: 'settled',
    idempotency_key: idempotencyKey || null,
    created_at: new Date().toISOString(),
  };

  db.payouts.set(payout_id, payout);

  // The demo payoff moment: even though the money movement itself is
  // simulated (no real Fincra deposit happened), the PAY PERIOD state
  // updates for real — same function the real webhook uses.
  const settledPeriod = settleOldestUnpaidPeriod(contract.contract_id);
  const nextPeriod = settledPeriod ? [...db.payPeriods.values()]
    .filter(p => p.contract_id === contract.contract_id && !p.paid_at)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0] : null;

  if (settledPeriod) {
    payout.pay_period_settled = settledPeriod.period_id;
    payout.pay_period_number = settledPeriod.period_number;
  }
  if (nextPeriod) {
    payout.next_pay_period_due_date = nextPeriod.due_date;
  }

  const talent = db.talents.find(t => t.talent_id === contract.talent_id);
  if (talent?.email) {
    await sendEmail({
      to: talent.email,
      subject: `You've been paid — ₦${netTalentNgn.toLocaleString()} received`,
      html: `<p>Hi ${contract.talent_name},</p>
        <p>Your payment for this pay period has landed.</p>
        <ul>
          <li><b>Amount:</b> ₦${netTalentNgn.toLocaleString()} (converted from ${grossEmployerCurrency} ${employerCurrency} at ${fx.rate})</li>
          ${settledPeriod ? `<li><b>Pay period:</b> #${settledPeriod.period_number}</li>` : ''}
          ${nextPeriod ? `<li><b>Next payment due:</b> ${new Date(nextPeriod.due_date).toLocaleDateString()}</li>` : ''}
        </ul>
        <p>— FetchTalos</p>`
    });
  }

  return payout;
}

// POST /v1/payroll/disburse — bulk. Body: { contract_ids: ["ctr_...", ...],
// idempotency_key (optional, applied per-contract as "key:contract_id") }.
// Amounts are ALWAYS derived from each contract's own proposed_amount —
// never accepted from the caller — so what's actually paid always matches
// what the talent was actually promised.
app.post('/v1/payroll/disburse', async (req, res) => {
  const body = req.body || {};
  const contractIds = Array.isArray(body.contract_ids)
    ? body.contract_ids
    : (body.contract_id ? [body.contract_id] : []); // back-compat with the old single-contract shape

  if (!contractIds.length) {
    return res.status(400).json({ error: 'contract_ids (array) is required' });
  }

  const results = [];
  for (const contractId of contractIds) {
    const contract = db.contracts.get(contractId);
    if (!contract) { results.push({ contract_id: contractId, error: 'contract_not_found' }); continue; }
    const perContractKey = body.idempotency_key ? `${body.idempotency_key}:${contractId}` : null;
    results.push(await disburseOneContract(contract, req.clientId, perContractKey));
  }

  await saveState();

  const succeeded = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  const totals = succeeded.reduce((acc, p) => {
    acc.total_gross += p.gross_amount_employer_currency;
    acc.total_platform_fee += p.platform_fee;
    acc.total_insurance_reimbursement += p.insurance_reimbursement || 0;
    acc.total_employer_charged += p.employer_total_charged;
    return acc;
  }, { total_gross: 0, total_platform_fee: 0, total_insurance_reimbursement: 0, total_employer_charged: 0 });

  res.status(202).json({
    count: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    totals,
    results,
  });
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
    return acc;
  }, { total_volume_by_currency: {}, total_revenue: 0 });

  res.json({ ...totals, payout_count: payouts.length, payouts: payouts.reverse() });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'fetchtalos-api', time: new Date().toISOString(), persistence: PERSISTENCE_ENABLED ? 'enabled' : 'in-memory-only' }));

/**
 * Generic Felicity webhook signature verifier — same scheme used by both
 * the MyCover proxy and the Fincra proxy (HMAC-SHA256, X-Felicity-Signature).
 * Uses timing-safe comparison per Felicity's own reference implementation.
 */
function verifyFelicitySignature(rawBody, signature, secret) {
  if (!signature) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch etc — timingSafeEqual throws rather than returning false
  }
}

function handleMycoverWebhookEvent(event, body) {
  const { felicity_reference, data } = body;
  const policyId = data?.essential?.policy_id || data?.policy?.id || null;

  const contract = [...db.contracts.values()].find(c =>
    (felicity_reference && c.coverage_reference === felicity_reference) ||
    (policyId && c.coverage_policy_id === policyId)
  );
  if (!contract) return { matched: false };

  if (/purchase\.successful|policy\.activated/.test(event)) contract.coverage_status = 'active';
  else if (/purchase\.failed|policy\.failed/.test(event)) contract.coverage_status = 'purchase_failed';
  else if (/policy\.cancelled/.test(event)) contract.coverage_status = 'cancelled';
  else if (/policy\.expired/.test(event)) contract.coverage_status = 'expired';

  return { matched: true, contract, new_status: contract.coverage_status };
}

function handleFincraWebhookEvent(event, body) {
  const talentRef = body.talent_ref || body.data?.talent_ref;
  const contract = talentRef ? db.contracts.get(talentRef) : null;
  if (!contract) return { matched: false };

  contract.salary_events = contract.salary_events || [];
  contract.salary_events.push({ event, at: new Date().toISOString(), data: body });

  if (event === 'usd_va.credited') contract.salary_status = 'deposit_received';
  else if (event === 'fx.completed') contract.salary_status = 'fx_converted';
  else if (event === 'ngn.split_completed') contract.salary_status = 'payout_processing';
  else if (event === 'ngn.payout_settled') {
    contract.salary_status = 'payout_settled';
    contract.salary_last_settled_leg = body.leg_label || 'talent';
    // A split fires MULTIPLE payout_settled events — one per beneficiary
    // (talent, platform fee, insurance reimbursement). Only the TALENT's
    // own leg should close a pay period; settling on the platform fee leg
    // would incorrectly mark salary as paid when only the fee landed.
    if (!body.leg_label || body.leg_label === 'talent') {
      const settled = settleOldestUnpaidPeriod(contract.contract_id);
      if (settled) settled.matched_payout_id = body.fincra_payout_reference || null;
    }
  } else if (event === 'ngn.payout_failed') {
    contract.salary_status = 'payout_failed';
    contract.salary_note = body.reason || 'unknown reason';
  } else if (event === 'ngn.split_failed') {
    contract.salary_status = 'split_failed';
    contract.salary_note = body.reason || 'split_exceeds_ngn';
  }

  return { matched: true, contract, new_status: contract.salary_status };
}

/**
 * The NGN rail's webhook family — talent.onboarded, talent.va_credited,
 * talent.transfer_completed/failed, talent.policy_issued/failed. The
 * important one is talent.va_credited: that's what actually triggers the
 * automatic insurance-buy + fee/markup/salary split, via settleNgnPayment.
 * Async, unlike the other two handlers, since that orchestration makes
 * real outbound calls (get_talent, buy_insurance, send) — not just a
 * local status flip.
 */
async function handleFelicityNgnWebhookEvent(event, body) {
  const talentRef = body.talent_ref || body.data?.talent_ref;
  const contract = talentRef ? db.contracts.get(talentRef) : null;
  if (!contract) return { matched: false };

  if (event === 'talent.onboarded') {
    contract.ngn_status = 'onboarded';
  } else if (event === 'talent.va_credited') {
    const settlement = await settleNgnPayment(contract);
    Object.assign(contract, settlement);
  } else if (event === 'talent.transfer_completed') {
    contract.ngn_last_transfer_status = 'completed';
  } else if (event === 'talent.transfer_failed') {
    contract.ngn_last_transfer_status = 'failed';
    contract.ngn_note = body.reason || contract.ngn_note;
  } else if (event === 'talent.policy_issued') {
    contract.coverage_status = 'active';
    // Defensive extraction — the doc describes WHEN this fires (twice) and
    // WHAT field appears (policy_document_url), but doesn't spell out the
    // exact webhook body shape, unlike buy_insurance's response. Checking
    // a few reasonable locations rather than assuming one.
    const documentUrl = body.policy_document_url || body.policy?.policy_document_url || body.data?.policy_document_url || null;
    const startDate = body.start_date || body.policy?.start_date || null;
    const expirationDate = body.expiration_date || body.policy?.expiration_date || null;

    // This is the SECOND fire, specifically — the document just became
    // available where it wasn't before. Only NOW does it make sense to
    // notify the talent; emailing them at the first fire would just be a
    // broken/dead link, since the doc doesn't exist yet at that point.
    const documentJustArrived = documentUrl && !contract.coverage_policy_document_url;

    if (documentUrl) contract.coverage_policy_document_url = documentUrl;
    if (startDate) contract.coverage_start_date = startDate;
    if (expirationDate) contract.coverage_expiration_date = expirationDate;

    if (documentJustArrived) {
      const talent = db.talents.find(t => t.talent_id === contract.talent_id);
      await sendPolicyDocumentEmail(contract, talent);
    }
  } else if (event === 'talent.policy_failed') {
    contract.coverage_status = 'purchase_failed';
    contract.coverage_note = body.reason || contract.coverage_note;
  }

  return { matched: true, contract, new_status: contract.ngn_status };
}

/* ---------------------------------------------------------------------- *
 * POST /webhooks/felicity — PUBLIC, and the ONLY webhook URL you register
 * with Felicity. Their partner dashboard has exactly one webhook_url field
 * per partner key — MyCover events and Fincra events both arrive here,
 * distinguished by event name, not by separate URLs (an earlier version of
 * this code assumed two URLs; that was wrong — fixed to match how
 * Felicity's partner model actually works).
 *
 * Register: https://fetchtalos.onrender.com/webhooks/felicity
 * Set FELICITY_WEBHOOK_SECRET to the SAME secret pasted into Felicity
 * Admin's "Webhook secret" field on the fetchtalos partner card — per
 * Felicity's own setup guide, it's one shared secret for both event
 * families on that row, not two.
 *
 * /webhooks/mycover and /webhooks/felicity-fincra still work too (aliases
 * to this same handler) in case either was already registered somewhere —
 * harmless to keep, since only one URL will ever actually be hit in
 * practice given Felicity's one-URL-per-partner model.
 * ---------------------------------------------------------------------- */
app.post(['/webhooks/felicity', '/webhooks/mycover', '/webhooks/felicity-fincra'], async (req, res) => {
  const secret = process.env.FELICITY_WEBHOOK_SECRET || process.env.FINCRA_WEBHOOK_SECRET || process.env.MYCOVER_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'webhook_not_configured', message: 'Set FELICITY_WEBHOOK_SECRET to enable this endpoint.' });

  const valid = verifyFelicitySignature(req.rawBody, req.headers['x-felicity-signature'], secret);
  if (!valid) return res.status(401).json({ error: 'invalid_signature' });

  const event = req.headers['x-felicity-event'] || req.body?.event || '';
  const body = req.body || {};

  // Dispatch by event name — Fincra events all start with usd_va./fx./ngn.,
  // MyCover events start with purchase./policy./commission., the NGN rail's
  // own events start with talent. (distinct from Fincra's ngn.* events,
  // which are about a USD-split settling, not this rail's own balance).
  const isFincraEvent = /^(usd_va|fx|ngn)\./.test(event);
  const isNgnTalentEvent = /^talent\./.test(event);
  const result = isNgnTalentEvent
    ? await handleFelicityNgnWebhookEvent(event, body)
    : (isFincraEvent ? handleFincraWebhookEvent(event, body) : handleMycoverWebhookEvent(event, body));

  if (!result.matched) {
    console.warn(`[felicity webhook] event "${event}" didn't match any contract`);
    return res.status(200).json({ received: true, matched: false }); // 200 so Felicity doesn't retry forever on an event we'll never match
  }

  await saveState();
  res.status(200).json({ received: true, matched: true, contract_id: result.contract.contract_id, new_status: result.new_status });
});

/* ---------------------------------------------------------------------- *
 * POST /webhooks/dropbox-sign — PUBLIC. Register this exact URL in
 * Dropbox Sign's API Settings (account callback or app callback):
 *   https://fetchtalos.onrender.com/webhooks/dropbox-sign
 * No separate secret to configure — verification reuses DROPBOX_SIGN_API_KEY.
 *
 * Two real quirks handled here, both confirmed against current docs:
 * 1. The payload arrives as multipart/form-data with a field named "json"
 *    (not a raw JSON body) — multipartParser.none() extracts that field.
 * 2. Dropbox Sign requires the EXACT response body "Hello API Event
 *    Received" (with a 200 status) or it treats the callback as failed —
 *    up to 6 retries, then email alerts, then the URL gets auto-disabled
 *    after 10 consecutive failures. Getting this response text wrong
 *    silently breaks the whole integration over time, not immediately.
 * ---------------------------------------------------------------------- */
app.post('/webhooks/dropbox-sign', multipartParser.none(), async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body?.json || '{}');
  } catch {
    return res.status(400).send('bad payload'); // malformed — safe to reject outright, not a valid Dropbox Sign request
  }

  const { event_time, event_type, event_hash } = payload.event || {};
  const valid = verifyDropboxSignEventHash(event_time, event_type, event_hash);
  if (!valid) return res.status(401).send('invalid signature');

  // Required handshake when the callback URL is first registered/tested.
  if (event_type === 'callback_test') {
    return res.status(200).send('Hello API Event Received');
  }

  try {
    if (event_type === 'signature_request_all_signed') {
      const sigReqId = payload.signature_request?.signature_request_id;
      const contract = [...db.contracts.values()].find(c => c.w8ben_signature_request_id === sigReqId);
      if (contract) {
        contract.w8ben_status = 'signed';
        await saveState();
      } else {
        console.warn(`[dropbox-sign webhook] signature_request_all_signed for unknown request ${sigReqId}`);
      }
    } else if (event_type === 'signature_request_declined') {
      const sigReqId = payload.signature_request?.signature_request_id;
      const contract = [...db.contracts.values()].find(c => c.w8ben_signature_request_id === sigReqId);
      if (contract) {
        contract.w8ben_status = 'declined';
        await saveState();
      }
    }
  } catch (err) {
    // Never let our own processing bug turn into a retry storm that
    // eventually gets Dropbox Sign to disable the whole callback URL —
    // log it, still acknowledge receipt.
    console.warn('[dropbox-sign webhook] processing error:', err.message);
  }

  // ALWAYS this exact string — required by Dropbox Sign regardless of
  // which event type was processed.
  res.status(200).send('Hello API Event Received');
});

const PORT = process.env.PORT || 3000;
await loadState(); // restore prior state (if persistence is configured) BEFORE accepting traffic
app.listen(PORT, () => console.log(`FetchTalos API listening on :${PORT}`));

