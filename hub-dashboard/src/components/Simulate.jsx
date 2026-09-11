import { useEffect, useState } from 'react';
import { useHub } from '../HubContext.jsx';
import { BASE_URL } from '../api.js';

function PlanDetails({ plan }) {
  if (!plan) return null;
  return (
    <div className="card" style={{ padding: '14px 16px', margin: '-4px 0 16px' }}>
      {plan.description && <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: 8 }}>{plan.description}</div>}
      <div style={{ color: 'var(--teal)', fontSize: 16, fontFamily: "'Bricolage Grotesque',sans-serif", marginBottom: 6 }}>
        ₦{(plan.monthly_premium_naira || 0).toLocaleString()} /{plan.premium_period || 'month'}
      </div>
      {plan.key_benefits_html
        ? <div className="benefits-html" dangerouslySetInnerHTML={{ __html: plan.key_benefits_html }} />
        : <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Benefits not yet confirmed for this plan.</div>}
    </div>
  );
}

function EngageTab({ plans }) {
  const { api, showToast } = useHub();
  const [talents, setTalents] = useState([]);
  const [talentId, setTalentId] = useState('');
  const [employer, setEmployer] = useState('Acme Corp');
  const [employerEmail, setEmployerEmail] = useState('');
  const [role, setRole] = useState('Backend Engineer');
  const [planKey, setPlanKey] = useState('');
  const [duration, setDuration] = useState('12');
  const [salary, setSalary] = useState('');
  const [interviewLink, setInterviewLink] = useState('https://calendly.com/example/interview');
  const [kpis, setKpis] = useState('');
  const [result, setResult] = useState('');

  useEffect(() => {
    api('/v1/talents/roster').then(data => setTalents(data.results)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPlan = plans.find(p => p.plan === planKey && p.configured);

  async function engage() {
    const kpisList = kpis.trim() ? kpis.trim().split('\n').map(k => k.trim()).filter(Boolean) : [];
    if (!talentId) { showToast('Select a talent', true); return; }
    if (!employer.trim() || !role.trim()) { showToast('Employer name and role are required', true); return; }
    if (!employerEmail.trim()) { showToast('Employer HR/finance contact email is required — this is who gets payment reminders', true); return; }
    if (!planKey) { showToast('Select a coverage plan', true); return; }
    const salaryNum = parseFloat(salary);
    if (!salaryNum || salaryNum <= 0) { showToast('Enter a valid salary', true); return; }
    if (!kpisList.length) { showToast('At least one KPI is required — every job comes with one', true); return; }

    try {
      const eng = await api('/v1/engagements/create', {
        method: 'POST',
        body: JSON.stringify({
          talent_id: talentId, employer_name: employer.trim(), employer_email: employerEmail.trim(), role_title: role.trim(),
          coverage_plan: planKey, employer_country: 'NG', employer_currency: 'NGN',
          coverage_months: parseInt(duration) || 12, proposed_amount: salaryNum, interview_link: interviewLink.trim(), kpis: kpisList,
        }),
      });
      setResult(`Interview invite sent — engagement ${eng.engagement_id}. Switch to the Engagements tab to continue — it's saved on the server now, refreshing this page won't lose it.`);
      showToast('Engagement created');
      // Clear the whole form, not just a couple of fields — an unchanged
      // form after clicking "send" reads as if nothing happened, even
      // though it's saved server-side (the message above says so).
      setTalentId(''); setEmployer('Acme Corp'); setEmployerEmail(''); setRole('Backend Engineer');
      setPlanKey(''); setDuration('12'); setSalary('');
      setInterviewLink('https://calendly.com/example/interview'); setKpis('');
    } catch (err) {
      showToast('Failed: ' + err.message, true);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, marginBottom: 14 }}>Engage a talent from your roster</h3>
      <div className="form-grid">
        <div className="field"><label>Talent</label>
          <select value={talentId} onChange={e => setTalentId(e.target.value)}>
            <option value="">Select a talent…</option>
            {talents.map(t => <option key={t.talent_id} value={t.talent_id}>{t.name} ({(t.stack || []).join(', ')})</option>)}
          </select>
        </div>
        <div className="field"><label>Employer / company name</label><input value={employer} onChange={e => setEmployer(e.target.value)} /></div>
        <div className="field"><label>Employer HR/finance contact email</label><input type="email" placeholder="e.g. hr@acmecorp.com" value={employerEmail} onChange={e => setEmployerEmail(e.target.value)} /></div>
        <div className="field"><label>Role title</label><input value={role} onChange={e => setRole(e.target.value)} /></div>
        <div className="field"><label>Coverage plan</label>
          <select value={planKey} onChange={e => setPlanKey(e.target.value)}>
            <option value="">Select a plan…</option>
            {plans.filter(p => p.configured).map(p => <option key={p.plan} value={p.plan}>{p.label} — ₦{(p.monthly_premium_naira || 0).toLocaleString()}/mo</option>)}
          </select>
        </div>
        <div className="field"><label>Coverage duration (renewal cycle)</label>
          <select value={duration} onChange={e => setDuration(e.target.value)}>
            <option value="1">1 month — insurance renews every payment</option>
            <option value="3">3 months — renews every 3rd payment</option>
            <option value="6">6 months — renews every 6th payment</option>
            <option value="12">12 months — renews on the 13th payment (year 2)</option>
          </select>
        </div>
        <div className="field"><label>Monthly salary (₦)</label><input type="number" placeholder="e.g. 500000" value={salary} onChange={e => setSalary(e.target.value)} /></div>
        <div className="field"><label>Interview link</label><input value={interviewLink} onChange={e => setInterviewLink(e.target.value)} /></div>
      </div>
      <div className="field"><label>KPIs (required, one per line)</label>
        <textarea rows={3} style={{ width: '100%' }} placeholder={'Ship the payments redesign by Q1\nMaintain 99.9% uptime'} value={kpis} onChange={e => setKpis(e.target.value)} />
      </div>
      <PlanDetails plan={selectedPlan} />
      <button className="btn-primary" onClick={engage}>Send interview invite</button>
      {result && <div style={{ marginTop: 12, color: 'var(--teal)', fontSize: '12.5px' }}>{result}</div>}
    </div>
  );
}

function EngagementsTab() {
  const { api, showToast } = useHub();
  const [engagements, setEngagements] = useState(null);

  async function load() {
    try {
      const data = await api('/v1/engagements');
      setEngagements(data.results.slice().reverse());
    } catch (err) {
      showToast('Failed to load engagements: ' + err.message, true);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function acceptInterview(engagementId, token) {
    try {
      await fetch(`${BASE_URL}/v1/engagements/${engagementId}/accept?token=${token}`);
      showToast('Interview accepted (simulated as the talent)');
      load();
    } catch (err) { showToast('Failed: ' + err.message, true); }
  }

  async function sendContract(engagementId) {
    try {
      await api(`/v1/engagements/${engagementId}/contract`, { method: 'POST' });
      showToast('Contract sent to talent');
      load();
    } catch (err) { showToast('Failed to send contract: ' + err.message, true); }
  }

  return (
    <div>
      <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: 14 }}>
        GET /v1/engagements — every engagement you've sent, real and persisted. Refreshing the page never loses this; it's not held in browser memory.
      </p>
      <button className="row-btn" style={{ marginBottom: 14 }} onClick={load}>↻ Refresh</button>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Talent</th><th>Interview link</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {!engagements || engagements.length === 0
              ? <tr><td colSpan={4} className="empty-state">// {engagements ? 'no engagements yet — start from the Engage tab' : 'connect to load'}</td></tr>
              : engagements.map(e => (
                <tr key={e.engagement_id}>
                  <td>{e.talent_name}</td>
                  <td><a href={e.interview_link} target="_blank" rel="noreferrer" style={{ color: 'var(--teal)', fontSize: 11 }}>{e.interview_link.slice(0, 40)}...</a></td>
                  <td><span className={'status-pill status-' + e.status}>{e.status}</span></td>
                  <td>
                    {e.status === 'interview_invited' && <button className="btn-teal" onClick={() => acceptInterview(e.engagement_id, e.accept_token)}>Simulate: talent accepts interview</button>}
                    {e.status === 'interview_accepted' && <button className="btn-teal" onClick={() => sendContract(e.engagement_id)}>Send Contract</button>}
                    {e.status !== 'interview_invited' && e.status !== 'interview_accepted' && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>-</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContractsTab() {
  const { api, showToast } = useHub();
  const [contracts, setContracts] = useState(null);
  const [breakdowns, setBreakdowns] = useState({});

  async function load() {
    try {
      const data = await api('/v1/contracts');
      const rows = data.results.slice().reverse();
      setContracts(rows);

      const active = rows.filter(c => c.status === 'active' && c.ngn_status === 'onboarded');
      const entries = await Promise.all(active.map(c =>
        api(`/v1/contracts/${c.contract_id}/amount-due`).then(b => [c.contract_id, b]).catch(() => [c.contract_id, null])
      ));
      setBreakdowns(Object.fromEntries(entries));
    } catch (err) {
      showToast('Failed to load contracts: ' + err.message, true);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function simDeposit(contractId, totalAmount) {
    try {
      await api(`/v1/contracts/${contractId}/simulate-deposit`, { method: 'POST', body: JSON.stringify({ amount_naira: totalAmount }) });
      showToast('Simulated ₦' + totalAmount.toLocaleString() + ' landing — Felicity is delivering the real webhook now, refreshing shortly');
      setTimeout(load, 4000);
    } catch (err) { showToast('Simulate deposit failed: ' + err.message, true); }
  }

  async function release(contractId, talentName) {
    if (!confirm(`Release ${talentName}? This ends the contract and makes them available to hire again.`)) return;
    try {
      await api(`/v1/contracts/${contractId}/release`, { method: 'POST' });
      showToast(talentName + ' released — available again');
      load();
    } catch (err) { showToast('Failed to release: ' + err.message, true); }
  }

  return (
    <div>
      <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: 14 }}>
        GET /v1/contracts — same idea. Once a talent accepts a contract, the full amount due and where to send it show up here directly — no need to click anything to see it. "Simulate: transfer received" is a testing tool for what happens AFTER a real bank transfer lands, not how you'd see the payment details.
      </p>
      <button className="row-btn" style={{ marginBottom: 14 }} onClick={load}>↻ Refresh</button>

      {!contracts || contracts.length === 0
        ? <div className="empty-state">// {contracts ? 'no contracts yet — send one from the Engagements tab' : 'connect to load'}</div>
        : contracts.map(c => {
          let body = null;
          if (c.status === 'pending_talent_signature') {
            body = <button className="btn-teal" onClick={() => window.open(`${BASE_URL}/v1/contracts/${c.contract_id}/accept?token=${c.accept_token}`, '_blank')}>Open acceptance page →</button>;
          } else if (c.status === 'released') {
            body = <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Released — no longer active.</span>;
          } else if (c.status === 'active' && c.ngn_status !== 'onboarded') {
            body = <span style={{ color: 'var(--red)', fontSize: '12.5px' }}>{c.ngn_status || 'not onboarded yet'}{c.ngn_note ? ': ' + c.ngn_note : ''}</span>;
          } else if (c.status === 'active') {
            const b = breakdowns[c.contract_id];
            body = b ? (
              <>
                {b.last_payment && (
                  <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    ✓ Period #{b.last_payment.period_number} paid — ₦{b.last_payment.total_naira.toLocaleString()}{b.last_payment.insurance_included ? ' (incl. insurance)' : ''} on {new Date(b.last_payment.paid_at).toLocaleDateString()}
                  </div>
                )}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>PAY TO{b.next_payment_due_date ? ' — NEXT DUE ' + new Date(b.next_payment_due_date).toLocaleDateString().toUpperCase() : ''}</div>
                  <div className="mono" style={{ fontSize: 14, color: 'var(--purple)' }}>{c.ngn_account_number} — {c.ngn_bank_name}</div>
                </div>
                <div className="calc">
                  <div className="calc-row"><span>Salary</span><span>₦{b.salary_naira.toLocaleString()}</span></div>
                  <div className="calc-row"><span>Service fee</span><span>₦{b.service_fee_naira.toLocaleString()}</span></div>
                  <div className="calc-row"><span>Insurance{b.insurance_due_this_cycle ? (b.insurance_is_live_quote ? ' (due, live quote)' : ' (due, estimate)') : ' (not due this cycle)'}</span><span>₦{b.insurance_naira.toLocaleString()}</span></div>
                  <div className="calc-row total"><span>TOTAL TO WIRE THIS CYCLE</span><span>₦{b.total_naira.toLocaleString()}</span></div>
                </div>
                {c.coverage_status === 'active' && (
                  <div className="calc-row"><span>Health coverage</span><span style={{ color: 'var(--teal)' }}>{c.coverage_policy_id || 'active'}{c.coverage_policy_document_url ? <> — <a href={c.coverage_policy_document_url} target="_blank" rel="noreferrer" style={{ color: 'var(--amber)' }}>policy document</a></> : ' (document pending)'}</span></div>
                )}
                <div style={{ marginTop: 14 }}>
                  <button className="row-btn" title="Testing tool — simulates what happens once a real transfer lands, doesn't itself move anything real" onClick={() => simDeposit(c.contract_id, b.total_naira)}>Simulate: transfer received (test)</button>
                  <button className="row-btn" style={{ marginLeft: 8, color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => release(c.contract_id, c.talent_name)}>Release</button>
                </div>
              </>
            ) : <span style={{ color: 'var(--red)', fontSize: 12 }}>Could not load the amount due — try refreshing.</span>;
          }

          return (
            <div className="card" style={{ marginBottom: 16 }} key={c.contract_id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div><strong>{c.talent_name}</strong> <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{c.contract_id}</span></div>
                <span className={'status-pill status-' + c.status}>{c.status}</span>
              </div>
              {body}
            </div>
          );
        })}
    </div>
  );
}

export default function Simulate() {
  const { plans } = useHub();
  const [subtab, setSubtab] = useState('engage');

  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Simulate an Enterprise</h2>
        <p className="sub">Walk through exactly what an enterprise partnering with YOUR hub would experience — real API calls, under your own pipeline and markup. Doubles as your own sandbox to verify your setup once you're live.</p>
      </div>

      <div className="tabbar" style={{ flexDirection: 'row', width: 'auto', minHeight: 0, border: 'none', padding: 0, marginBottom: 20, background: 'none' }}>
        <button className={'subtabbtn' + (subtab === 'engage' ? ' active' : '')} onClick={() => setSubtab('engage')}>Engage</button>
        <button className={'subtabbtn' + (subtab === 'engagements' ? ' active' : '')} onClick={() => setSubtab('engagements')}>Engagements</button>
        <button className={'subtabbtn' + (subtab === 'contracts' ? ' active' : '')} onClick={() => setSubtab('contracts')}>Contracts</button>
      </div>

      {subtab === 'engage' && <EngageTab plans={plans} />}
      {subtab === 'engagements' && <EngagementsTab />}
      {subtab === 'contracts' && <ContractsTab />}
    </section>
  );
}
