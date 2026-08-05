import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { Prisma, Promotion, PromotionDiscountType } from '@prisma/client';

type PromotionWithRelations = Prisma.PromotionGetPayload<{
  include: { applicableSize: true };
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
  };
}

export async function listPromotions() {
  const rows = await prisma.promotion.findMany({
    include: { applicableSize: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serialize);
}

export async function getPromotion(id: string) {
  const promo = await prisma.promotion.findUnique({
    where: { id },
    include: { applicableSize: true },
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
    },
    include: { applicableSize: true },
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
    },
    include: { applicableSize: true },
  });
  return serialize(promo);
}

export async function deletePromotion(id: string) {
  const existing = await prisma.promotion.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion ${id} not found`);
  await prisma.promotion.delete({ where: { id } });
  return { id };
}

function isWithinWindow(p: Promotion, now = new Date()): boolean {
  if (!p.active) return false;
  if (p.startDate && p.startDate > now) return false;
  if (p.endDate && p.endDate < now) return false;
  return true;
}

// Customer-facing list: only active promotions inside their date window.
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
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((p) => ({
    code: p.code,
    name: p.name,
    description: p.description,
    discountType: p.discountType,
    discountValue: toNum(p.discountValue),
    minMonths: p.minMonths,
  }));
}

export interface PromotionValidationResult {
  valid: boolean;
  discountAmt: number;
  monthlyAfterPromo: number;
}

// Returns { valid: false } (not an error) for unknown / inactive / out-of-window
// / below-minMonths codes. STORELAH10 → discountAmt = 10% of rate.
export async function validatePromotion(code: string, rate: number, months: number): Promise<PromotionValidationResult> {
  const invalid = { valid: false, discountAmt: 0, monthlyAfterPromo: toNum(rate) };
  const promo = await prisma.promotion.findUnique({ where: { code } });
  if (!promo || !isWithinWindow(promo)) return invalid;
  if (promo.minMonths != null && months < promo.minMonths) return invalid;

  const value = toNum(promo.discountValue);
  const discountAmt =
    promo.discountType === 'PERCENTAGE'
      ? toNum((rate * value) / 100)
      : toNum(Math.min(value, rate));

  return {
    valid: true,
    discountAmt,
    monthlyAfterPromo: toNum(rate - discountAmt),
  };
}
