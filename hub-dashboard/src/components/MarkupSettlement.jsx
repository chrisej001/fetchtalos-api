import { useEffect, useState } from 'react';
import { useHub } from '../HubContext.jsx';
import { ApiError } from '../api.js';

export default function MarkupSettlement() {
  const { api, showToast, hubAccount, refreshHubAccount } = useHub();

  const [markupPct, setMarkupPct] = useState('');
  const [markupResult, setMarkupResult] = useState('');

  const [banks, setBanks] = useState(null); // null = loading, [] = unavailable (falls back to text input), [...] = real list
  const [banksConfigured, setBanksConfigured] = useState(true);
  const [bankCode, setBankCode] = useState('');
  const [acctNumber, setAcctNumber] = useState('');
  const [verifyResult, setVerifyResult] = useState(null); // { text, ok }
  const [verifiedName, setVerifiedName] = useState(null);
  const [verifiedFor, setVerifiedFor] = useState(null);
  const [settleSaveResult, setSettleSaveResult] = useState('');

  const [notifyEmail, setNotifyEmail] = useState('');
  const [notifyResult, setNotifyResult] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await api('/v1/reference/ngn-banks');
        setBanksConfigured(data.configured);
        setBanks(data.configured && data.banks.length ? data.banks : []);
      } catch (err) {
        setBanksConfigured(false);
        setBanks([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hubAccount) return;
    setMarkupPct(String((hubAccount.hub_markup_bps || 0) / 100));
    if (hubAccount.hub_settlement_account) {
      const acct = hubAccount.hub_settlement_account;
      setAcctNumber(acct.account_number || '');
      setBankCode(acct.bank_code || '');
      if (acct.account_name) {
        setVerifyResult({ text: `Currently saved: ${acct.account_name}${acct.verified ? ' ✓ verified' : ' — not verified'}`, ok: !!acct.verified });
      }
    }
    if (hubAccount.hub_notification_email) setNotifyEmail(hubAccount.hub_notification_email);
  }, [hubAccount]);

  function invalidateVerification() {
    setVerifiedName(null);
    setVerifiedFor(null);
    setVerifyResult(null);
  }

  async function saveMarkup() {
    const pct = parseFloat(markupPct);
    if (isNaN(pct) || pct < 0) { showToast('Enter a valid percentage', true); return; }
    try {
      const result = await api('/v1/hub/markup', { method: 'PATCH', body: JSON.stringify({ markup_bps: Math.round(pct * 100) }) });
      setMarkupResult(`Saved: ${result.hub_markup_bps / 100}%`);
      showToast('Markup updated');
      refreshHubAccount();
    } catch (err) {
      showToast('Failed: ' + err.message, true);
    }
  }

  async function verifyAccount() {
    const account_number = acctNumber.trim();
    const bank_code = bankCode.trim();
    if (!account_number || !bank_code) { showToast('Select a bank and enter an account number', true); return; }
    try {
      const result = await api('/v1/hub/settlement-account/resolve', { method: 'POST', body: JSON.stringify({ account_number, bank_code }) });
      setVerifiedName(result.account_name);
      setVerifiedFor(bank_code + ':' + account_number);
      setVerifyResult({ text: `✓ Resolved: ${result.account_name}`, ok: true });
    } catch (err) {
      if (err instanceof ApiError && err.data?.error === 'felicity_ngn_not_configured') {
        const manualName = prompt('Live verification isn\'t available here (Felicity not configured). Enter the account name manually — it will be saved as unverified:');
        if (manualName) {
          setVerifiedName(manualName.trim());
          setVerifiedFor(bank_code + ':' + account_number);
          setVerifyResult({ text: `${manualName.trim()} — not verified (manual entry)`, ok: false });
        }
        return;
      }
      setVerifyResult({ text: 'Could not verify: ' + err.message, ok: false });
      showToast('Verification failed: ' + err.message, true);
    }
  }

  async function saveSettlement() {
    const account_number = acctNumber.trim();
    const bank_code = bankCode.trim();
    if (!verifiedName || verifiedFor !== bank_code + ':' + account_number) {
      showToast('Verify the account first', true);
      return;
    }
    try {
      await api('/v1/hub/settlement-account', { method: 'PATCH', body: JSON.stringify({ account_number, bank_code, account_name: verifiedName }) });
      setSettleSaveResult('Saved');
      showToast('Settlement account updated');
      refreshHubAccount();
    } catch (err) {
      showToast('Failed: ' + err.message, true);
    }
  }

  async function saveNotifyEmail() {
    const email = notifyEmail.trim();
    if (!email || !email.includes('@')) { showToast('Enter a valid email', true); return; }
    try {
      await api('/v1/hub/notification-email', { method: 'PATCH', body: JSON.stringify({ email }) });
      setNotifyResult('Saved');
      showToast('Notification email updated');
      refreshHubAccount();
    } catch (err) {
      showToast('Failed: ' + err.message, true);
    }
  }

  const canSave = verifiedName && verifiedFor === bankCode + ':' + acctNumber;

  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Markup &amp; Settlement Account</h2>
        <p className="sub">Your white-label revenue share on top of FetchTalos's own platform fee, paid to your own account every time a talent under your pipeline gets paid</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15 }}>Your markup rate</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '8px 0 16px' }}>
          Ceiling set by FetchTalos: <b>{hubAccount ? (hubAccount.hub_markup_cap_bps / 100) + '%' : '—'}</b>. You can set your own rate anywhere up to that.
        </p>
        <div className="field" style={{ maxWidth: 240 }}><label>Your rate (%)</label><input type="number" step="0.1" placeholder="e.g. 3.5" value={markupPct} onChange={e => setMarkupPct(e.target.value)} /></div>
        <button className="btn-primary" onClick={saveMarkup}>Save rate</button>
        {markupResult && <div style={{ marginTop: 10, color: 'var(--teal)', fontSize: '12.5px' }}>{markupResult}</div>}
      </div>

      <div className="card">
        <h3 style={{ fontSize: 15 }}>Where your markup gets paid</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '8px 0 14px' }}>
          Pick your bank from the live list, enter your account number, then verify it — we'll resolve the real account name from the bank itself before you save, so this can never be saved under the wrong name.
        </p>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field">
            <label>Bank</label>
            {banks === null ? (
              <select disabled><option>Loading banks…</option></select>
            ) : banks.length ? (
              <select value={bankCode} onChange={e => { setBankCode(e.target.value); invalidateVerification(); }}>
                <option value="">Select your bank…</option>
                {banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
              </select>
            ) : (
              <input placeholder={`Bank code (e.g. 058) — live bank list ${banksConfigured ? 'failed to load' : 'not available here'}`}
                value={bankCode} onChange={e => { setBankCode(e.target.value); invalidateVerification(); }} />
            )}
          </div>
          <div className="field"><label>Account number</label>
            <input maxLength={10} value={acctNumber} onChange={e => { setAcctNumber(e.target.value); invalidateVerification(); }} />
          </div>
        </div>
        <button className="row-btn" onClick={verifyAccount}>Verify account</button>
        {verifyResult && <div style={{ marginTop: 10, fontSize: 13, color: verifyResult.ok ? 'var(--teal)' : 'var(--red)' }}>{verifyResult.text}</div>}
        <button className="btn-primary" style={{ marginTop: 14 }} disabled={!canSave} onClick={saveSettlement}>Save settlement account</button>
        {settleSaveResult && <div style={{ marginTop: 10, color: 'var(--teal)', fontSize: '12.5px' }}>{settleSaveResult}</div>}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 15 }}>Payment notifications</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '8px 0 16px' }}>
          Every time a talent under your pipeline gets paid, we'll email this address how much they received and how much of your markup was settled to you. Without this set, you won't be notified at all.
        </p>
        <div className="field" style={{ maxWidth: 340 }}><label>Notification email</label><input type="email" placeholder="e.g. team@yourhub.com" value={notifyEmail} onChange={e => setNotifyEmail(e.target.value)} /></div>
        <button className="btn-primary" onClick={saveNotifyEmail}>Save notification email</button>
        {notifyResult && <div style={{ marginTop: 10, color: 'var(--teal)', fontSize: '12.5px' }}>{notifyResult}</div>}
      </div>
    </section>
  );
}
