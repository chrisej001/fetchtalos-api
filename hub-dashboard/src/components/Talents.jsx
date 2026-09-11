import { useEffect, useState } from 'react';
import { useHub } from '../HubContext.jsx';

export default function Talents() {
  const { api, showToast } = useHub();
  const [talents, setTalents] = useState(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('NG');
  const [score, setScore] = useState('');
  const [stack, setStack] = useState('');
  const [addResult, setAddResult] = useState('');

  const [bulk, setBulk] = useState('');
  const [bulkResult, setBulkResult] = useState('');

  async function load() {
    try {
      const data = await api('/v1/talents/roster');
      setTalents(data.results);
    } catch (err) {
      showToast('Failed to load roster: ' + err.message, true);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function deleteTalent(talentId, tName) {
    if (!confirm(`Delete ${tName} from your roster? This can't be undone. (Blocked automatically if they have a pending or active contract — the enterprise needs to release it first.)`)) return;
    try {
      await api('/v1/talents/' + talentId, { method: 'DELETE' });
      showToast(tName + ' deleted');
      load();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, true);
    }
  }

  async function addTalent() {
    const n = name.trim(), e = email.trim();
    if (!n || !e) { showToast('Name and email are required', true); return; }
    const stackArr = stack.split(',').map(s => s.trim()).filter(Boolean);
    try {
      const result = await api('/v1/talents/upload', {
        method: 'POST',
        body: JSON.stringify({ talents: [{ name: n, email: e, country: country.trim() || 'NG', vetted_score: parseInt(score) || undefined, stack: stackArr }] }),
      });
      const r = result.results[0];
      if (r.error) { showToast('Failed: ' + r.message, true); return; }
      setAddResult(`${r.action === 'created' ? 'Added' : 'Updated'}: ${r.talent.name}`);
      showToast('Talent saved');
      setName(''); setEmail(''); setScore(''); setStack('');
      load();
    } catch (err) {
      showToast('Failed: ' + err.message, true);
    }
  }

  async function bulkUpload() {
    const raw = bulk.trim();
    if (!raw) { showToast('Paste at least one talent first', true); return; }
    const talentsToUpload = raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const [n, e, c, sc, stackStr] = line.split(',').map(p => p.trim());
      return { name: n, email: e, country: c || 'NG', vetted_score: sc ? parseInt(sc) : undefined, stack: stackStr ? stackStr.split('|').map(s => s.trim()).filter(Boolean) : [] };
    }).filter(t => t.name && t.email);

    if (!talentsToUpload.length) { showToast('Could not parse any valid rows (need at least name and email per line)', true); return; }

    try {
      const result = await api('/v1/talents/upload', { method: 'POST', body: JSON.stringify({ talents: talentsToUpload }) });
      const created = result.results.filter(r => r.action === 'created').length;
      const updated = result.results.filter(r => r.action === 'updated').length;
      const failed = result.results.filter(r => r.error);
      setBulkResult(
        `${created} added, ${updated} updated` +
        (failed.length ? ` — ${failed.length} failed: ` + failed.map(f => `row ${f.index + 1}: ${f.message || f.error}`).join('; ') : '')
      );
      showToast(`${created + updated} of ${talentsToUpload.length} saved`);
      if (created + updated > 0) setBulk('');
      load();
    } catch (err) {
      showToast('Bulk upload failed: ' + err.message, true);
    }
  }

  return (
    <section className="panel active">
      <div className="panel-head"><h2>My Talents</h2><p className="sub">Your own roster — upload new talent (bulk or one at a time), or edit anyone already here</p></div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, marginBottom: 14 }}>Add a talent</h3>
        <div className="form-grid">
          <div className="field"><label>Full name</label><input placeholder="e.g. Amaka Eze" value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="field"><label>Email</label><input placeholder="e.g. amaka@example.com" value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div className="field"><label>Country</label><input value={country} onChange={e => setCountry(e.target.value)} /></div>
          <div className="field"><label>Vetted score</label><input type="number" placeholder="e.g. 88" value={score} onChange={e => setScore(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1/-1' }}><label>Stack (comma separated)</label><input placeholder="e.g. React, Node, Postgres" value={stack} onChange={e => setStack(e.target.value)} /></div>
        </div>
        <button className="btn-primary" onClick={addTalent}>Add to roster</button>
        {addResult && <div style={{ marginTop: 10, color: 'var(--teal)', fontSize: '12.5px' }}>{addResult}</div>}
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Bulk upload</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: 12 }}>
          One talent per line: <code>name, email, country, vetted_score, stack1|stack2</code>. Country and score are optional (defaults to NG / 75). Re-uploading an email already in YOUR roster updates it instead of duplicating.
        </p>
        <textarea rows={6} style={{ width: '100%', fontSize: '12.5px' }}
          placeholder={'Amaka Eze, amaka@example.com, NG, 88, React|Node\nSegun Okoye, segun@example.com, NG, 82, Python|Django'}
          value={bulk} onChange={e => setBulk(e.target.value)} />
        <button className="btn-primary" style={{ marginTop: 12 }} onClick={bulkUpload}>Upload all</button>
        {bulkResult && <div style={{ marginTop: 10, fontSize: '12.5px', color: 'var(--teal)' }}>{bulkResult}</div>}
      </div>

      <button className="row-btn" style={{ marginBottom: 14 }} onClick={load}>↻ Refresh</button>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Stack</th><th>Country</th><th>Score</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {!talents || talents.length === 0
              ? <tr><td colSpan={7} className="empty-state">// {talents ? 'no talents uploaded yet' : 'connect to load'}</td></tr>
              : talents.map(t => (
                <tr key={t.talent_id}>
                  <td><strong>{t.name}</strong></td>
                  <td>{t.email}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{(t.stack || []).join(', ')}</td>
                  <td>{t.country}</td>
                  <td>{t.vetted_score}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{t.status}</td>
                  <td><button className="row-btn" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => deleteTalent(t.talent_id, t.name)}>Delete</button></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
