import { useState } from 'react';
import { useHub } from '../HubContext.jsx';

const PLATFORM_FEE_BPS = 500; // FetchTalos's own 5% — matches PLATFORM_FEE_BPS server-side

function PlanCard({ plan, expanded, onToggle }) {
  if (!plan.configured) {
    return (
      <div className="plan-card" style={{ cursor: 'default' }}>
        <h3>{plan.label}</h3>
        <p style={{ color: 'var(--text-faint)', fontSize: '12.5px' }}>Not yet available on this plan.</p>
      </div>
    );
  }
  return (
    <div className="plan-card" onClick={onToggle}>
      <h3>{plan.label}</h3>
      {plan.description && <p style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>{plan.description}</p>}
      <div className="price">
        ₦{(plan.monthly_premium_naira || 0).toLocaleString()}
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}> /{plan.premium_period || 'month'}</span>
      </div>
      {plan.key_benefits_html
        ? <div className="benefits-html" dangerouslySetInnerHTML={{ __html: plan.key_benefits_html }} />
        : <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Benefits not yet confirmed for this plan.</p>}
      {plan.full_benefits_html && (
        expanded ? (
          <div className="full-benefits" dangerouslySetInnerHTML={{ __html: plan.full_benefits_html }} />
        ) : (
          <div className="expand-hint">Click to see full coverage details →</div>
        )
      )}
    </div>
  );
}

export default function Plans() {
  const { api, showToast, plans, loadPlans, hubAccount } = useHub();
  const [expandedPlan, setExpandedPlan] = useState(null);

  const [salary, setSalary] = useState('');
  const [planKey, setPlanKey] = useState('');
  const [duration, setDuration] = useState('12');
  const [calc, setCalc] = useState(null);

  async function refresh() {
    try {
      await loadPlans();
    } catch (err) {
      showToast('Failed to load plans: ' + err.message, true);
    }
  }

  const configuredPlans = plans.filter(p => p.configured);

  async function calculate() {
    const salaryNum = parseFloat(salary);
    const months = parseInt(duration) || 12;
    if (!salaryNum || salaryNum <= 0) { showToast('Enter a valid salary', true); return; }
    if (!planKey) { showToast('Select a plan', true); return; }
    const plan = configuredPlans.find(p => p.plan === planKey);
    if (!plan) { showToast('Plan not found', true); return; }

    const hubMarkupBps = (hubAccount && hubAccount.hub_markup_bps) || 0;
    const platformFee = +(salaryNum * PLATFORM_FEE_BPS / 10000).toFixed(2);
    const hubMarkup = +(salaryNum * hubMarkupBps / 10000).toFixed(2);

    // Try a REAL live quote for this exact plan+duration first — falls
    // back to the catalog's monthly rate × months if that's unavailable.
    // Never show the raw monthly figure alone as if it covered the whole
    // duration — that was a real bug, fixed both here and server-side.
    let insurance = (plan.monthly_premium_naira || 0) * months;
    let isLiveQuote = false;
    try {
      const quote = await api(`/v1/plans/quote?plan=${planKey}&months=${months}`);
      if (quote.premium_naira != null) { insurance = quote.premium_naira; isLiveQuote = true; }
    } catch (err) { /* fall back to the catalog estimate computed above */ }

    const serviceFee = platformFee + hubMarkup;
    const renewalMonth = salaryNum + serviceFee + insurance;
    const otherMonths = salaryNum + serviceFee;
    const cycleLabel = months === 1 ? 'every month' : `every ${months} months (month 1, then month ${months + 1}, ${2 * months + 1}...)`;
    const insuranceLabel = isLiveQuote ? 'live quote' : `catalog estimate — ₦${(plan.monthly_premium_naira || 0).toLocaleString()}/mo × ${months} months`;

    setCalc({ salaryNum, serviceFee, hubMarkupBps, insurance, insuranceLabel, cycleLabel, renewalMonth, otherMonths });
  }

  return (
    <section className="panel active">
      <div className="panel-head"><h2>Plans</h2><p className="sub">GET /v1/plans — real benefits and pricing, straight from the live catalog</p></div>
      <button className="row-btn" style={{ marginBottom: 16 }} onClick={refresh}>↻ Refresh</button>

      {plans.length === 0
        ? <div className="empty-state">// connect to load</div>
        : plans.map(p => (
          <PlanCard key={p.plan} plan={p} expanded={expandedPlan === p.plan}
            onToggle={() => setExpandedPlan(expandedPlan === p.plan ? null : p.plan)} />
        ))}

      <div className="card" style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 15 }}>Estimate a total</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '6px 0 14px' }}>
          What an enterprise would actually owe — salary + FetchTalos's fee + your markup, plus insurance whenever it's due for renewal (which depends on the coverage duration chosen, not always just month one).
        </p>
        <div className="form-grid">
          <div className="field"><label>Monthly salary (₦)</label><input type="number" placeholder="e.g. 500000" value={salary} onChange={e => setSalary(e.target.value)} /></div>
          <div className="field">
            <label>Plan</label>
            <select value={planKey} onChange={e => setPlanKey(e.target.value)}>
              <option value="">Select a plan…</option>
              {configuredPlans.map(p => <option key={p.plan} value={p.plan}>{p.label} — ₦{(p.monthly_premium_naira || 0).toLocaleString()}/mo</option>)}
            </select>
          </div>
          <div className="field">
            <label>Coverage duration</label>
            <select value={duration} onChange={e => setDuration(e.target.value)}>
              <option value="1">1 month</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">12 months</option>
            </select>
          </div>
        </div>
        <button className="row-btn" onClick={calculate}>Calculate</button>
        {calc && (
          <div className="calc">
            <div className="calc-row"><span>Salary</span><span>₦{calc.salaryNum.toLocaleString()}</span></div>
            <div className="calc-row"><span>Service fee{calc.hubMarkupBps > 0 ? ` (includes your ${calc.hubMarkupBps / 100}% markup)` : ''}</span><span>₦{calc.serviceFee.toLocaleString()}</span></div>
            <div className="calc-row"><span>Insurance, {calc.insuranceLabel} (renews {calc.cycleLabel})</span><span>₦{calc.insurance.toLocaleString()}</span></div>
            <div className="calc-row total"><span>Renewal month total</span><span>₦{calc.renewalMonth.toLocaleString()}</span></div>
            <div className="calc-row total"><span>Other months</span><span>₦{calc.otherMonths.toLocaleString()}</span></div>
          </div>
        )}
      </div>
    </section>
  );
}
