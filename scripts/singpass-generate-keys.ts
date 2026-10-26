// Generate the StoreLah Singpass client key pair set (one ES256 signing key
// + one ECDH-ES+A256KW encryption key, P-256).
//
//   pnpm singpass:keys staging      → .secrets/singpass-private-jwks.staging.json
//   pnpm singpass:keys production   → .secrets/singpass-private-jwks.production.json
//
// The PRIVATE JWKS is written to a gitignored file (mode 0600) and never
// printed — load it into the SINGPASS_PRIVATE_JWKS env var (single-line JSON)
// yourself. Only the PUBLIC JWKS is printed: that is safe to paste into the
// Singpass portal as a "JWKS object" (e.g. staging, where localhost cannot
// serve an endpoint). Use separate keys per environment; rotate yearly with
// new kids (never reuse a kid).
import fs from 'fs';
import path from 'path';
import { exportJWK, generateKeyPair, type JWK } from 'jose';

async function main(): Promise<void> {
  const env = process.argv[2] ?? 'staging';
  if (!/^[a-z0-9-]+$/.test(env)) throw new Error('env label must be [a-z0-9-]');
  const stamp = new Date().toISOString().slice(0, 10);

  const sig = await generateKeyPair('ES256', { extractable: true });
  const enc = await generateKeyPair('ECDH-ES+A256KW', { crv: 'P-256', extractable: true });
  const sigJwk: JWK = { ...(await exportJWK(sig.privateKey)), kid: `storelah-${env}-sig-${stamp}`, use: 'sig', alg: 'ES256' };
  const encJwk: JWK = { ...(await exportJWK(enc.privateKey)), kid: `storelah-${env}-enc-${stamp}`, use: 'enc', alg: 'ECDH-ES+A256KW' };

  const dir = path.resolve(__dirname, '..', '.secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `singpass-private-jwks.${env}.json`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists — refusing to overwrite live keys`);
  fs.writeFileSync(file, JSON.stringify({ keys: [sigJwk, encJwk] }), { mode: 0o600 });

  const pub = { keys: [sigJwk, encJwk].map(({ d: _d, ...rest }) => rest) };
  console.log(`private JWKS written to ${file} (not printed)`);
  console.log('public JWKS:');
  console.log(JSON.stringify(pub, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
