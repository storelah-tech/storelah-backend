// StoreLah CMS admin UI — API layer. The ONLY module that talks to the backend.
// Extracted from admin.js (phase-1 layering refactor; nodebestpractices #1).
// Holds the JWT in private module state; every call goes through request() so
// auth headers, envelope parsing ({data, meta}) and error shaping stay uniform.

const API = '/api/v1/cms';
// Operator session (CMS RBAC). The JWT survives reloads in localStorage; the
// legacy /dashboard.html data layer reads the same key.
const TOKEN_KEY = 'storelah.cms.token';
let token = readToken();
let currentUser = null;
let me = null; // GET /me: { user, role, isOwner, permissions, branchIds }
let onAuthLost = null;

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}
function writeToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* storage blocked: session lasts for this page only */ }
}

// Auth-readiness gate: request() must never emit `Authorization: Bearer null`.
// wireEvents() registers nav/click handlers synchronously while sign-in is
// still pending, so any bind* triggered before then waits here instead of
// firing blind: once the operator signs in the call proceeds with the fresh
// token. A 401 mid-session re-arms the gate (see request()).
let authResolve;
let authSettled;
function armAuthGate() {
  authSettled = new Promise((resolve) => { authResolve = resolve; });
}
armAuthGate();

export function getCurrentUser() {
  return currentUser;
}

export function getMe() {
  return me;
}

export function isAuthed() {
  return !!token;
}

/** Called with the server message whenever the session ends (401). */
export function setAuthLostHandler(fn) {
  onAuthLost = fn;
}

async function fetchMe() {
  const res = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return (await res.json()).data;
}

function settle(data) {
  me = data;
  currentUser = { email: data.user.email, name: data.user.name, role: data.role.key, roleName: data.role.name };
  authResolve();
}

/** Resumes a stored session. Resolves true when it is still valid. */
export async function restoreSession() {
  if (!token) return false;
  let data = null;
  try { data = await fetchMe(); } catch (e) { return false; }
  if (!data) { writeToken(null); return false; }
  settle(data);
  return true;
}

/** Signs in; throws ApiError with the server's message on failure. */
export async function signIn(email, password) {
  let res;
  try {
    res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'Network error — is the backend up?');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body && body.error;
    throw new ApiError(res.status, (e && e.code) || 'HTTP', (e && e.message) || `Sign-in failed (${res.status})`, e && e.details);
  }
  writeToken(body.data.token);
  const data = await fetchMe();
  if (!data) throw new ApiError(401, 'UNAUTHORIZED', 'Sign-in failed. Try again.');
  settle(data);
}

export function signOut() {
  writeToken(null);
  me = null;
  currentUser = null;
  armAuthGate();
}

// Public (no session) calls for the sign-in screen. Raw fetch, never
// request(): they must not wait on the auth gate.
async function publicCall(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'Network error — is the backend up?');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json && json.error;
    throw new ApiError(res.status, (e && e.code) || 'HTTP', (e && e.message) || `Request failed (${res.status})`, e && e.details);
  }
  return json.data;
}

/** Forgot password: emails a reset link if the account exists (same reply either way). */
export function requestReset(email) {
  return publicCall('POST', '/auth/forgot', { email });
}

/** What an invite / reset link is for: { kind, email, name, expiresAt }. */
export function inspectAuthLink(token) {
  return publicCall('GET', `/auth/token?token=${encodeURIComponent(token)}`);
}

/** Sets a password from an invite / reset link and signs in. */
export async function redeemAuthLink(token, password) {
  const data = await publicCall('POST', '/auth/token', { token, password });
  writeToken(data.token);
  const meData = await fetchMe();
  if (!meData) throw new ApiError(401, 'UNAUTHORIZED', 'Password saved. Sign in to continue.');
  settle(meData);
}

/** Ends every session of the signed-in operator, this one included. */
export async function signOutAll() {
  await post('/me/sign-out-all', {});
  signOut();
}

/** Changes the signed-in operator's password and keeps this session. */
export async function changePassword(currentPassword, newPassword) {
  const data = await post('/me/password', { currentPassword, newPassword });
  writeToken(data.token);
}

/** True when the signed-in operator holds `perm` (`resource:action`). */
export function can(perm) {
  if (!me) return false;
  return me.isOwner || me.permissions.includes(perm);
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------- http ----------

export async function request(path, opts = {}) {
  if (!token || !me) await authSettled;
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
    // Session ended (expired, password changed, account removed): drop the
    // token, re-arm the gate and let the app show the sign-in screen.
    if (res.status === 401 && token) {
      signOut();
      if (onAuthLost) onAuthLost((e && e.message) || 'Sign in again to continue.');
    }
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

export function post(p, body) {
  return request(p, { method: 'POST', body: JSON.stringify(body) }).then((b) => b.data);
}

export function put(p, body) {
  return request(p, { method: 'PUT', body: JSON.stringify(body) }).then((b) => b.data);
}

export function patch(p, body) {
  return request(p, { method: 'PATCH', body: JSON.stringify(body) }).then((b) => b.data);
}

export function del(p) {
  return request(p, { method: 'DELETE' }).then((b) => b.data);
}

// Binary file download (PDF quotations). Same auth gate + envelope-free:
// fetches with the Bearer token, throws ApiError on HTTP failure, otherwise
// triggers a browser download of the blob. Additive — JSON paths untouched.
export async function downloadFile(path, filename) {
  if (!token || !me) await authSettled;
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'Network error — is the backend up?');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) message = body.error.message;
    } catch (e) { /* non-JSON error body */ }
    throw new ApiError(res.status, 'HTTP', message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

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
