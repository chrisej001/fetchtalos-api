import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiCall, ApiError } from './api.js';

const HubContext = createContext(null);

export function useHub() {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useHub must be used within HubProvider');
  return ctx;
}

const STORAGE_CREDENTIAL = 'fetchtalos_hub_credential';

export function HubProvider({ children }) {
  const [credential, setCredential] = useState('');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true); // true until the initial magic-link/localStorage check finishes
  const [hubAccount, setHubAccount] = useState(null);
  const [plans, setPlans] = useState([]);
  const [toast, setToast] = useState(null); // { msg, err }
  const toastTimer = useRef(null);

  const showToast = useCallback((msg, isErr) => {
    setToast({ msg, err: !!isErr });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // Bound fetch helper every component uses — always sends whatever
  // credential is currently authenticating this session.
  const api = useCallback(
    (path, opts) => apiCall(credential, path, opts),
    [credential]
  );

  const loadPlans = useCallback(async (cred) => {
    try {
      const data = await apiCall(cred || credential, '/v1/plans');
      setPlans(data.plans || []);
      return data.plans || [];
    } catch (err) {
      return [];
    }
  }, [credential]);

  const connectWithKey = useCallback(async (cred, opts = {}) => {
    try {
      const account = await apiCall(cred, '/v1/hub/account');
      setCredential(cred);
      setHubAccount(account);
      setConnected(true);
      if (!opts.skipPersist) {
        try { localStorage.setItem(STORAGE_CREDENTIAL, cred); } catch (e) {}
      }
      loadPlans(cred);
      return true;
    } catch (err) {
      setConnected(false);
      const hubOnlyHint = err instanceof ApiError && err.data?.error === 'hub_only'
        ? ' (this dashboard is for hub-type accounts only)' : '';
      showToast('Connect failed: ' + err.message + hubOnlyHint, true);
      return false;
    }
  }, [loadPlans, showToast]);

  const logout = useCallback(() => {
    try { localStorage.removeItem(STORAGE_CREDENTIAL); } catch (e) {}
    setCredential('');
    setConnected(false);
    setHubAccount(null);
    setPlans([]);
    showToast('Logged out');
  }, [showToast]);

  const refreshHubAccount = useCallback(async () => {
    try {
      const account = await apiCall(credential, '/v1/hub/account');
      setHubAccount(account);
      return account;
    } catch (err) {
      return null;
    }
  }, [credential]);

  // On mount: a magic-link token in the URL wins over any saved session;
  // otherwise restore a previously connected credential so a refresh
  // doesn't force re-login.
  useEffect(() => {
    (async () => {
      const magic = new URLSearchParams(location.search).get('magic');
      if (magic) {
        history.replaceState({}, '', location.pathname);
        try {
          const res = await fetch(location.origin + '/v1/hub/magic/' + encodeURIComponent(magic));
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showToast(data.message || 'That login link is invalid or expired — request a new one', true);
          } else if (data.status === 'pending') {
            showToast(data.message || 'Your account is still pending approval', true);
          } else {
            await connectWithKey(data.session_token);
          }
        } catch (err) {
          showToast('Login link failed: ' + err.message, true);
        }
        setConnecting(false);
        return;
      }
      let saved;
      try { saved = localStorage.getItem(STORAGE_CREDENTIAL); } catch (e) {}
      if (saved) await connectWithKey(saved, { skipPersist: true });
      setConnecting(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const value = {
    credential, connected, connecting, hubAccount, plans,
    api, connectWithKey, logout, showToast, refreshHubAccount, loadPlans,
    setHubAccount,
  };

  return (
    <HubContext.Provider value={value}>
      {children}
      {toast && <div className={'toast show' + (toast.err ? ' err' : '')}>{toast.msg}</div>}
    </HubContext.Provider>
  );
}
