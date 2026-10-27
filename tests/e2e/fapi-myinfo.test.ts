// Singpass Myinfo + Corppass Myinfo Business relying-party flows end to end
// against an in-process mock FAPI 2.0 authorization server that enforces
// what the real ones do: client assertion signed with our JWKS key, DPoP
// proofs (htm/htu, `ath` at userinfo, same key PAR→token→userinfo), PKCE
// S256, exact redirect_uri, and ID token + userinfo as JWE(JWS) encrypted to
// our `enc` key. Corppass discovery points PAR at `/request` (not `/par`) and
// must not receive `authentication_context_type` for Myinfo Business.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as jose from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/app';
import { resetSingpassCaches } from '../../src/core/singpass';
import { prisma, resetDb } from './fixtures';

const CLIENT = { singpass: 'S'.repeat(32), corppass: 'C'.repeat(32) };
const REDIRECT = {
  singpass: 'https://api.example.test/api/v1/public/singpass/callback',
  corppass: 'https://api.example.test/api/v1/public/corppass/callback',
};
const RETURN_URL = 'https://app.example.test/';

const PERSON = {
  uinfin: { value: 'S1234567D' },
  name: { value: 'TAN AH KOW' },
  dob: { value: '1990-01-31' },
  email: { value: 'tan@example.com' },
  mobileno: { prefix: { value: '+' }, areacode: { value: '65' }, nbr: { value: '91234567' } },
  regadd: { block: { value: '10' }, street: { value: 'ANSON ROAD' }, postal: { value: '079903' } },
};
const ENTITY = {
  basic_profile: {
    name: { classification: 'C', source: '1', lastupdated: '2026-01-01', value: 'SAMPLE TRADING PTE. LTD.' },
    registration_number: { classification: 'C', source: '1', lastupdated: '2026-01-01', value: '201912345K' },
    uen_status: { classification: 'C', source: '1', lastupdated: '2026-01-01', code: 'R', desc: 'Live Company' },
    type: { classification: 'C', source: '1', lastupdated: '2026-01-01', code: 'LC', desc: 'Local Company' },
  },
  address: {
    classification: 'C',
    source: '1',
    lastupdated: '2026-01-01',
    block: { value: '1' },
    street: { value: 'RAFFLES PLACE' },
    floor: { value: '20' },
    unit: { value: '01' },
    postal: { value: '048616' },
  },
};

type Prov = 'singpass' | 'corppass';
let server: http.Server;
let base = '';
let clientSig: jose.JWK;
let clientEnc: jose.JWK;
let opKey: jose.KeyLike;
let opPublic: jose.JWK;
const par = new Map<string, { prov: Prov; form: URLSearchParams; jkt: string }>();
const codes = new Map<string, { prov: Prov; form: URLSearchParams; jkt: string }>();
const tokens = new Map<string, { prov: Prov; jkt: string }>();
const parPaths: string[] = [];

const issuerOf = (p: Prov) => `${base}/${p === 'singpass' ? 'fapi' : 'cp'}`;
const b64 = (b: Buffer) => b.toString('base64url');

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  let d = '';
  for await (const c of req) d += c;
  return new URLSearchParams(d);
}

async function checkDpop(req: http.IncomingMessage, htm: string, htu: string, at?: string): Promise<string> {
  const proof = req.headers.dpop as string;
  if (!proof) throw new Error('missing DPoP');
  const { payload, protectedHeader } = await jose.jwtVerify(proof, jose.EmbeddedJWK, { typ: 'dpop+jwt' });
  if (payload.htm !== htm || payload.htu !== htu) throw new Error('DPoP htm/htu');
  if (at && payload.ath !== b64(crypto.createHash('sha256').update(at).digest())) throw new Error('DPoP ath');
  return jose.calculateJwkThumbprint(protectedHeader.jwk as jose.JWK);
}

async function checkAssertion(prov: Prov, form: URLSearchParams): Promise<void> {
  const { d: _d, ...pub } = clientSig;
  await jose.jwtVerify(form.get('client_assertion') as string, await jose.importJWK(pub, 'ES256'), {
    issuer: CLIENT[prov],
    subject: CLIENT[prov],
    audience: issuerOf(prov),
  });
}

