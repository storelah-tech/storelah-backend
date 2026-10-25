# Saved payment cards — backend plan

Status: **APPROVED 2026-10-25 — implemented on this branch** (not merged/deployed/migrated on prod). Branch `feature/8-saved-cards` (from `main`).
Companion: `storelah-booking/docs/portal-saved-cards-plan.md` (portal wallet + add-card sheet + pay picker).

## Why

The approved portal "Pass" redesign has an Account wallet (Visa/Mastercard card art, add-card
sheet) and a pay sheet that can pay with a saved card. Today the only payment path is hosted
Stripe Checkout per invoice (`POST /customer/invoices/:id/checkout`). Owner decision
2026-10-24: **Stripe Elements** for card entry — digits stay inside Stripe's iframes (PCI SAQ A
scope unchanged); our servers only ever see Stripe ids plus `brand`, `last4`, `exp_month`,
`exp_year`.

## Data model (one additive migration)

```prisma
model Customer {
  …
  // Stripe Customer (cus_…) that owns this portal customer's saved cards.
  // Created lazily on the first SetupIntent; NULL until then.
  stripeCustomerId String? @unique
}
```

Migration `20261025000000_customer_stripe_customer_id`: `ALTER TABLE "Customer" ADD COLUMN
"stripeCustomerId" TEXT` + unique index. Nullable, no backfill, no data rewrite.
**Prod migration needs explicit owner authorization** (migrate first via the direct Neon URL,
then Lambda code update — order per `docs/backend-deploy.md`).

No card data is stored in our DB. The Stripe Customer is the wallet; the default card is
Stripe's `customer.invoice_settings.default_payment_method`.

Invoices keep their existing columns: `paymentIntentId` is stamped when a saved-card
PaymentIntent is created (the webhook matches on it), `method = 'Card'`, `amountPaid` from Stripe.

## Endpoints (all `/api/v1/customer`, `requireCustomerAuth`, envelope via `ok()`/`AppError`)

| Method + path | Body | Returns |
| --- | --- | --- |
| `GET /payment-methods` | — | `{ cards: SavedCard[], defaultId: string\|null, publishableKey: string\|null }` |
| `POST /payment-methods/setup-intent` | — | `{ clientSecret, publishableKey }` |
| `POST /payment-methods/:id/default` | — | `{ cards, defaultId }` |
| `DELETE /payment-methods/:id` | — | `{ cards, defaultId }` |
| `POST /invoices/:id/pay` | `{ paymentMethodId }` | `{ status, clientSecret? , invoiceNo }` |

`SavedCard = { id: 'pm_…', brand, last4, expMonth, expYear, isDefault }` — built by an explicit
allow-list mapper (never spreads the Stripe object), so fingerprint / billing address / funding
never leave the server. `brand` is Stripe's lower-case brand (`visa`, `mastercard`, `amex`, …).

Details:

- **Stripe Customer lazily ensured** (`ensureStripeCustomer`): reads `Customer.stripeCustomerId`;
  if NULL creates `stripe.customers.create({ email, name, metadata: { portalCustomerId } })`
  with idempotency key `portal-customer-<id>` and stores it with a conditional
  `updateMany where stripeCustomerId: null` (two concurrent first calls can't create two
  wallets; the loser re-reads). `GET /payment-methods` does **not** create one — no Stripe
  Customer → `{ cards: [], defaultId: null }`.
- **SetupIntent**: `setupIntents.create({ customer, usage: 'off_session',
  payment_method_types: ['card'], metadata: { portalCustomerId } })`. The browser confirms it
  with `stripe.confirmCardSetup(clientSecret, { payment_method: { card, billing_details: { name } } })`
  (3-D Secure handled by Stripe.js). The first saved card becomes default (set on the next
  `GET` if the customer has exactly one card and no default — no webhook needed).
- **publishableKey** comes from new env `STRIPE_PUBLISHABLE_KEY` (`pk_test_…`). Serving it from
  the backend keeps the secret/publishable pair in one place so test/live can never mix; the
  booking app needs no new env var. 503 `STRIPE_NOT_CONFIGURED` when unset (same as today).
- **Ownership** for `:id` routes: `paymentMethods.retrieve(id)` and require
  `pm.customer === customer.stripeCustomerId`; otherwise 404 `NOT_FOUND` (never confirms a
  foreign pm exists). Detach = `paymentMethods.detach`; if it was the default, the next card
  (newest) is promoted.
