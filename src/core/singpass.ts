// Singpass Myinfo (v5) + Corppass Myinfo Business (v3) — FAPI 2.0
// relying-party flow. Both authorization servers speak the same protocol
// (PAR + PKCE + DPoP + private_key_jwt, ID token JWE(JWS)), so one engine
// serves both; `FapiProvider` picks the settings, cookie and data mapping.
//
// Corppass (Myinfo Business, company data — see docs/myinfo-business-plan.md):
//   CORPPASS_CLIENT_ID      Myinfo Business App ID (Singpass Developer Portal)
//   CORPPASS_ISSUER         https://stg-id.corppass.gov.sg (staging, default) or
//                           https://id.corppass.gov.sg (production)
//   CORPPASS_REDIRECT_URI   registered redirect (https only — no localhost)
//   CORPPASS_SCOPES         space-delimited; must include openid
//   CORPPASS_RETURN_URL     booking page the callback lands on (default {BOOKING_APP_URL}/)
//   Keys are shared: SINGPASS_PRIVATE_JWKS / /.well-known/jwks.json.
//
// Browser flow (all on the api host, so one HttpOnly cookie carries the
// per-login secrets across the Singpass round trip — no DB table needed):
//
//   GET  /api/v1/public/singpass/start?bookingRef=…
//        → PAR (client assertion + DPoP + PKCE) → 302 to Singpass authorize
//   GET  /api/v1/public/singpass/callback?code=…&state=…
//        → token (DPoP) → decrypt/verify ID token → userinfo (DPoP, ath)
//        → Verification row (method singpass-myinfo) → 302 back to booking
//   GET  /.well-known/jwks.json   (public half of SINGPASS_PRIVATE_JWKS)
//
// Singpass does NOT call us server-to-server (no webhooks): the only inbound
// traffic is the user's browser on /callback and Singpass fetching our JWKS.
//
// Config (env, never logged):
//   SINGPASS_CLIENT_ID      32-char App ID from the Singpass developer portal
//   SINGPASS_ISSUER         https://stg-id.singpass.gov.sg/fapi (staging) or
//                           https://id.singpass.gov.sg/fapi (production)
//   SINGPASS_REDIRECT_URI   must exactly match a URL registered with Singpass
//   SINGPASS_SCOPES         space-delimited; must include openid
//   SINGPASS_PRIVATE_JWKS   private JWKS JSON (scripts/singpass-generate-keys.ts)
//   SINGPASS_RETURN_URL     booking page the callback lands the user on
//                           (default {BOOKING_APP_URL}/)
import crypto from 'crypto';
import {
  compactDecrypt,
  createRemoteJWKSet,
  EncryptJWT,
  jwtDecrypt,
  jwtVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { config } from '../lib/config';
import { AppError } from '../lib/http';

export type FapiProvider = 'singpass' | 'corppass';

export const SINGPASS_COOKIE = 'sp_auth';
export const SINGPASS_COOKIE_PATH = '/api/v1/public/singpass';
export const CORPPASS_COOKIE = 'cp_auth';
export const CORPPASS_COOKIE_PATH = '/api/v1/public/corppass';

export const PROVIDER_COOKIE: Record<FapiProvider, { name: string; path: string }> = {
  singpass: { name: SINGPASS_COOKIE, path: SINGPASS_COOKIE_PATH },
  corppass: { name: CORPPASS_COOKIE, path: CORPPASS_COOKIE_PATH },
};
// Users get up to 10 minutes on the Singpass side; allow a little slack.
export const SINGPASS_SESSION_TTL_S = 15 * 60;

const DEFAULT_ISSUER = 'https://stg-id.singpass.gov.sg/fapi';
const DEFAULT_SCOPES = 'openid uinfin name dob regadd mobileno email';
const DEFAULT_CORPPASS_ISSUER = 'https://stg-id.corppass.gov.sg';
// Data minimisation: only what renting a unit to a company needs.
const DEFAULT_CORPPASS_SCOPES = [
  'openid',
  'entity.basic_profile.name',
  'entity.basic_profile.registration_number',
  'entity.basic_profile.uen_status',
  'entity.basic_profile.type',
  'entity.address',
  'corppass.email',
].join(' ');
const ASSERTION_TTL_S = 60; // Singpass rejects client assertions / DPoP proofs older than 120s.
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

interface SingpassSettings {
  provider: FapiProvider;
  clientId: string;
  issuer: string;
  redirectUri: string;
  scopes: string;
  privateJwks: JWK[];
  returnUrl: string;
}

export function providerSettings(provider: FapiProvider): SingpassSettings | null {
  const env = (k: string) => process.env[`${provider === 'singpass' ? 'SINGPASS' : 'CORPPASS'}_${k}`]?.trim() ?? '';
  const clientId = env('CLIENT_ID');
  const redirectUri = env('REDIRECT_URI');
  const privateJwks = loadPrivateJwks();
  if (!clientId || !redirectUri || privateJwks.length === 0) return null;
  const bookingApp = (process.env.BOOKING_APP_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
  const singpass = provider === 'singpass';
  return {
    provider,
    clientId,
    issuer: (env('ISSUER') || (singpass ? DEFAULT_ISSUER : DEFAULT_CORPPASS_ISSUER)).replace(/\/+$/, ''),
    redirectUri,
    scopes: env('SCOPES') || (singpass ? DEFAULT_SCOPES : DEFAULT_CORPPASS_SCOPES),
    privateJwks,
    returnUrl: env('RETURN_URL') || `${bookingApp}/`,
  };
}

export function singpassSettings(): SingpassSettings | null {
  return providerSettings('singpass');
}

function requireSettings(provider: FapiProvider = 'singpass'): SingpassSettings {
  const s = providerSettings(provider);
  if (!s) {
    const label = provider === 'singpass' ? 'Singpass' : 'Myinfo Business';
    throw new AppError(503, `${provider.toUpperCase()}_NOT_CONFIGURED`, `${label} verification is not available yet.`);
  }
  return s;
}

function loadPrivateJwks(): JWK[] {
  const raw = process.env.SINGPASS_PRIVATE_JWKS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { keys?: JWK[] };
    return Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch {
    // Never echo the value — it holds private keys.
    console.error('[singpass] SINGPASS_PRIVATE_JWKS is not valid JSON');
    return [];
  }
}

/**
 * Public JWKS served at /.well-known/jwks.json. Only public members are
 * copied (whitelist, so a private `d` can never leak even if the env JWKS
 * carries extra fields).
 */
export function publicJwks(): { keys: JWK[] } {
  const keys = loadPrivateJwks().map((k) => {
    const pub: JWK = { kty: k.kty, crv: k.crv, x: k.x, y: k.y, kid: k.kid, use: k.use, alg: k.alg };
    return pub;
  });
  return { keys };
}

function signingJwk(s: SingpassSettings): JWK {
  // First `sig` key signs. During rotation, publish the new key second, wait
  // ≥1h, then move it first (Singpass JWKS rotation guidance).
  const k = s.privateJwks.find((j) => j.use === 'sig');
  if (!k) throw new AppError(503, 'SINGPASS_NOT_CONFIGURED', 'No Singpass signing key configured.');
  return k;
}

// ---------- discovery ----------

interface Discovery {
  issuer: string;
  pushed_authorization_request_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

// Per-issuer caches (Singpass and Corppass run side by side).
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new AppError(502, 'SINGPASS_UPSTREAM', `Discovery failed for ${issuer} (${res.status})`);
  const doc = (await res.json()) as Discovery;
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

function singpassJwks(uri: string) {
  let set = remoteJwks.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    remoteJwks.set(uri, set);
  }
  return set;
}

// ---------- JWT helpers ----------

const b64url = (buf: Buffer) => buf.toString('base64url');
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const now = () => Math.floor(Date.now() / 1000);

async function clientAssertion(s: SingpassSettings, aud: string): Promise<string> {
  const jwk = signingJwk(s);
  const key = await importJWK(jwk, jwk.alg ?? 'ES256');
  const iat = now();
  return new SignJWT({})
    .setProtectedHeader({ alg: jwk.alg ?? 'ES256', typ: 'JWT', kid: jwk.kid })
    .setIssuer(s.clientId)
    .setSubject(s.clientId)
    .setAudience(aud)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ASSERTION_TTL_S)
    .setJti(randomToken(16))
    .sign(key);
}

async function dpopProof(
  privateJwk: JWK,
  htm: 'GET' | 'POST',
  htu: string,
  extra: { ath?: string; nonce?: string } = {},
): Promise<string> {
  const key = await importJWK(privateJwk, 'ES256');
  const { d: _d, ...pub } = privateJwk;
  const iat = now();
  return new SignJWT({ htm, htu, ...extra })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ASSERTION_TTL_S)
    .setJti(randomToken(16))
    .sign(key);
}