async function nested(prov: Prov, claims: Record<string, unknown>): Promise<string> {
  const jws = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'op-sig' })
    .setIssuer(issuerOf(prov))
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(opKey);
  const { d: _d, ...encPub } = clientEnc;
  return new jose.CompactEncrypt(new TextEncoder().encode(jws))
    .setProtectedHeader({ alg: 'ECDH-ES+A256KW', enc: 'A256CBC-HS512', cty: 'JWT', kid: clientEnc.kid })
    .encrypt(await jose.importJWK(encPub, 'ECDH-ES+A256KW'));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const send = (status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const url = new URL(req.url as string, base);
  const prov: Prov = url.pathname.startsWith('/cp') ? 'corppass' : 'singpass';
  const iss = issuerOf(prov);
  const parPath = prov === 'corppass' ? '/request' : '/par';
  try {
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return send(200, {
        issuer: iss,
        pushed_authorization_request_endpoint: `${iss}${parPath}`,
        authorization_endpoint: `${iss}/authorize`,
        token_endpoint: `${iss}/token`,
        userinfo_endpoint: `${iss}/userinfo`,
        jwks_uri: `${iss}/jwks`,
      });
    }
    if (url.pathname.endsWith('/jwks')) return send(200, { keys: [opPublic] });
    if (url.pathname.endsWith(parPath) && req.method === 'POST') {
      parPaths.push(url.pathname);
      const form = await readForm(req);
      const jkt = await checkDpop(req, 'POST', `${iss}${parPath}`);
      await checkAssertion(prov, form);
      if (form.get('redirect_uri') !== REDIRECT[prov]) throw new Error('redirect_uri');
      if (form.get('code_challenge_method') !== 'S256') throw new Error('PKCE');
      if (prov === 'corppass' && form.has('authentication_context_type')) throw new Error('authentication_context_type rejected');
      const requestUri = `urn:ietf:params:oauth:request_uri:${crypto.randomUUID()}`;
      par.set(requestUri, { prov, form, jkt });
      return send(201, { request_uri: requestUri, expires_in: 60 });
    }
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      const form = await readForm(req);
      const jkt = await checkDpop(req, 'POST', `${iss}/token`);
      await checkAssertion(prov, form);
      const entry = codes.get(form.get('code') as string);
      if (!entry || entry.prov !== prov) return send(400, { error: 'invalid_grant' });
      if (jkt !== entry.jkt) throw new Error('DPoP key changed');
      const challenge = b64(crypto.createHash('sha256').update(form.get('code_verifier') as string).digest());
      if (challenge !== entry.form.get('code_challenge')) throw new Error('PKCE mismatch');
      const at = `at-${crypto.randomUUID()}`;
      tokens.set(at, { prov, jkt });
      const idToken = await nested(prov, { aud: CLIENT[prov], sub: `${prov}-user-1`, nonce: entry.form.get('nonce') });
      return send(200, { access_token: at, token_type: 'DPoP', id_token: idToken });
    }
    if (url.pathname.endsWith('/userinfo')) {
      const at = String(req.headers.authorization ?? '').replace(/^DPoP /, '');
      const t = tokens.get(at);
      if (!t) return send(401, { error: 'invalid_token' });
      const jkt = await checkDpop(req, 'GET', `${iss}/userinfo`, at);
      if (jkt !== t.jkt) throw new Error('DPoP key mismatch');
      const claims =
        prov === 'singpass'
          ? { sub: 'singpass-user-1', person_info: PERSON }
          : { sub: 'corppass-user-1', entity_info: ENTITY, corppass_info: { email: { value: 'admin@sample-trading.test' } } };
      return send(200, await nested(prov, claims), 'application/jwt');
    }
    send(404, { error: 'not_found' });
  } catch (err) {
    send(400, { error: 'invalid_request', error_description: (err as Error).message });
  }
}

/** Simulate the user approving on the provider: PAR request_uri → auth code. */
function approve(location: string): { code: string; state: string } {
  const requestUri = new URL(location).searchParams.get('request_uri') as string;
  const entry = par.get(requestUri);
  if (!entry) throw new Error('unknown request_uri');
  const code = `code-${crypto.randomUUID()}`;
  codes.set(code, entry);
  return { code, state: entry.form.get('state') as string };
}

