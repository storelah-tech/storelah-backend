import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { Prisma, Promotion, PromotionDiscountType, PromotionBenefitType, PromoStatus } from '@prisma/client';

type PromotionWithRelations = Prisma.PromotionGetPayload<{
  include: { applicableSize: true; plan: true };
}>;

export interface PromotionInput {
  code: string;
  name: string;
  description?: string;
  discountType: PromotionDiscountType;
  discountValue: number;
  minMonths?: number;
  applicableSizeId?: string;
  startDate?: Date;
  endDate?: Date;
  active?: boolean;
  planId?: string;
  status?: PromoStatus;
  benefitType?: PromotionBenefitType;
  applyTo?: string;
  usagePerCustomer?: number;
  redemptionCap?: number;
  perUnitApplication?: boolean;
  stackingRule?: string;
  budgetCap?: number;
}

function serialize(p: PromotionWithRelations) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    discountType: p.discountType,
    discountValue: toNum(p.discountValue),
    minMonths: p.minMonths,
    applicableSizeId: p.applicableSizeId,
    applicableSize: p.applicableSize,
    startDate: p.startDate,
    endDate: p.endDate,
    active: p.active,
    planId: p.planId,
    plan: p.plan,
    status: p.status,
    benefitType: p.benefitType,
    applyTo: p.applyTo,
    usagePerCustomer: p.usagePerCustomer,
    redemptionCap: p.redemptionCap,
    perUnitApplication: p.perUnitApplication,
    stackingRule: p.stackingRule,
    budgetCap: p.budgetCap ? toNum(p.budgetCap) : null,
  };
}

export async function listPromotions(opts?: { from?: Date; to?: Date }) {
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (opts?.from) createdAt.gte = opts.from;
  if (opts?.to) createdAt.lte = opts.to;
  const rows = await prisma.promotion.findMany({
    where: createdAt.gte || createdAt.lte ? { createdAt } : undefined,
    include: { applicableSize: true, plan: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serialize);
}

export async function getPromotion(id: string) {
  const promo = await prisma.promotion.findUnique({
    where: { id },
    include: { applicableSize: true, plan: true },
  });
  if (!promo) throw new AppError(404, 'NOT_FOUND', `Promotion ${id} not found`);
  return serialize(promo);
}

export async function createPromotion(input: PromotionInput) {
  const existing = await prisma.promotion.findUnique({ where: { code: input.code } });
  if (existing) throw new AppError(409, 'CONFLICT', `Promotion code ${input.code} already exists`);

  const promo = await prisma.promotion.create({
    data: {
      code: input.code,
      name: input.name,
      description: input.description,
      discountType: input.discountType,
      discountValue: input.discountValue,
      minMonths: input.minMonths,
      applicableSizeId: input.applicableSizeId,
      startDate: input.startDate,
      endDate: input.endDate,
      active: input.active ?? true,
      planId: input.planId,
      status: input.status,
      benefitType: input.benefitType,
      applyTo: input.applyTo,
      usagePerCustomer: input.usagePerCustomer,
      redemptionCap: input.redemptionCap,
      perUnitApplication: input.perUnitApplication,
      stackingRule: input.stackingRule,
      budgetCap: input.budgetCap,
    },
    include: { applicableSize: true, plan: true },
  });
  return serialize(promo);
}

export async function updatePromotion(id: string, input: Partial<PromotionInput>) {
  const existing = await prisma.promotion.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion ${id} not found`);

  if (input.code && input.code !== existing.code) {
    const clash = await prisma.promotion.findUnique({ where: { code: input.code } });
    if (clash) throw new AppError(409, 'CONFLICT', `Promotion code ${input.code} already exists`);
  }

  const promo = await prisma.promotion.update({
    where: { id },
    data: {
      code: input.code,
      name: input.name,
      description: input.description,
      discountType: input.discountType,
      discountValue: input.discountValue,
      minMonths: input.minMonths,
      applicableSizeId: input.applicableSizeId,
      startDate: input.startDate,
      endDate: input.endDate,
      active: input.active,
      planId: input.planId,
      status: input.status,
      benefitType: input.benefitType,
      applyTo: input.applyTo,
      usagePerCustomer: input.usagePerCustomer,
      redemptionCap: input.redemptionCap,
      perUnitApplication: input.perUnitApplication,
      stackingRule: input.stackingRule,
      budgetCap: input.budgetCap,
    },
    include: { applicableSize: true, plan: true },
  });
  return serialize(promo);
}

export async function deletePromotion(id: string) {
  const existing = await prisma.promotion.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion ${id} not found`);
  await prisma.promotion.delete({ where: { id } });
  return { id };
}

// --- Additive promo type/scope helpers (live promo demo slice) ---
//
// The booking frontend parses a tolerant set of tokens:
//   type: PERCENTAGE | DOLLAR | FLAT | CREDITS
//   scope: FIRST_MONTH | ONE_TIME | DUE_TODAY (anything else = recurring).
// These helpers derive those tokens from the stored Promotion (+ its backing
// PromotionPlan when present). Discount math is intentionally untouched.

type PromoTypeSource = {
  discountType: Promotion['discountType'];
  benefitType: Promotion['benefitType'];
  plan?: { kind: string; appliesTo: string | null } | null;
};

function resolvePromoType(p: PromoTypeSource): string {
  if (p.benefitType === 'CREDITS' || p.plan?.kind === 'CREDITS') return 'CREDITS';
  if (p.benefitType === 'DOLLAR') return 'DOLLAR';
  return p.discountType === 'PERCENTAGE' ? 'PERCENTAGE' : 'FLAT';
}

function normalizeDurationScope(raw: string | null | undefined): string {
  const s = (raw ?? '').toLowerCase();
  if (/every invoice|recurr|can combine/.test(s)) return 'RECURRING';
  if (/due today|due-today|today|upfront|move-?in/.test(s)) return 'DUE_TODAY';
  if (/one-?time|single/.test(s)) return 'ONE_TIME';
  return 'FIRST_MONTH';
}

function resolvePromoScope(p: PromoTypeSource): string {
  return normalizeDurationScope(p.plan?.appliesTo ?? (p as { applyTo?: string | null }).applyTo ?? null);
}

// Defaults used when no promo row can be resolved (unknown / inactive /
// out-of-window / below-minMonths / malformed body). Shape stays stable so
// the frontend can always read the additive fields.
export const DEFAULT_PROMO_TYPE = 'PERCENTAGE';
export const DEFAULT_PROMO_SCOPE = 'FIRST_MONTH';

function isWithinWindow(p: Promotion, now = new Date()): boolean {
  if (!p.active) return false;
  if (p.startDate && p.startDate > now) return false;
  if (p.endDate && p.endDate < now) return false;
  return true;
}

// Customer-facing list: only active promotions inside their date window.
// Additive type/scope fields ride along (sourced from the promo row, falling
// back to the backing plan's appliesTo when present).
export async function listActivePromotions() {
  const now = new Date();
  const rows = await prisma.promotion.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: now } }] },
        { OR: [{ endDate: null }, { endDate: { gte: now } }] },
      ],
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((p) => {
    const scope = resolvePromoScope(p);
    return {
      code: p.code,
      name: p.name,
      description: p.description,
      discountType: p.discountType,
      discountValue: toNum(p.discountValue),
      minMonths: p.minMonths,
      type: resolvePromoType(p),
      appliesTo: scope,
      durationScope: scope,
    };
  });
}