/**
 * POST/GET with a fresh DPoP proof, retrying once when the server demands a
 * DPoP nonce (`use_dpop_nonce` + `DPoP-Nonce` header, RFC 9449 §8).
 */
async function dpopFetch(
  dpopJwk: JWK,
  method: 'GET' | 'POST',
  url: string,
  init: { body?: URLSearchParams; accessToken?: string },
): Promise<Response> {
  const ath = init.accessToken ? b64url(crypto.createHash('sha256').update(init.accessToken).digest()) : undefined;
  let nonce: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers: Record<string, string> = { DPoP: await dpopProof(dpopJwk, method, url, { ath, nonce }) };
    if (init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (init.accessToken) headers.Authorization = `DPoP ${init.accessToken}`;
    const res = await fetch(url, { method, headers, body: init.body });
    const serverNonce = res.headers.get('dpop-nonce');
    if ((res.status === 400 || res.status === 401) && serverNonce && serverNonce !== nonce) {
      nonce = serverNonce;
      continue;
    }
    return res;
  }
  throw new AppError(502, 'SINGPASS_UPSTREAM', 'Singpass DPoP nonce negotiation failed');
}

async function upstreamError(step: string, res: Response): Promise<AppError> {
  // Log the OAuth error code/description only (no tokens or personal data).
  let detail = '';
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    detail = [body.error, body.error_description].filter(Boolean).join(': ');
  } catch {
    /* non-JSON */
  }
  console.error(`[singpass] ${step} failed (${res.status}) ${detail}`);
  return new AppError(502, 'SINGPASS_UPSTREAM', `Singpass ${step} failed`);
}

