// Booking extras catalog — protection tiers + packing-supply addons.
//
// CMS-editable catalog for the booking flow (see the ProtectionPlan/Addon
// models in prisma/schema.prisma). Reads are sorted by sortOrder ascending;
// public reads filter active=true. `id` is the stable frontend slug, so the
// booking app falls back to its baked-in copy when a row is missing.
// Deactivation (active=false) is preferred over hard delete — bookings
// snapshot tier/cost + addon name/qty/price as free text, so catalog edits
// never rewrite history. No PII anywhere on these rows.
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { Prisma } from '@prisma/client';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertSlug(id: string, kind: string) {
  if (!SLUG_RE.test(id)) {
    throw new AppError(
      400,
      'VALIDATION',
      `${kind} id must be a URL-safe slug (lowercase letters, numbers, hyphens, e.g. "essential", "medium-box").`,
    );
  }
}

type PlanRow = Prisma.ProtectionPlanGetPayload<Record<string, never>>;
type AddonRow = Prisma.AddonGetPayload<Record<string, never>>;

function serializePlan(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    price: toNum(p.price),
    coverage: p.coverage,
    sortOrder: p.sortOrder,
    active: p.active,
  };
}

function serializeAddon(a: AddonRow) {
  return {
    id: a.id,
    name: a.name,
    price: toNum(a.price),
    unit: a.unit,
    sortOrder: a.sortOrder,
    active: a.active,
  };
}

// --- Protection plans ---

export interface ProtectionPlanInput {
  id: string;
  name: string;
  price: number;
  coverage?: string | null;
  sortOrder?: number;
  active?: boolean;
}

export async function listProtectionPlans(opts: { activeOnly?: boolean } = {}) {
  const rows = await prisma.protectionPlan.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  return rows.map(serializePlan);
}

export async function createProtectionPlan(input: ProtectionPlanInput) {
  assertSlug(input.id, 'Protection plan');
  const existing = await prisma.protectionPlan.findUnique({ where: { id: input.id } });
  if (existing) throw new AppError(409, 'CONFLICT', `Protection plan ${input.id} already exists`);
  const row = await prisma.protectionPlan.create({
    data: {
      id: input.id,
      name: input.name.trim(),
      price: input.price,
      coverage: input.coverage?.trim() || null,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    },
  });
  return serializePlan(row);
}

export async function updateProtectionPlan(id: string, input: Partial<Omit<ProtectionPlanInput, 'id'>>) {
  const existing = await prisma.protectionPlan.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Protection plan ${id} not found`);
  const row = await prisma.protectionPlan.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.coverage !== undefined ? { coverage: input.coverage?.trim() || null } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  return serializePlan(row);
}

export async function deleteProtectionPlan(id: string) {
  const existing = await prisma.protectionPlan.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Protection plan ${id} not found`);
  await prisma.protectionPlan.delete({ where: { id } });
  return { id };
}

// --- Addons (packing supplies) ---

export interface AddonInput {
  id: string;
  name: string;
  price: number;
  unit?: string | null;
  sortOrder?: number;
  active?: boolean;
}

export async function listAddons(opts: { activeOnly?: boolean } = {}) {
  const rows = await prisma.addon.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  return rows.map(serializeAddon);
}

export async function createAddon(input: AddonInput) {
  assertSlug(input.id, 'Addon');
  const existing = await prisma.addon.findUnique({ where: { id: input.id } });
  if (existing) throw new AppError(409, 'CONFLICT', `Addon ${input.id} already exists`);
  const row = await prisma.addon.create({
    data: {
      id: input.id,
      name: input.name.trim(),
      price: input.price,
      unit: input.unit?.trim() || null,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    },
  });
  return serializeAddon(row);
}

export async function updateAddon(id: string, input: Partial<Omit<AddonInput, 'id'>>) {
  const existing = await prisma.addon.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Addon ${id} not found`);
  const row = await prisma.addon.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.unit !== undefined ? { unit: input.unit?.trim() || null } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  return serializeAddon(row);
}

export async function deleteAddon(id: string) {
  const existing = await prisma.addon.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Addon ${id} not found`);
  await prisma.addon.delete({ where: { id } });
  return { id };
}

// --- Seed data (mirrors the booking app's baked-in fallback copy) ---
//
// Canonical catalog: 4 protection tiers + 6 packing-supply addons. Prices are
// the contract — names/prices must stay consistent with the frontend fallback.
// Seeded via idempotent upsert by id/slug in prisma/seed.ts (upsert only,
// never deleteMany on a shared DB).

export const SEED_PROTECTION_PLANS: ProtectionPlanInput[] = [
  { id: 'essential', name: 'Essential', price: 4, coverage: 'Basic protection for everyday stored items.', sortOrder: 1, active: true },
  { id: 'standard', name: 'Standard', price: 20, coverage: 'Standard protection for most storage needs.', sortOrder: 2, active: true },
  { id: 'enhanced', name: 'Enhanced', price: 40, coverage: 'Enhanced protection for higher-value items.', sortOrder: 3, active: true },
  { id: 'premium', name: 'Premium', price: 80, coverage: 'Premium protection for maximum cover.', sortOrder: 4, active: true },
];

export const SEED_ADDONS: AddonInput[] = [
  { id: 'medium-box', name: 'Medium Box', price: 3.5, unit: 'box', sortOrder: 1, active: true },
  { id: 'large-box', name: 'Large Box', price: 5, unit: 'box', sortOrder: 2, active: true },
  { id: 'disc-padlock', name: 'Disc Padlock', price: 18.9, unit: 'each', sortOrder: 3, active: true },
  { id: 'bubble-wrap', name: 'Bubble Wrap', price: 6.5, unit: 'roll', sortOrder: 4, active: true },
  { id: 'mattress-bag', name: 'Mattress Bag', price: 12.9, unit: 'bag', sortOrder: 5, active: true },
  { id: 'trolley', name: 'Trolley', price: 15, unit: 'rental', sortOrder: 6, active: true },
];

export async function seedExtras() {
  for (const p of SEED_PROTECTION_PLANS) {
    await prisma.protectionPlan.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        name: p.name,
        price: p.price,
        coverage: p.coverage ?? null,
        sortOrder: p.sortOrder ?? 0,
        active: p.active ?? true,
      },
      update: {
        name: p.name,
        price: p.price,
        coverage: p.coverage ?? null,
        sortOrder: p.sortOrder ?? 0,
        active: p.active ?? true,
      },
    });
  }
  for (const a of SEED_ADDONS) {
    await prisma.addon.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        name: a.name,
        price: a.price,
        unit: a.unit ?? null,
        sortOrder: a.sortOrder ?? 0,
        active: a.active ?? true,
      },
      update: {
        name: a.name,
        price: a.price,
        unit: a.unit ?? null,
        sortOrder: a.sortOrder ?? 0,
        active: a.active ?? true,
      },
    });
  }
  const [plans, addons] = await Promise.all([
    prisma.protectionPlan.count(),
    prisma.addon.count(),
  ]);
  return { plans, addons };
}