beforeAll(async () => {
  const sig = await jose.generateKeyPair('ES256', { extractable: true });
  const enc = await jose.generateKeyPair('ECDH-ES+A256KW', { crv: 'P-256', extractable: true });
  clientSig = { ...(await jose.exportJWK(sig.privateKey)), kid: 't-sig', use: 'sig', alg: 'ES256' };
  clientEnc = { ...(await jose.exportJWK(enc.privateKey)), kid: 't-enc', use: 'enc', alg: 'ECDH-ES+A256KW' };
  const op = await jose.generateKeyPair('ES256', { extractable: true });
  opKey = op.privateKey;
  opPublic = { ...(await jose.exportJWK(op.publicKey)), kid: 'op-sig', use: 'sig', alg: 'ES256' };

  server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    SINGPASS_PRIVATE_JWKS: JSON.stringify({ keys: [clientSig, clientEnc] }),
    SINGPASS_CLIENT_ID: CLIENT.singpass,
    SINGPASS_ISSUER: issuerOf('singpass'),
    SINGPASS_REDIRECT_URI: REDIRECT.singpass,
    SINGPASS_RETURN_URL: RETURN_URL,
    CORPPASS_CLIENT_ID: CLIENT.corppass,
    CORPPASS_ISSUER: issuerOf('corppass'),
    CORPPASS_REDIRECT_URI: REDIRECT.corppass,
    CORPPASS_RETURN_URL: RETURN_URL,
  });
  resetSingpassCaches();
});

afterAll(async () => {
  for (const k of [
    'SINGPASS_PRIVATE_JWKS',
    'SINGPASS_CLIENT_ID',
    'SINGPASS_ISSUER',
    'SINGPASS_REDIRECT_URI',
    'SINGPASS_RETURN_URL',
    'CORPPASS_CLIENT_ID',
    'CORPPASS_ISSUER',
    'CORPPASS_REDIRECT_URI',
    'CORPPASS_RETURN_URL',
  ]) {
    delete process.env[k];
  }
  resetSingpassCaches();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await resetDb();
});

describe('Corppass Myinfo Business (company prefill)', () => {
  it('reports enabled and serves both keys from one JWKS', async () => {
    const st = await request(app).get('/api/v1/public/corppass/status').expect(200);
    expect(st.body.data.enabled).toBe(true);
    const jwks = await request(app).get('/.well-known/jwks.json').expect(200);
    expect(jwks.body.keys.map((k: jose.JWK) => k.use)).toEqual(['sig', 'enc']);
    expect(jwks.body.keys.some((k: jose.JWK) => 'd' in k)).toBe(false);
  });

  it('start → PAR at /request → callback → review → confirm (VERIFIED, provider corppass)', async () => {
    const agent = request.agent(app);
    const start = await agent
      .get('/api/v1/public/corppass/start')
      .query({ ref: 'DRAFT-ABC123', returnPath: '/?step=4' })
      .expect(302);
    expect(new URL(start.headers.location).pathname).toBe('/cp/authorize');
    expect(parPaths.at(-1)).toBe('/cp/request');
    expect(String(start.headers['set-cookie'])).toMatch(/cp_auth=.*Path=\/api\/v1\/public\/corppass.*HttpOnly/);

    const { code, state } = approve(start.headers.location);
    const cb = await agent.get('/api/v1/public/corppass/callback').query({ code, state }).expect(302);
    const back = new URL(cb.headers.location);
    expect(back.origin + back.pathname).toBe('https://app.example.test/');
    expect(back.searchParams.get('step')).toBe('4');
    expect(back.searchParams.get('corppass')).toBe('review');
    expect(back.searchParams.get('ref')).toBe('DRAFT-ABC123');
    expect(cb.headers.location).not.toMatch(/SAMPLE|201912345K/); // no company data in the URL
    const token = back.searchParams.get('review') as string;

    const review = await request(app).get('/api/v1/public/corppass/review').query({ token }).expect(200);
    expect(review.body.data).toMatchObject({
      draftRef: 'DRAFT-ABC123',
      verified: {
        entityName: 'SAMPLE TRADING PTE. LTD.',
        uen: '201912345K',
        uenStatus: 'Live Company',
        entityType: 'Local Company',
        registeredAddress: '1 RAFFLES PLACE #20-01 Singapore 048616',
      },
      editable: { email: 'admin@sample-trading.test' },
    });

    const confirm = await request(app)
      .post('/api/v1/public/corppass/review/confirm')
      .send({ token, email: 'ops@sample-trading.test' })
      .expect(200);
    expect(confirm.body.data.verification).toMatchObject({ status: 'VERIFIED', provider: 'corppass', idType: 'uen' });
    expect(confirm.body.data.company.editable.email).toBe('ops@sample-trading.test');
    const row = await prisma.verification.findFirstOrThrow({ where: { bookingRef: 'DRAFT-ABC123' } });
    expect(row.method).toBe('myinfo-business');
    expect((row.payload as Record<string, unknown>).reviewTokenHash).toBeUndefined();

    await request(app).post('/api/v1/public/corppass/review/confirm').send({ token }).expect(404); // single-use
  });

  it('cancel discards the company data; consent declined returns cancelled', async () => {
    const agent = request.agent(app);
    const start = await agent.get('/api/v1/public/corppass/start').query({ ref: 'DRAFT-CANCEL1' }).expect(302);
    const { code, state } = approve(start.headers.location);
    const cb = await agent.get('/api/v1/public/corppass/callback').query({ code, state }).expect(302);
    const token = new URL(cb.headers.location).searchParams.get('review') as string;
    await request(app).post('/api/v1/public/corppass/review/cancel').send({ token }).expect(200);
    expect(await prisma.verification.count({ where: { bookingRef: 'DRAFT-CANCEL1' } })).toBe(0);

    const start2 = await agent.get('/api/v1/public/corppass/start').query({ ref: 'DRAFT-CANCEL2' }).expect(302);
    const state2 = approve(start2.headers.location).state;
    const denied = await agent
      .get('/api/v1/public/corppass/callback')
      .query({ error: 'access_denied', state: state2 })
      .expect(302);
    expect(new URL(denied.headers.location).searchParams.get('corppass')).toBe('cancelled');
  });

  it('a callback without the session cookie fails safely', async () => {
    const cb = await request(app).get('/api/v1/public/corppass/callback').query({ code: 'x', state: 'y' }).expect(302);
    expect(new URL(cb.headers.location).searchParams.get('corppass')).toBe('failed');
  });

  it('a Corppass review token is not accepted by the Singpass review and vice versa', async () => {
    const agent = request.agent(app);
    const start = await agent.get('/api/v1/public/corppass/start').query({ ref: 'DRAFT-X1' }).expect(302);
    const { code, state } = approve(start.headers.location);
    const cb = await agent.get('/api/v1/public/corppass/callback').query({ code, state }).expect(302);
    const token = new URL(cb.headers.location).searchParams.get('review') as string;
    await request(app).get('/api/v1/public/singpass/review').query({ token }).expect(404);
    await request(app).get('/api/v1/public/corppass/review').query({ token }).expect(200);
  });
});

