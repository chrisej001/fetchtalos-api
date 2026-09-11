import { useEffect, useState } from 'react';
import { useHub } from '../HubContext.jsx';

export default function Settings() {
  const { api, showToast } = useHub();

  const [keyStatus, setKeyStatus] = useState('// connect to load');
  const [hasKey, setHasKey] = useState(false);
  const [reveal, setReveal] = useState(null); // { message, api_key }

  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState(null);
  const [webhookResult, setWebhookResult] = useState('');

  async function loadKeyStatus() {
    try {
      const data = await api('/v1/hub/api-key');
      setHasKey(data.has_key);
      setKeyStatus(data.has_key ? `You have a key: ${data.key_preview}` : "You haven't generated a key yet.");
    } catch (err) {
      setHasKey(false);
      setKeyStatus("You haven't generated a key yet.");
    }
  }

  async function loadWebhook() {
    try {
      const data = await api('/v1/hub/webhook');
      setWebhookUrl(data.webhook_url || '');
      setWebhookSecret(data.webhook_secret || null);
    } catch (err) { /* no webhook set yet — leave the form blank */ }
  }

  useEffect(() => { loadKeyStatus(); loadWebhook(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function generateKey() {
    if (hasKey && !confirm('Regenerating invalidates your current key immediately — anything using the old one will break until updated. Continue?')) return;
    try {
      const data = await api('/v1/hub/api-key/generate', { method: 'POST' });
      setReveal({ message: data.message, api_key: data.api_key });
      showToast('Key generated — copy it now');
      loadKeyStatus();
    } catch (err) {
      showToast('Failed to generate key: ' + err.message, true);
    }
  }

  async function saveWebhook() {
    try {
      const data = await api('/v1/hub/webhook', { method: 'PATCH', body: JSON.stringify({ webhook_url: webhookUrl.trim() }) });
      setWebhookSecret(data.webhook_secret || null);
      setWebhookResult(data.webhook_secret ? '' : 'Webhook cleared');
      showToast(webhookUrl.trim() ? 'Webhook saved' : 'Webhook cleared');
    } catch (err) {
      showToast('Failed: ' + err.message, true);
    }
  }

  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Settings</h2>
        <p className="sub">Your API key and webhook — for building against FetchTalos from your own systems. Not needed to use this dashboard, which you're already logged into by email.</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15 }}>API key</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '8px 0 14px' }}>
          Use this in your own backend to call the FetchTalos API directly — <code>Authorization: Bearer &lt;key&gt;</code>. It's shown in full only once, right after you generate or regenerate it.
        </p>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{keyStatus}</div>
        <button className="btn-primary" style={{ marginTop: 12 }} onClick={generateKey}>{hasKey ? 'Regenerate API key' : 'Generate API key'}</button>
        {reveal && (
          <div className="key-reveal">
            <div style={{ fontSize: '11.5px', color: 'var(--text-faint)', marginBottom: 6 }}>{reveal.message}</div>
            <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>{reveal.api_key}</div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ fontSize: 15 }}>Webhook</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '8px 0 14px' }}>
          Get real-time <code>POST</code> notifications to your own endpoint — e.g. <code>payment.settled</code> whenever a talent under your pipeline gets paid. Each request is signed with your signing secret via an <code>X-FetchTalos-Signature</code> header (HMAC-SHA256 over the raw body), the same way FetchTalos itself verifies Felicity's webhooks.
        </p>
        <div className="field" style={{ maxWidth: 420 }}><label>Your endpoint URL</label><input placeholder="https://yourapp.com/webhooks/fetchtalos" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} /></div>
        <button className="btn-primary" onClick={saveWebhook}>Save webhook URL</button>
        <div style={{ marginTop: 12 }}>
          {webhookSecret && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Signing secret: <span className="mono">{webhookSecret}</span></div>}
          {webhookResult && <span style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>{webhookResult}</span>}
        </div>
      </div>
    </section>
  );
}
