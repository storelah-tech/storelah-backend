import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, fail } from '../lib/http';
import { listPublicBranches } from '../core/branches';
import { getUnitMap, listPublicUnits } from '../core/units';
import { listActivePromotions, validatePromotion } from '../core/promotions';
import { getPublicFloorPlan } from '../core/floorPlans';

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
  ok(res, await getUnitMap(branch, level, { public: true }));
});

// PUBLIC floor-plan read for the future booking renderer (see FLOOR_PLAN_MODEL.md
// "Forward compatibility"). Additive contract: branch + floor + plan canvas
// (width/height/legacy structure) + blocks (name+rect decorations) + placements
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
    const rate = typeof req.body?.rate === 'number' ? req.body.rate : 0;
    ok(res, { valid: false, discountAmt: 0, monthlyAfterPromo: rate });
    return;
  }
  ok(res, await validatePromotion(parsed.data.code, parsed.data.rate, parsed.data.months));
});

export default router;
