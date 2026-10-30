// Portal saved payment cards (Stripe, TEST MODE) — docs/SAVED_CARDS_PLAN.md.
//
// The wallet IS the Stripe Customer: each portal Customer gets at most one
// Stripe Customer (Customer.stripeCustomerId, created lazily on the first
// SetupIntent) and its attached card PaymentMethods are the saved cards. The
// default card is Stripe's customer.invoice_settings.default_payment_method.
//
// Card entry happens in Stripe Elements in the browser (confirmCardSetup with
// the SetupIntent client secret), so card digits never reach this server. What
// leaves here is the allow-listed SavedCard shape only (toSavedCard) — never a
// spread Stripe object (fingerprint, billing address, funding stay server-side).
//
// Ownership: a PaymentMethod belongs to the caller when pm.customer equals the
// caller's stripeCustomerId. Anything else is the same 404 as "missing" so a
// foreign pm id is never confirmed to exist.

import type Stripe from 'stripe';
import type { Customer } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import type { CustomerJwtPayload } from '../middleware/auth';
import { getStripe } from './checkout';
import { loadCustomer } from './customers';

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export interface Wallet {
  cards: SavedCard[];
  defaultId: string | null;
}

/** Explicit allow-list mapper: the only card fields that ever leave the server. */
export function toSavedCard(pm: Pick<Stripe.PaymentMethod, 'id' | 'card'>, defaultId: string | null): SavedCard | null {
  const card = pm.card;
  if (!card) return null;
  return {
    id: pm.id,
    brand: String(card.brand ?? 'unknown'),
    last4: String(card.last4 ?? ''),
    expMonth: Number(card.exp_month),
    expYear: Number(card.exp_year),
    isDefault: pm.id === defaultId,
  };
}

/**
 * Publishable key served to the portal (Stripe.js). Kept next to the secret
 * key in the backend env so test/live can never mix: a pk_test with an
 * sk_live (or vice versa) is treated as not configured.
 */
export function getPublishableKey(): string {
  const pk = process.env.STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
  const sk = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
  const pkMode = pk.startsWith('pk_test_') ? 'test' : pk.startsWith('pk_live_') ? 'live' : null;
  const skMode = /^(sk|rk)_test_/.test(sk) ? 'test' : /^(sk|rk)_live_/.test(sk) ? 'live' : null;
  if (!pkMode || pkMode !== skMode) {
    throw new AppError(
      503,
      'STRIPE_NOT_CONFIGURED',
      'Stripe is not configured (STRIPE_PUBLISHABLE_KEY is missing or does not match the secret key mode)',
    );
  }
  return pk;
}

function defaultIdOf(sc: Stripe.Customer | Stripe.DeletedCustomer): string | null {
  if ('deleted' in sc && sc.deleted) return null;
  const d = (sc as Stripe.Customer).invoice_settings?.default_payment_method;
  if (!d) return null;
  return typeof d === 'string' ? d : d.id;
}

/**
 * The caller's Stripe Customer id, creating it on first use. Concurrency-safe:
 * the Stripe create is idempotent per portal customer and the DB write is
 * conditional on the column still being NULL (the loser re-reads the winner).
 */
export async function ensureStripeCustomer(customer: Customer): Promise<string> {
  if (customer.stripeCustomerId) return customer.stripeCustomerId;
  const created = await getStripe().customers.create(
    {
      email: customer.email,
      name: customer.name || undefined,
      metadata: { portalCustomerId: customer.id },
    },
    { idempotencyKey: `portal-customer-${customer.id}` },
  );
  const won = await prisma.customer.updateMany({
    where: { id: customer.id, stripeCustomerId: null },
    data: { stripeCustomerId: created.id },
  });
  if (won.count > 0) return created.id;
  const fresh = await prisma.customer.findUnique({ where: { id: customer.id } });
  if (!fresh?.stripeCustomerId) throw new AppError(500, 'INTERNAL', 'Could not link the payment wallet');
  return fresh.stripeCustomerId;
}

