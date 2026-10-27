# Myinfo Business (Corppass) — integration + user-journey deck plan

Status: **phases 1 + 3 built against a mock** (2026-10-27, branches `feature/myinfo-business` in backend + booking). Phases 2, 4, 5 pending. Companion to `docs/singpass-myinfo.md`
(individual Myinfo, live). Cross-lane: backend + booking + one DB migration.

## Goal

Company customers who choose **Business** on the booking Details step can
press **"Retrieve Myinfo Business with Singpass"**, log in through Singpass
as a Corppass user, and have the company's government-verified details
pre-filled. Then StoreLah submits the matching Myinfo Business user-journey
deck to Singpass.

## How it differs from what we already built

| | Individual Myinfo (live) | Myinfo Business (this plan) |
| --- | --- | --- |
| Authorization server | Singpass FAPI 2.0, `stg-id.singpass.gov.sg/fapi` | **Corppass** FAPI 2.0, `stg-id.corppass.gov.sg` / `id.corppass.gov.sg` |
| Protocol | PAR + PKCE + DPoP + private_key_jwt, ID token JWE(JWS) | **Same** (PAR at `/request`, so endpoints are read from discovery) |
| App registration | Singpass Developer Portal, "Myinfo" app `b3eKNz…` | Singpass Developer Portal, a **new "Myinfo Business" app** with its own Client ID |
| Redirect URL | `https://api.storelah.sg/api/v1/public/singpass/callback` | `https://api.storelah.sg/api/v1/public/corppass/callback` (https only, no localhost) |
| Keys | `https://api.storelah.sg/.well-known/jwks.json` | **Same JWKS endpoint**, so no new keys are needed |
| Userinfo | `person_info` | `entity_info` (company) + `person_info` + `corppass_info` |
| Who logs in | The individual | A Corppass user who is **assigned to StoreLah's e-service** for the entity |

Our existing `src/core/singpass.ts` already implements the hard parts: PAR,
DPoP (including nonce retry), PKCE, client assertion, JWE/JWS and the review
token. The Corppass work is mostly configuration plus a new data mapping.

## Customer journey (maps 1:1 to the Business template's 7 pages)

1. **Landing:** booking start (`app.storelah.sg`, Plan step).
2. **Digital form with option:** Details step → **Business** →
   - the official **"Update with Singpass"** button. The current Singpass button guidelines map "retrieval or update of information" to this artwork, and their asset pack has no "Retrieve" variant;
   - the required notice: *"To use Myinfo Business, ensure you have a Corppass account and are assigned to **StoreLah Storage Rental** digital service by **StoreLah Pte. Ltd.** for the entity you are applying for."* (exact e-service and organisation names to confirm);
   - the manual Company name / UEN fields stay available.
3. **Login:** Singpass login as a Corppass user (template page, unchanged).
4. **Consent:** Corppass consent page in staging (screenshot), showing the purpose and the requested scopes.
5. **Profile populated on form:** back on the Details step:
   - read-only (government-verified): company name, UEN, entity type, UEN status, registered address;
   - editable: contact name, mobile, email (pre-filled from `corppass.email` if requested);
   - **Use these details** or **Cancel**. Cancel discards the retrieved data. Nothing is stored until the booking is submitted.
6. **Form submission:** Pay → "Your space is booked." confirmation, showing the verified company.
7. **Error handling:** Corppass/Myinfo Business unavailable, cancelled or expired → the Details step shows a message and the manual Company name / UEN fields.

The person renting still verifies their own identity after payment with
individual Myinfo, which is already live. Business adds the company.

## Proposed scopes (data minimisation, to confirm)

| S/N | Data type | Category | Scope | Purpose |
| --- | --- | --- | --- | --- |
| 1 | Entity | Basic profile | `entity.basic_profile.name` | Company's registered name on the rental agreement and invoices |
| 2 | Entity | Basic profile | `entity.basic_profile.registration_number` | UEN, to identify the hirer company and record it on the agreement |
| 3 | Entity | Basic profile | `entity.basic_profile.uen_status` | Confirm the company is live before renting a unit to it |
| 4 | Entity | Basic profile | `entity.basic_profile.type` | Record the entity type (e.g. local company, sole proprietorship) on the agreement |
| 5 | Entity | Address | `entity.address` | Registered address on the agreement and for notices about the unit |
| 6 | Corppass | Contact | `corppass.email` (optional) | Pre-fill the contact email for receipts and access instructions (editable) |

Not requested: appointments, shareholders, capitals, financials, grants and
licences. None are needed to rent a storage unit, and Singpass reviews data
minimisation.

## Backend (storelah-backend)

