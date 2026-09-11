import { useEffect, useState } from 'react';
import { useHub } from '../HubContext.jsx';

export default function Overview() {
  const { api, showToast } = useHub();
  const [stats, setStats] = useState(null);

  async function load() {
    try {
      const s = await api('/v1/hub/stats');
      setStats(s);
    } catch (err) {
      showToast('Failed to load stats: ' + err.message, true);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const cells = [
    ['TALENTS IN ROSTER', stats?.talents_in_roster],
    ['ACTIVE CONTRACTS', stats?.active_contracts],
    ['ENTERPRISES ENGAGED', stats?.enterprises_engaged],
    ['PAYMENTS SETTLED', stats?.payments_settled],
    ['TOTAL SALARY PAID (₦)', stats ? '₦' + stats.total_salary_paid_out_naira.toLocaleString() : null],
    ['YOUR MARKUP EARNED (₦)', stats ? '₦' + stats.total_markup_earned_naira.toLocaleString() : null],
  ];

  return (
    <section className="panel active">
      <div className="panel-head"><h2>Overview</h2><p className="sub">GET /v1/hub/stats — your own activity only</p></div>
      <div className="stat-strip">
        {cells.map(([label, value]) => (
          <div className="stat-cell" key={label}>
            <div className="l">{label}</div>
            <div className="v">{value ?? '—'}</div>
          </div>
        ))}
      </div>
      <button className="row-btn" style={{ marginTop: 16 }} onClick={load}>↻ Refresh</button>
    </section>
  );
}