async function readWallet(stripeCustomerId: string): Promise<Wallet> {
  const stripe = getStripe();
  const [sc, list] = await Promise.all([
    stripe.customers.retrieve(stripeCustomerId),
    stripe.customers.listPaymentMethods(stripeCustomerId, { type: 'card', limit: 20 }),
  ]);
  let defaultId = defaultIdOf(sc);
  const pms = list.data;
  // The first saved card becomes the default (no webhook needed); a default
  // that was detached elsewhere falls back to the newest card.
  if (pms.length > 0 && (!defaultId || !pms.some((p) => p.id === defaultId))) {
    defaultId = pms[0].id;
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: defaultId },
    });
  }
  if (pms.length === 0) defaultId = null;
  const cards = pms.map((p) => toSavedCard(p, defaultId)).filter((c): c is SavedCard => c !== null);
  return { cards, defaultId };
}

/** GET /payment-methods — never creates a Stripe Customer. */
export async function listSavedCards(caller: CustomerJwtPayload): Promise<Wallet & { publishableKey: string | null }> {
  const customer = await loadCustomer(caller);
  if (!customer.stripeCustomerId) return { cards: [], defaultId: null, publishableKey: publishableKeyOrNull() };
  return { ...(await readWallet(customer.stripeCustomerId)), publishableKey: publishableKeyOrNull() };
}

function publishableKeyOrNull(): string | null {
  try {
    return getPublishableKey();
  } catch {
    return null;
  }
}

/** POST /payment-methods/setup-intent — client secret for Elements confirmCardSetup. */
export async function createCardSetupIntent(
  caller: CustomerJwtPayload,
): Promise<{ clientSecret: string; publishableKey: string }> {
  const publishableKey = getPublishableKey();
  const customer = await loadCustomer(caller);
  const stripeCustomerId = await ensureStripeCustomer(customer);
  const si = await getStripe().setupIntents.create({
    customer: stripeCustomerId,
    usage: 'off_session',
    payment_method_types: ['card'],
    metadata: { portalCustomerId: customer.id },
  });
  if (!si.client_secret) throw new AppError(500, 'INTERNAL', 'Stripe did not return a setup secret');
  return { clientSecret: si.client_secret, publishableKey };
}

/**
 * Card PaymentMethod owned by the caller, or 404. Used by set-default,
 * detach and the saved-card invoice payment.
 */
export async function loadOwnedPaymentMethod(
  customer: Customer,
  paymentMethodId: string,
): Promise<{ pm: Stripe.PaymentMethod; stripeCustomerId: string }> {
  const notFound = new AppError(404, 'NOT_FOUND', 'Card not found');
  if (!customer.stripeCustomerId || !/^pm_[A-Za-z0-9_]+$/.test(paymentMethodId)) throw notFound;
  let pm: Stripe.PaymentMethod;
  try {
    pm = await getStripe().paymentMethods.retrieve(paymentMethodId);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw notFound;
  }
  const owner = typeof pm.customer === 'string' ? pm.customer : (pm.customer?.id ?? null);
  if (owner !== customer.stripeCustomerId || pm.type !== 'card') throw notFound;
  return { pm, stripeCustomerId: customer.stripeCustomerId };
}

/** POST /payment-methods/:id/default */
export async function setDefaultCard(caller: CustomerJwtPayload, paymentMethodId: string): Promise<Wallet> {
  const customer = await loadCustomer(caller);
  const { pm, stripeCustomerId } = await loadOwnedPaymentMethod(customer, paymentMethodId);
  await getStripe().customers.update(stripeCustomerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return readWallet(stripeCustomerId);
}

/** DELETE /payment-methods/:id — a removed default promotes the newest remaining card. */
export async function removeCard(caller: CustomerJwtPayload, paymentMethodId: string): Promise<Wallet> {
  const customer = await loadCustomer(caller);
  const { pm, stripeCustomerId } = await loadOwnedPaymentMethod(customer, paymentMethodId);
  await getStripe().paymentMethods.detach(pm.id);
  return readWallet(stripeCustomerId);
}