1. **Provider config:** turn `core/singpass.ts` settings into per-provider config:
   - `singpass` (existing env, unchanged);
   - `corppass`: `CORPPASS_CLIENT_ID`, `CORPPASS_ISSUER` (default staging), `CORPPASS_REDIRECT_URI`, `CORPPASS_SCOPES`, `CORPPASS_RETURN_URL`;
   - shared: `SINGPASS_PRIVATE_JWKS` / JWKS endpoint, the session cookie (path per provider), PAR, DPoP and JWE code.
2. **Routes:** `/api/v1/public/corppass/{status,start,callback,review,review/cancel}`, mirroring the Singpass ones. `start` takes a draft ref plus `returnPath`. **Do not send `authentication_context_type`**, because Corppass rejects it for Myinfo Business.
3. **Mapping:** parse `entity_info` (`value` / `code`+`desc` / `unavailable` wrappers) into `{ name, uen, uenStatus, entityType, registeredAddress }`, plus `corppass_info.email`.
4. **Pending prefill (built):** the existing `Verification` table, keyed by the booking **draft ref** (`DRAFT-…`). It uses method `myinfo-business`, idType `uen`, status `PENDING_CONFIRMATION` until **Use these details** (→ `VERIFIED`, provider `corppass`). Review tokens work as for Singpass: sha256-hashed, single-use, 30 min. **No migration needed for phases 1 and 3.**
5. **Binding at submit:** `POST /customer/bookings` accepts an optional `myinfoBusinessToken`.
   - The server copies the **verified** company name, UEN and address onto the tenant and customer, overriding whatever the client sent.
   - It sets `companyVerifiedAt` and `companyVerificationSource = "myinfo-business"`, and consumes the token.
   - Without a token, behaviour is unchanged (manual entry, unverified).
   - → New nullable columns `Tenant.companyVerifiedAt`, `companyAddress`, `companyVerification` Json (same migration).
6. **CMS:** a "Company verified · Myinfo Business" badge on the tenant and customer.
7. **Policy (decide):** whether to block Business bookings whose UEN status isn't live, or just flag them in the CMS.

## Booking (storelah-booking)

1. Details step, Business:
   - add the official button and the Corppass notice, shown only when `/api/singpass/corppass-status` reports it enabled;
   - before redirecting, save the wizard snapshot (reuse the checkout-snapshot mechanism) and a draft ref.
2. Return `/?corppass=review&review=<token>`:
   - restore the wizard at Details → Business;
   - open the Myinfo Business review (company fields read-only, contact editable, **Use these details** / **Cancel**);
   - on use, fill the form with the verified fields locked and send `myinfoBusinessToken` with the booking.
3. Error, cancel or expiry: show a notice and keep the manual fields.
4. Tests: as for individual Myinfo (button, hand-off, review, cancel, error, token on submit).

## Testing

- **Unit + mock:** extend `docs/singpass-submission/mock_singpass_server.cjs` with a Corppass mode that returns `entity_info`, and run the backend e2e suite plus the booking tests.
- **Staging:** needs a **Corppass staging test entity and user** assigned to StoreLah's e-service. ⚠ The individual staging login currently offers only QR or passkey, so confirm with Singpass how Corppass test users log in on staging before relying on it.

## Owner actions (Singpass Developer Portal)

1. Create a **Myinfo Business** staging app:
   - purpose text, e-service name, scopes as above;
   - redirect `https://api.storelah.sg/api/v1/public/corppass/callback`;
   - JWKS endpoint `https://api.storelah.sg/.well-known/jwks.json`.
2. Send me the Client ID.
3. Request Corppass staging test accounts (an entity plus a user assigned to the e-service).
4. Authorise the **prod migration** and **deploy** when the build is ready.

## Deck (Myinfo Business template, July 2026)

- Cover + scope table (Data type / Category / Scope / Purpose, as above).
- Pages 1–7 captured by a Business mode of `capture_myinfo_staging.cjs`. Page 3 stays as the template's own page.
- PDF export (Singpass only accepts PDF).
- Consent (page 4) and populated form (page 5) need the staging Corppass login. Until then they get labelled sample data, as in the individual deck.

## Phases

| Phase | Work | Depends on |
| --- | --- | --- |
| 1 | Backend provider refactor + Corppass routes + mapping + mock tests | — |
| 2 | Migration + booking binding + CMS badge | Phase 1; prod migration authorisation |
| 3 | Booking Details-step button, review, snapshot restore, tests | Phase 1 |
| 4 | Staging e2e + capture + Business deck (PDF) | Owner's Myinfo Business app + Corppass test accounts |
| 5 | Deploy: migrate → Lambda env + code → booking `main` | Owner go-ahead |

Phases 1 and 3 can start immediately against the mock. Phase 4 is blocked on
the portal app and test accounts.