describe('Singpass Myinfo (individual) still works alongside Corppass', () => {
  it('start → PAR at /par → callback → review → confirm', async () => {
    const agent = request.agent(app);
    const start = await agent
      .get('/api/v1/public/singpass/start')
      .query({ bookingRef: 'SL-2026-0001', returnPath: '/checkout/success?session_id=cs_1' })
      .expect(302);
    expect(parPaths.at(-1)).toBe('/fapi/par');
    const { code, state } = approve(start.headers.location);
    const cb = await agent.get('/api/v1/public/singpass/callback').query({ code, state }).expect(302);
    const back = new URL(cb.headers.location);
    expect(back.searchParams.get('singpass')).toBe('review');
    const token = back.searchParams.get('review') as string;
    const review = await request(app).get('/api/v1/public/singpass/review').query({ token }).expect(200);
    expect(review.body.data.verified).toMatchObject({ uinfin: 'S****567D', name: 'TAN AH KOW' });
    const confirm = await request(app).post('/api/v1/public/singpass/review/confirm').send({ token }).expect(200);
    expect(confirm.body.data).toMatchObject({ status: 'VERIFIED', provider: 'singpass' });
  });

  it('a Singpass cookie cannot complete a Corppass callback', async () => {
    const agent = request.agent(app);
    const start = await agent.get('/api/v1/public/singpass/start').query({ bookingRef: 'SL-2026-0002' }).expect(302);
    const { code, state } = approve(start.headers.location);
    // Same browser, wrong callback: no cp_auth cookie → failed, nothing stored.
    const cb = await agent.get('/api/v1/public/corppass/callback').query({ code, state }).expect(302);
    expect(new URL(cb.headers.location).searchParams.get('corppass')).toBe('failed');
    expect(await prisma.verification.count()).toBe(0);
  });
});
