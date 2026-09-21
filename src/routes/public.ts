import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, fail } from '../lib/http';
import { listPublicBranches } from '../core/branches';
import { getUnitMap, listPublicUnits } from '../core/units';
import { listActivePromotions, validatePromotion, DEFAULT_PROMO_TYPE, DEFAULT_PROMO_SCOPE } from '../core/promotions';
import { listActivePublicPromotionPlans } from '../core/promotionPlans';
import { getPublicFloorPlan } from '../core/floorPlans';
import { listProtectionPlans, listAddons } from '../core/extras';

const router = Router();

router.get('/branches', async (_req: Request, res: Response) => {
  ok(res, await listPublicBranches());
});

const listUnitsSchema = z.object({
  branch: z.string().min(1).optional(),
  level: z.coerce.number().int().optional(),
  status: z.enum(['AVAILABLE', 'RESERVED']).optional(),
});

router.get('/units', async (req: Request, res: Response) => {
  const parsed = listUnitsSchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid units query', parsed.error.flatten());
    return;
  }
  const { units, branches } = await listPublicUnits(parsed.data);
  ok(res, units, { count: units.length, branches });
});

router.get('/units/map', async (req: Request, res: Response) => {
  const branch = (req.query.branch as string) || 'BM';
  const level = Number(req.query.level) || 1;
  // Additive size/near-lift filters — same contract as the admin map read path
  // (GET /api/v1/cms/units/map). Omitted by default so the BM/L1 response keeps
  // every existing key; booking readers ignore the new `sizes`/`sizeInfo` keys.
  const size = typeof req.query.size === 'string' && req.query.size.trim() ? req.query.size.trim() : undefined;
  const nearLift = req.query.nearLift === '1' || req.query.nearLift === 'true';
  ok(res, await getUnitMap(branch, level, { public: true, ...(size ? { size } : {}), ...(nearLift ? { nearLift: true } : {}) }));
});

// PUBLIC floor-plan read for the future booking renderer (see FLOOR_PLAN_MODEL.md
// "Forward compatibility"). Additive contract: branch + floor + plan canvas
// (width/height/legacy structure) + blocks (name+rect decorations) +
// boundaries (facility-boundary line-item polylines) + boundaryMetrics
// ({ gla, ufa, nla, unit, boundaryClosed } derived from CLOSED loops; all-zero
// with boundaryClosed: false when no loop is closed) + placements
// joined to unit unitCode/name/size/status, soft-deleted units filtered out.
// No tenant/PII anywhere.
router.get('/floor-plans/:branchCode/:level', async (req: Request, res: Response) => {
  const branchCode = String(req.params.branchCode).toUpperCase();
  const level = Number(req.params.level);
  if (!Number.isInteger(level) || level < 1) {
    fail(res, 400, 'VALIDATION', 'Invalid floor level');
    return;
  }
  ok(res, await getPublicFloorPlan(branchCode, level));
});

router.get('/promotions', async (_req: Request, res: Response) => {
  ok(res, await listActivePromotions());
});

const validateSchema = z.object({
  code: z.string().min(1),
  rate: z.number().nonnegative(),
  months: z.number().int().positive().default(1),
});

router.post('/promotions/validate', async (req: Request, res: Response) => {
  const parsed = validateSchema.safeParse(req.body);
  if (!parsed.success) {
    // Invalid input is reported as an invalid promo, not an error response.
    // Additive type/scope fields ride along with stable defaults.
    const rate = typeof req.body?.rate === 'number' ? req.body.rate : 0;
    ok(res, {
      valid: false,
      discountAmt: 0,
      monthlyAfterPromo: rate,
      type: DEFAULT_PROMO_TYPE,
      appliesTo: DEFAULT_PROMO_SCOPE,
      durationScope: DEFAULT_PROMO_SCOPE,
    });
    return;
  }
  ok(res, await validatePromotion(parsed.data.code, parsed.data.rate, parsed.data.months));
});

// PUBLIC discount-plan matrix for the booking frontend Expected Stay tiles
// (size × 1/3/6/12 months). Additive: ACTIVE plans only (DRAFT / SCHEDULED /
// ENDED excluded), honest empty array when none is ACTIVE. No auth. Legacy
// GET /promotions + POST /promotions/validate are untouched above.
// PUBLIC booking-extras catalog for the booking frontend (unauthenticated).
// Additive: active rows only, sortOrder ascending, envelope { data, meta }.
// ProtectionPlan: { id, name, price (monthly recurring), coverage, sortOrder,
// active } — Addon: { id, name, price (one-off), unit, sortOrder, active }.
// `id` is the stable frontend slug so the app can fall back to its baked-in
// copy when a row is missing. No auth, no PII.
router.get('/protection-plans', async (_req: Request, res: Response) => {
  const rows = await listProtectionPlans({ activeOnly: true });
  ok(res, rows, { count: rows.length });
});

router.get('/addons', async (_req: Request, res: Response) => {
  const rows = await listAddons({ activeOnly: true });
  ok(res, rows, { count: rows.length });
});

router.get('/promotion-plans', async (_req: Request, res: Response) => {
  ok(res, await listActivePublicPromotionPlans());
});

export default router;