// ---------- auth-session cookie (encrypted, short-lived) ----------

export interface SingpassAuthSession {
  /** Absent on sessions sealed before Corppass support → Singpass. */
  provider?: FapiProvider;
  state: string;
  nonce: string;
  codeVerifier: string;
  dpopJwk: JWK;
  bookingRef: string;
  /** Booking-app path (+query) to land on after Singpass, e.g. /checkout/success?session_id=… */
  returnPath?: string;
}

function sessionKey(): Uint8Array {
  // Derived from JWT_SECRET with a purpose label so no extra secret is needed.
  return crypto.createHash('sha256').update(`storelah:singpass-session:${config.jwtSecret}`).digest();
}

async function sealSession(session: SingpassAuthSession): Promise<string> {
  return new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${SINGPASS_SESSION_TTL_S}s`)
    .encrypt(sessionKey());
}

export async function openSession(sealed: string | undefined): Promise<SingpassAuthSession> {
  if (!sealed) throw new AppError(400, 'SINGPASS_SESSION', 'Singpass session expired. Please start again.');
  try {
    const { payload } = await jwtDecrypt(sealed, sessionKey());
    return payload as unknown as SingpassAuthSession;
  } catch {
    throw new AppError(400, 'SINGPASS_SESSION', 'Singpass session expired. Please start again.');
  }
}

// ---------- flow ----------

/**
 * Only same-origin relative paths are accepted (no `//host`, no scheme, no
 * backslashes) so /start can never become an open redirect.
 */
export function safeReturnPath(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 512) return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return undefined;
  return raw;
}

/** Final landing URL: SINGPASS_RETURN_URL's origin + returnPath (or the URL itself). */
export function singpassReturnUrl(returnUrl: string, returnPath: string | undefined): URL {
  const base = new URL(returnUrl);
  if (!returnPath) return base;
  // URL parsing strips tabs/newlines (`/\t/evil.test` → `//evil.test`), so
  // re-check the resolved origin rather than trusting the string checks alone.
  const url = new URL(returnPath, base.origin);
  return url.origin === base.origin ? url : base;
}

export async function startSingpassLogin(
  bookingRef: string,
  returnPath?: string,
): Promise<{ redirectUrl: string; sealedSession: string }> {
  return startFapiLogin('singpass', bookingRef, returnPath);
}

/**
 * PAR → authorize URL for either provider. `ref` is the booking ref
 * (Singpass) or the booking draft ref (Corppass prefill, before a booking
 * exists). Corppass rejects `authentication_context_type` for Myinfo
 * Business, and Singpass Myinfo apps don't need it, so neither sends it.
 */
