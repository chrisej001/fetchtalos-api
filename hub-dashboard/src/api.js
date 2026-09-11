// Same-origin — this app is served off the same Express server it talks
// to, so no base-URL configuration is needed for the normal flow.
export const BASE_URL = location.origin;

export class ApiError extends Error {
  constructor(message, data) {
    super(message);
    this.data = data;
  }
}

// credential is whatever's currently authenticating the session — a real
// ft_live_ key (advanced/manual connect) or an ft_session_ token (the
// normal magic-link login path). Never assume it's a usable API key for
// anything beyond authenticating requests — see Settings for the real key.
export async function apiCall(credential, path, opts = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential },
    opts.headers || {}
  );
  const res = await fetch(BASE_URL + path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.message || data.error || `HTTP ${res.status}`, data);
  }
  return data;
}