export interface PromotionValidationResult {
  valid: boolean;
  discountAmt: number;
  monthlyAfterPromo: number;
  // Additive (live promo demo slice): tolerant tokens for the booking
  // frontend. Always present, including on the invalid path.
  type: string;
  appliesTo: string;
  durationScope: string;
}

// Returns { valid: false } (not an error) for unknown / inactive / out-of-window
// / below-minMonths codes. STORELAH10 → discountAmt = 10% of rate.
// Discount math is unchanged; only the additive type/scope fields are new.
export async function validatePromotion(code: string, rate: number, months: number): Promise<PromotionValidationResult> {
  const invalid = {
    valid: false,
    discountAmt: 0,
    monthlyAfterPromo: toNum(rate),
    type: DEFAULT_PROMO_TYPE,
    appliesTo: DEFAULT_PROMO_SCOPE,
    durationScope: DEFAULT_PROMO_SCOPE,
  };
  // Include the backing plan so plan-backed codes resolve type/scope from it.
  const promo = await prisma.promotion.findUnique({ where: { code }, include: { plan: true } });
  if (!promo || !isWithinWindow(promo)) return invalid;
  if (promo.minMonths != null && months < promo.minMonths) return invalid;

  const value = toNum(promo.discountValue);
  const discountAmt =
    promo.discountType === 'PERCENTAGE'
      ? toNum((rate * value) / 100)
      : toNum(Math.min(value, rate));

  const scope = resolvePromoScope(promo);
  return {
    valid: true,
    discountAmt,
    monthlyAfterPromo: toNum(rate - discountAmt),
    type: resolvePromoType(promo),
    appliesTo: scope,
    durationScope: scope,
  };
}
