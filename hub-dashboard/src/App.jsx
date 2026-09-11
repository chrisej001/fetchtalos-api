import { useState } from 'react';
import { useHub } from './HubContext.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import Overview from './components/Overview.jsx';
import Talents from './components/Talents.jsx';
import MarkupSettlement from './components/MarkupSettlement.jsx';
import Settings from './components/Settings.jsx';
import Plans from './components/Plans.jsx';
import Simulate from './components/Simulate.jsx';

const TABS = [
  ['overview', 'Overview', Overview],
  ['talents', 'My Talents', Talents],
  ['markup', 'Markup & Settlement', MarkupSettlement],
  ['settings', 'Settings', Settings],
  ['plans', 'Plans', Plans],
  ['simulate', 'Simulate an Enterprise', Simulate],
];

export default function App() {
  const { connected, connecting, hubAccount, logout } = useHub();
  const [tab, setTab] = useState('overview');

  return (
    <>
      <div className="topbar">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18 }}>
          <svg viewBox="0 0 22 22" fill="none" width="21" height="21">
            <circle cx="4" cy="11" r="3" stroke="#2fe6c6" strokeWidth="1.6" />
            <circle cx="18" cy="11" r="3" stroke="#ff8a4c" strokeWidth="1.6" />
            <line x1="7" y1="11" x2="15" y2="11" stroke="#97a1b0" strokeWidth="1.6" strokeDasharray="1.5 2" />
          </svg>
          FetchTalos <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: 'var(--text-faint)', fontWeight: 500, border: '1px solid var(--border)', borderRadius: 100, padding: '2px 8px', marginLeft: 2 }}>HUB</span>
        </h1>
        {connected && (
          <div className="conn">
            <span><span className="status-dot on" /> <span>{hubAccount?.hub_scope}</span></span>
            <button className="row-btn" onClick={logout}>Log out</button>
          </div>
        )}
      </div>

      {connecting ? null : !connected ? (
        <AuthScreen />
      ) : (
        <div className="layout">
          <div className="tabbar">
            {TABS.map(([key, label]) => (
              <button key={key} className={'tabbtn' + (tab === key ? ' active' : '')} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <main>
            {TABS.map(([key, , Component]) => key === tab && <Component key={key} />)}
          </main>
        </div>
      )}
    </>
  );
}
