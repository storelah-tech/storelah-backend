# Singpass Myinfo (v5 / FAPI 2.0) — onboarding sheet + integration

Answers for the Singpass developer portal "Setup requirements for Myinfo" form,
and how the backend implements the relying-party flow.

> Singpass does **not** use webhooks. The only inbound traffic is (1) the
> user's browser returning to our **redirect URL** and (2) Singpass fetching
> our **JWKS**. Everything else is us calling Singpass (PAR, token, userinfo).

## Portal form — what to enter

### App details

| Field | Value (owner to confirm wording) |
| --- | --- |
| App name | StoreLah |
| App purpose (shown on the Myinfo consent page) | Verify your identity and pre-fill your StoreLah storage rental agreement. |
| App use case description | StoreLah rents self-storage units in Singapore. When a customer books a unit online (app.storelah.sg), we verify the hirer's identity before granting 24/7 access to a physical storage unit, and pre-fill the rental agreement with their legal name, date of birth, registered address and contact details. Myinfo replaces manual ID-document upload; customers can still choose the document + selfie route instead. Verification is recorded against the booking reference and reviewed by StoreLah staff. |
| App category | Closest match to property / rental / leasing (else "Others") |
| Contact email(s) | tech@storelah.sg (+ owner's ops email) |
| Site URL(s) | https://storelah.sg, https://app.storelah.sg |

### Technical details

| Field | Staging app | Production app |
| --- | --- | --- |
| Profile type | Web application (redirect type `standard_https`), not a mobile app | same |
| Redirect URL(s) | `http://localhost:4000/api/v1/public/singpass/callback` | `https://api.storelah.sg/api/v1/public/singpass/callback` |
| JWKS endpoint / object | **JWKS object**: paste the public JWKS printed by `pnpm singpass:keys staging` (localhost can't serve an endpoint to Singpass) | **JWKS endpoint**: `https://api.storelah.sg/.well-known/jwks.json` |
| Mobile app launch URL(s) | N/A | N/A |

Use **separate key sets** for staging and production.

### Supporting document — user journey file

Use the existing submission PDFs in
`storelah-booking/docs/singpass-submission/`
(`storelah-singpass-screenshots.pdf` desktop, `-mobile.pdf` mobile). They show
the booking flow, including the Singpass identity-verification branch.

### Data scopes (`SINGPASS_SCOPES`)

`openid uinfin name dob regadd mobileno email`

| Scope | Why we need it |
| --- | --- |
| `uinfin` | Establishes the hirer's identity to a high degree of fidelity before granting access to a physical unit (PDPA NRIC Advisory Guidelines). Stored **masked only** (`S****567D`). |
| `name` | Legal name on the rental agreement |
| `dob` | Hirer must be 18+ to contract |
| `regadd` | Agreement address / contact for abandoned-goods notices |
| `mobileno`, `email` | Pre-fill contact details |

Check the scope names against the Myinfo catalog before submitting. Drop any
scope the business can't justify, since Singpass reviews data minimisation.
Changing scopes later needs only the env var plus a portal update.

## Backend implementation (`storelah-backend`)

| Route | Purpose |
| --- | --- |
| `GET /.well-known/jwks.json` | Public client JWKS (`sig` ES256 + `enc` ECDH-ES+A256KW, P-256). Built from `SINGPASS_PRIVATE_JWKS` with public members whitelisted, so `d` can never leak. |
| `GET /api/v1/public/singpass/status` | `{ enabled }`, lets booking show or hide the Singpass button |
| `GET /api/v1/public/singpass/start?bookingRef=&returnPath=` | Generates state, nonce, PKCE and an ephemeral DPoP key, then calls PAR with a `private_key_jwt` client assertion and a DPoP proof. Sets an encrypted HttpOnly cookie (`sp_auth`, 15 min, path-scoped) and 302s to Singpass `/auth?client_id&request_uri`. |
| `GET /api/v1/public/singpass/callback` | Checks state, then calls token (DPoP, with nonce retry). Decrypts the ID token (JWE) and verifies it (JWS: iss, aud, exp, nonce). Calls userinfo (DPoP + `ath`) and decrypts/verifies the response. Writes a `Verification` row (`method=singpass-myinfo`, `status=VERIFIED`, personal data in `payload`, NRIC masked). 302s to `SINGPASS_RETURN_URL` origin + `returnPath` (relative only; the resolved origin is re-checked, so it can't be used as an open redirect) with `?singpass=verified|cancelled|failed&bookingRef=`. |

Code: `src/core/singpass.ts`, `src/routes/public.ts`,
`recordSingpassVerification` in `src/core/verifications.ts`.
Endpoints come from `{SINGPASS_ISSUER}/.well-known/openid-configuration`
(cached for 1 hour). No DB migration is needed because the per-login session
lives in the encrypted cookie, keyed off `JWT_SECRET`.

### Keys

```sh
pnpm singpass:keys staging      # → .secrets/singpass-private-jwks.staging.json (0600, gitignored)
pnpm singpass:keys production
```

The script prints only the public JWKS. Load the private file into
`SINGPASS_PRIVATE_JWKS` as single-line JSON. The keys never go into git, logs
or chat.

**Rotation:** rotate at least once a year, and give each new key a new `kid`.
- **Signing key:** append the new key and deploy. Wait at least 1 hour, move it
  first (the first `sig` key signs), then remove the old key.
- **Encryption key:** add the new key (decryption picks the key by `kid`), wait
  at least 1 hour, then remove the old key.

### Env

See `.env.example`: `SINGPASS_CLIENT_ID`, `SINGPASS_ISSUER`,
`SINGPASS_REDIRECT_URI`, `SINGPASS_SCOPES`, `SINGPASS_PRIVATE_JWKS`,
`SINGPASS_RETURN_URL`. Prod values are set with a careful
`update-function-configuration`, never a stack deploy.

### Booking app (`storelah-booking/web`)

- The "Retrieve Myinfo with singpass" button sits in `VerificationModal`, on
  the Confirmation step only (not on PREVIEW refs). It shows only when
  `/api/singpass/status` reports enabled, so it stays hidden until the
  backend env is set.
- The button links to `/api/singpass/start`, which 302s to the backend
  `/singpass/start` with `returnPath` set to the current page (for example
  `/checkout/success?session_id=…`).
- When the customer comes back, `ConfirmationStep` reads `?singpass=`,
  reopens the modal (which shows the persisted result or a retry notice), and
  strips the params.

### Not done yet

- Prod: generate the production keys, set the Lambda env, deploy the backend,
  then merge the booking change.
- The live Singpass staging round trip needs the staging client ID.