export async function startFapiLogin(
  provider: FapiProvider,
  bookingRef: string,
  returnPath?: string,
): Promise<{ redirectUrl: string; sealedSession: string }> {
  const s = requireSettings(provider);
  const d = await discover(s.issuer);

  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const dpopJwk = await exportJWK(privateKey);
  const session: SingpassAuthSession = {
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: randomToken(48), // 64 chars, within PKCE's 43–128
    dpopJwk,
    bookingRef,
    returnPath: safeReturnPath(returnPath),
    provider,
  };
  const codeChallenge = b64url(crypto.createHash('sha256').update(session.codeVerifier).digest());

  const body = new URLSearchParams({
    response_type: 'code',
    client_id: s.clientId,
    scope: s.scopes,
    redirect_uri: s.redirectUri,
    state: session.state,
    nonce: session.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await clientAssertion(s, d.issuer),
  });
  const res = await dpopFetch(dpopJwk, 'POST', d.pushed_authorization_request_endpoint, { body });
  if (!res.ok) throw await upstreamError('PAR', res);
  const par = (await res.json()) as { request_uri: string };

  const authorize = new URL(d.authorization_endpoint);
  authorize.searchParams.set('client_id', s.clientId);
  authorize.searchParams.set('request_uri', par.request_uri);
  return { redirectUrl: authorize.toString(), sealedSession: await sealSession(session) };
}

export interface MyinfoPerson {
  sub: string;
  uinfin: string | null;
  name: string | null;
  dob: string | null;
  mobileno: string | null;
  email: string | null;
  regadd: string | null;
}

async function decryptionKey(kid: string | undefined): Promise<KeyLike | Uint8Array> {
  // Keys are shared by both providers (one JWKS endpoint).
  const jwk = loadPrivateJwks().find((k) => k.use === 'enc' && (!kid || k.kid === kid));
  if (!jwk) throw new AppError(502, 'SINGPASS_UPSTREAM', 'No matching Singpass decryption key');
  return importJWK(jwk, jwk.alg ?? 'ECDH-ES+A256KW');
}

/** JWE(JWS) → verified claims; also accepts a bare JWS. */
async function openNestedJwt(
  token: string,
  jwksUri: string,
  verify: { issuer: string; audience?: string },
): Promise<Record<string, unknown>> {
  let jws = token;
  if (token.split('.').length === 5) {
    const { plaintext } = await compactDecrypt(token, (header) => decryptionKey(header.kid));
    jws = new TextDecoder().decode(plaintext);
  }
  const { payload } = await jwtVerify(jws, singpassJwks(jwksUri), verify);
  return payload as Record<string, unknown>;
}

// Myinfo v5 attributes arrive as `{ value: … }` objects; regadd is structured.
function attr(obj: Record<string, unknown>, key: string): unknown {
  const v = obj[key];
  if (v && typeof v === 'object' && 'value' in (v as object)) return (v as { value: unknown }).value;
  return v ?? null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function formatRegadd(v: unknown): string | null {
  if (!v || typeof v !== 'object') return str(v);
  const a = v as Record<string, unknown>;
  const part = (k: string) => str(attr(a, k));
  const unit = part('floor') && part('unit') ? `#${part('floor')}-${part('unit')}` : null;
  const line = [part('block'), part('street'), unit, part('building'), part('postal') && `Singapore ${part('postal')}`]
    .filter(Boolean)
    .join(' ');
  return line || str(attr(a, 'line1'));
}

function formatMobile(v: unknown): string | null {
  if (!v || typeof v !== 'object') return str(v);
  const m = v as Record<string, unknown>;
  const prefix = str(attr(m, 'prefix')) ?? '';
  const code = str(attr(m, 'areacode'));
  const nbr = str(attr(m, 'nbr'));
  return nbr ? `${prefix}${code ?? ''} ${nbr}`.trim() : null;
}

export function parseMyinfoPerson(claims: Record<string, unknown>): MyinfoPerson {
  const person = (claims.person_info && typeof claims.person_info === 'object'
    ? claims.person_info
    : claims) as Record<string, unknown>;
  return {
    sub: String(claims.sub ?? ''),
    uinfin: str(attr(person, 'uinfin')),
    name: str(attr(person, 'name')),
    dob: str(attr(person, 'dob')),
    mobileno: formatMobile(person.mobileno),
    email: str(attr(person, 'email')),
    regadd: formatRegadd(person.regadd),
  };
}

export async function completeSingpassLogin(
  session: SingpassAuthSession,
  code: string,
): Promise<MyinfoPerson> {
  const { idSub, claims } = await completeFapiLogin('singpass', session, code);
  return parseMyinfoPerson({ ...claims, sub: idSub });
}

export async function completeCorppassLogin(session: SingpassAuthSession, code: string): Promise<MyinfoBusiness> {
  const { idSub, claims } = await completeFapiLogin('corppass', session, code);
  return parseMyinfoBusiness({ ...claims, sub: idSub });
}

/** Token exchange → verified ID token → userinfo claims, for either provider. */
async function completeFapiLogin(
  provider: FapiProvider,
  session: SingpassAuthSession,
  code: string,
): Promise<{ idSub: string; claims: Record<string, unknown> }> {
  if ((session.provider ?? 'singpass') !== provider) {
    throw new AppError(400, 'SINGPASS_SESSION', 'Login session does not match this provider.');
  }
  const s = requireSettings(provider);
  const d = await discover(s.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: s.redirectUri,
    code_verifier: session.codeVerifier,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await clientAssertion(s, d.issuer),
  });
  const tokenRes = await dpopFetch(session.dpopJwk, 'POST', d.token_endpoint, { body });
  if (!tokenRes.ok) throw await upstreamError('token', tokenRes);
  const tokens = (await tokenRes.json()) as { access_token: string; id_token: string };

  const idClaims = await openNestedJwt(tokens.id_token, d.jwks_uri, { issuer: d.issuer, audience: s.clientId });
  if (idClaims.nonce !== session.nonce) {
    throw new AppError(400, 'SINGPASS_SESSION', 'Singpass response did not match this session.');
  }

  const uiRes = await dpopFetch(session.dpopJwk, 'GET', d.userinfo_endpoint, { accessToken: tokens.access_token });
  if (!uiRes.ok) throw await upstreamError('userinfo', uiRes);
  const raw = (await uiRes.text()).trim();
  const claims = raw.startsWith('{')
    ? (JSON.parse(raw) as Record<string, unknown>)
    : await openNestedJwt(raw, d.jwks_uri, { issuer: d.issuer });
  if (claims.sub && claims.sub !== idClaims.sub) {
    throw new AppError(502, 'SINGPASS_UPSTREAM', 'Userinfo subject mismatch');
  }
  return { idSub: String(idClaims.sub ?? ''), claims };
}

