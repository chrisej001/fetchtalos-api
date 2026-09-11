import { useState } from 'react';
import { useHub } from '../HubContext.jsx';
import { BASE_URL } from '../api.js';

export default function AuthScreen() {
  const { connectWithKey, showToast } = useHub();
  const [tab, setTab] = useState('login');

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPlaceholder, setLoginPlaceholder] = useState('you@yourhub.com');

  const [signupClientId, setSignupClientId] = useState('');
  const [signupHubScope, setSignupHubScope] = useState('');
  const [signupEmail, setSignupEmail] = useState('');

  const [advancedKey, setAdvancedKey] = useState('');

  async function sendLoginLink() {
    const email = loginEmail.trim();
    if (!email) { showToast('Enter your email', true); return; }
    try {
      await fetch(BASE_URL + '/v1/hub/login-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      setLoginEmail('');
      setLoginPlaceholder('Link sent — check your inbox');
      showToast('If that email is registered, a login link is on its way — check your inbox');
    } catch (err) {
      showToast('Something went wrong: ' + err.message, true);
    }
  }

  async function submitSignup() {
    const client_id = signupClientId.trim();
    const hub_scope = signupHubScope.trim();
    const contact_email = signupEmail.trim();
    if (!client_id || !hub_scope || !contact_email) { showToast('Fill in all three fields', true); return; }
    try {
      const res = await fetch(BASE_URL + '/v1/hub/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id, hub_scope, contact_email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Signup failed');
      showToast(`Request received for "${hub_scope}" — you'll get an email once it's approved, then log in with this email`);
      setTab('login');
      setLoginEmail(contact_email);
    } catch (err) {
      showToast('Signup failed: ' + err.message, true);
    }
  }

  async function connectAdvanced() {
    const key = advancedKey.trim();
    if (!key) { showToast('Paste your hub API key first', true); return; }
    await connectWithKey(key);
  }

  return (
    <div id="authScreen">
      <div className="auth-card">
        <h2>Hub partner access</h2>
        <p className="sub">Log in with your registered email, or claim your hub if this is your first time here.</p>

        <div className="auth-tabs">
          <button className={'auth-tab' + (tab === 'login' ? ' active' : '')} onClick={() => setTab('login')}>Log in</button>
          <button className={'auth-tab' + (tab === 'signup' ? ' active' : '')} onClick={() => setTab('signup')}>Claim your hub</button>
        </div>

        {tab === 'login' && (
          <div>
            <div className="field">
              <label>Your registered contact email</label>
              <input type="email" placeholder={loginPlaceholder} value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={sendLoginLink}>Email me a login link</button>
            <p className="auth-hint">We'll send a one-time link, valid 15 minutes — no password needed.</p>
          </div>
        )}

        {tab === 'signup' && (
          <div>
            <div className="field">
              <label>Business / hub name</label>
              <input placeholder="e.g. ALX Africa Ltd" value={signupClientId} onChange={e => setSignupClientId(e.target.value)} />
            </div>
            <div className="field">
              <label>Pipeline name</label>
              <input placeholder="e.g. ALX Africa" value={signupHubScope} onChange={e => setSignupHubScope(e.target.value)} />
            </div>
            <div className="field">
              <label>Contact email</label>
              <input type="email" placeholder="you@yourhub.com" value={signupEmail} onChange={e => setSignupEmail(e.target.value)} />
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={submitSignup}>Request a hub account</button>
            <p className="auth-hint">Reviewed manually — you'll get an email once it's approved and you can log in.</p>
          </div>
        )}

        <details className="auth-advanced">
          <summary>Advanced: connect with an existing key</summary>
          <div className="auth-advanced-fields">
            <input placeholder="Your hub API key" value={advancedKey} onChange={e => setAdvancedKey(e.target.value)} />
            <button className="btn-secondary" style={{ width: '100%' }} onClick={connectAdvanced}>Connect</button>
          </div>
        </details>
      </div>
    </div>
  );
}