- **Pay an invoice with a saved card** (`payInvoiceWithSavedCard`, in `core/invoicePayments.ts`):
  1. Same `loadOwnedInvoice` gate as Checkout (404 not yours, 409 paid, 409 zero amount).
  2. Invoice of a still-`PENDING_PAYMENT` booking → **409 `USE_CHECKOUT`** (that first payment
     confirms the booking/occupies the unit through the booking Checkout path; the portal falls
     back to hosted Checkout). Keeps the booking lifecycle single-path.
  3. pm ownership check as above.
  4. `paymentIntents.create({ amount (server-owned, cents), currency: 'sgd', customer, payment_method,
     confirm: true, off_session: false, use_stripe_sdk: true (in-page 3DS modal, no redirect), payment_method_types: ['card'],
     metadata: { kind: 'invoice', invoiceId, invoiceNo, unitCode }, description })` with idempotency
     key `inv-<invoiceId>-<pmId>-<amountCents>` (a double slide reuses the same PI) and an
     in-process `pendingCreates` dedupe like the Checkout path.
  5. Store `Invoice.paymentIntentId` **before** returning. Status mapping →
     `succeeded` | `processing` | `requires_action` (+ `clientSecret` so Stripe.js runs 3DS
     via `handleNextAction`) | card errors → 402 `CARD_DECLINED` with Stripe's customer-safe
     `decline_code` message.
  6. **The response never marks the invoice PAID.** The webhook does.
- **Webhook** (`POST /customer/stripe/webhook`, existing signature check): add
  `payment_intent.succeeded` with `metadata.kind === 'invoice'` →
  `applyInvoicePaymentSucceeded(pi)`: matches `metadata.invoiceId` AND
  `invoice.paymentIntentId === pi.id` (stale/foreign PI can't flip another invoice), conditional
  `DUE|OVERDUE → PAID` write (`method: 'Card'`, `paidAt`, `amountPaid = amount_received/100`),
  idempotent on retries. `payment_intent.payment_failed` → log only. Checkout-created PIs carry no
  `metadata.kind` (Checkout session metadata isn't copied to the PI), so the existing
  `checkout.session.completed` path is untouched.
- **Receipt**: invoice receipts print `cardLast4` when the paid PI's charge exposes it
  (best-effort; null stays as today).
- OpenAPI (`src/lib/openapi.ts`) documents the 5 routes + `SavedCard`; version bump.

## Owner / ops actions (not done by this branch)

1. Add `STRIPE_PUBLISHABLE_KEY` (test `pk_test_…`) to local `.env`, and later to the Lambda env
   (careful `update-function-configuration` — the live env has drifted; never a full CFN deploy).
2. Subscribe the Stripe webhook endpoint (`/api/v1/customer/stripe/webhook`) to
   **`payment_intent.succeeded`** (and `payment_intent.payment_failed`) in addition to
   `checkout.session.completed`. Without it saved-card payments succeed at Stripe but the invoice
   stays DUE until reconciled.
3. Authorize the prod migration when shipping.

## Tests (`pnpm check` + `pnpm test:e2e`, new `tests/e2e/portal-saved-cards.test.ts`)

Hermetic like `portal-invoices.test.ts` (Stripe env cleared):
- every new route 401 without Bearer; `GET /payment-methods` with no Stripe Customer → empty list
  without touching Stripe; gated calls surface 503 `STRIPE_NOT_CONFIGURED` only **after** the
  ownership/status gate (404 foreign invoice, 409 paid invoice, 409 `USE_CHECKOUT` pending booking).
- `applyInvoicePaymentSucceeded` with synthetic PIs: flips the matching invoice once (retry = no-op),
  ignores PI-id mismatch, ignores non-succeeded, never touches bookings/units.
- `toSavedCard` mapper: only the 6 allow-listed fields come out.
- A Stripe-SDK mock (vi.mock) covers pm ownership (foreign pm → 404), detach-promotes-default,
  lazy customer creation race (conditional write).

Local Stripe test-mode verification: real `sk_test` against Stripe's API (4242…, 4000 0025 0000 3155
for 3DS, 4000 0000 0000 9995 decline). There is no `stripe` CLI on this machine, so the webhook leg
is exercised by posting a correctly signed `payment_intent.succeeded` event for the real test PI to
the local webhook (signed with the local test webhook secret via `stripe.webhooks.generateTestHeaderString`),
unless the owner prefers installing the Stripe CLI (`stripe listen`).

## Out of scope

Auto-debit / scheduled off-session charging of recurring invoices (Tenant.autoDebit), using saved
cards in the booking wizard, Apple/Google Pay, live-mode switch.