// ---------- Myinfo Business (Corppass) entity mapping ----------

export interface MyinfoBusiness {
  sub: string;
  entityName: string | null;
  uen: string | null;
  uenStatus: string | null;
  entityType: string | null;
  registeredAddress: string | null;
  corppassEmail: string | null;
}

/**
 * Myinfo Business attribute wrappers: `{ value }`, `{ code, desc }` or
 * `{ unavailable: true }` (plus classification/source/lastupdated metadata).
 */
function businessAttr(v: unknown): string | null {
  if (!v || typeof v !== 'object') return str(v);
  const o = v as Record<string, unknown>;
  if (o.unavailable === true) return null;
  if ('value' in o) return str(o.value);
  if ('desc' in o || 'code' in o) return str(o.desc) ?? str(o.code);
  return null;
}

/** Entity address: Myinfo-style structured fields (block/street/…) or line fields. */
function formatEntityAddress(v: unknown): string | null {
  if (!v || typeof v !== 'object') return str(v);
  const a = v as Record<string, unknown>;
  if (a.unavailable === true) return null;
  const part = (k: string) => businessAttr(a[k]);
  const unit = part('floor') && part('unit') ? `#${part('floor')}-${part('unit')}` : null;
  const structured = [part('block'), part('street'), unit, part('building'), part('postal') && `Singapore ${part('postal')}`]
    .filter(Boolean)
    .join(' ');
  if (structured) return structured;
  const lines = ['line1', 'line2', 'line3', 'line4'].map(part).filter(Boolean).join(', ');
  return lines || null;
}

export function parseMyinfoBusiness(claims: Record<string, unknown>): MyinfoBusiness {
  const entity = (claims.entity_info ?? {}) as Record<string, unknown>;
  const profile = (entity.basic_profile ?? {}) as Record<string, unknown>;
  const corppass = (claims.corppass_info ?? {}) as Record<string, unknown>;
  return {
    sub: String(claims.sub ?? ''),
    entityName: businessAttr(profile.name),
    uen: businessAttr(profile.registration_number),
    uenStatus: businessAttr(profile.uen_status),
    entityType: businessAttr(profile.type),
    registeredAddress: formatEntityAddress(entity.address),
    corppassEmail: businessAttr(corppass.email),
  };
}

/** S1234567D → S****567D (PDPA: never persist or display the full NRIC/FIN). */
export function maskUinfin(uinfin: string | null): string | null {
  if (!uinfin || uinfin.length < 5) return uinfin ? '*'.repeat(uinfin.length) : null;
  return `${uinfin[0]}${'*'.repeat(uinfin.length - 5)}${uinfin.slice(-4)}`;
}

/** Test hook: drop cached discovery/JWKS between mock-issuer runs. */
export function resetSingpassCaches(): void {
  discoveryCache.clear();
  remoteJwks.clear();
}
