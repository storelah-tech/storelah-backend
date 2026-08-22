// StoreLah CMS admin UI — API layer. The ONLY module that talks to the backend.
// Extracted from admin.js (phase-1 layering refactor; nodebestpractices #1).
// Holds the JWT in private module state; every call goes through request() so
// auth headers, envelope parsing ({data, meta}) and error shaping stay uniform.

const API = '/api/v1/cms';
let token = null;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------- auth (mirrors frozen data-layer.js; never prints credentials) ----------

async function getCreds() {
  const res = await fetch(`${API}/config`);
  if (!res.ok) throw new Error('admin credentials not configured (set STORELAH_ADMIN_*)');
  return res.json();
}

export async function login() {
  const CREDS = await getCreds();
  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDS),
  });
  if (!res.ok) throw new Error('login failed');
  const body = await res.json();
  token = body.data.token;
}

// ---------- http ----------

export async function request(path, opts = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  Object.assign(headers, opts.headers);
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...opts, headers });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'Network error — is the backend up?');
  }
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    /* non-JSON body */
  }
  if (!res.ok) {
    const e = body && body.error;
    // Envelope shape: { error: { code, message, details? } }
    if (e && typeof e === 'object' && e.message) {
      throw new ApiError(res.status, e.code || 'ERROR', e.message, e.details);
    }
    // Plain shape (requireAuth 401): { error: "Unauthorized" }
    if (e && typeof e === 'string') {
      throw new ApiError(res.status, 'UNAUTHORIZED', e);
    }
    throw new ApiError(res.status, 'HTTP', `Request failed (${res.status})`);
  }
  return body;
}

export const get = (p) => request(p).then((b) => b.data);

// Shape any thrown error into a user-facing message. Lives beside ApiError
// because it pattern-matches on that class first, then falls back generically.
export function describeError(err) {
  if (err instanceof ApiError) {
    if (err.details && err.details.fieldErrors) {
      const msgs = [];
      for (const [field, list] of Object.entries(err.details.fieldErrors)) {
        if (list && list.length) msgs.push(`${field}: ${list.join('; ')}`);
      }
      if (msgs.length) return msgs.join(' · ');
    }
    return err.message || `Request failed (${err.status})`;
  }
  return err && err.message ? err.message : String(err);
}
