import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ok, created, fail, AppError } from '../lib/http';
import { resolveHostKind } from '../lib/host';
import { requireAuth, signToken } from '../middleware/auth';
import { getSummary } from '../core/summary';
import {
  getUnitMap,
  getUnitDetail,
  listUnits,
  createUnit,
  updateUnit,
  softDeleteUnit,
  listFloors,
  listSizes,
  getUnitActivity,
} from '../core/units';
import { listTenants, createTenant, updateTenant, deactivateTenant } from '../core/tenants';
import { listLeads, getLeadStats } from '../core/leads';
import { getActionItems } from '../core/actionCenter';
import { listBookings, listInvoices } from '../core/finance';
import { listBranches, getMoveIns } from '../core/branches';
import { adjustRate } from '../core/rates';
import {
  listPromotions,
  getPromotion,
  createPromotion,
  updatePromotion,
  deletePromotion,
} from '../core/promotions';
import {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  setPlanStatus,
  duplicatePlan,
  deletePlan,
  validatePlan,
  listSafeguards,
  createSafeguard,
  updateSafeguard,
  deleteSafeguard,
} from '../core/promotionPlans';
import { listAppointments } from '../core/appointments';
import {
  upsertFloorPlan,
  getFloorPlan,
  listFloorPlans,
  setUnitPlacement,
  removeUnitPlacement,
  deleteFloorPlan,
  createFloorPlanBlock,
  setFloorPlanBlock,
  removeFloorPlanBlock,
} from '../core/floorPlans';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const adjustRateSchema = z.object({
  newRate: z.number().positive(),
  effectiveDate: z.string().optional(),
  reason: z.string().optional(),
  appliedBy: z.string().optional(),
});

const createUnitSchema = z.object({
  branchId: z.string().min(1),
  floorId: z.string().min(1),
  sizeId: z.string().min(1),
  sqft: z.number().positive(),
  monthlyRate: z.number().nonnegative(),
  status: z.enum(['AVAILABLE', 'RESERVED', 'MAINTENANCE', 'INACTIVE']).optional(),
  climateControl: z.string().optional(),
  name: z.string().trim().max(80).optional(),
});

const updateUnitSchema = z.object({
  sqft: z.number().positive().optional(),
  monthlyRate: z.number().nonnegative().optional(),
  status: z
    .enum(['OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE', 'INACTIVE'])
    .optional(),
  climateControl: z.string().nullable().optional(),
  name: z.string().trim().max(80).nullable().optional(),
});

const unitListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
  status: z
    .enum(['OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE', 'INACTIVE'])
    .optional(),
  branch: z.string().trim().min(1).optional(),
  level: z.coerce.number().int().min(1).optional(),
});

const unitActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createTenantSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['PERSONAL', 'BUSINESS']).optional(),
  segment: z.string().optional(),
  email: z.string().email().optional(),
  mobile: z.string().optional(),
  unitId: z.string().optional(),
  moveInDate: z.string().datetime().optional(),
  monthlyRate: z.number().nonnegative(),
  sqft: z.number().positive().optional(),
  status: z.enum(['ACTIVE', 'DUE_SOON', 'OVERDUE', 'NOTICE']).optional(),
  autoDebit: z.boolean().optional(),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(['PERSONAL', 'BUSINESS']).optional(),
  segment: z.string().nullable().optional(),
  email: z.string().email().optional(),
  mobile: z.string().nullable().optional(),
  unitId: z.string().nullable().optional(),
  monthlyRate: z.number().nonnegative().optional(),
  status: z.enum(['ACTIVE', 'DUE_SOON', 'OVERDUE', 'NOTICE']).optional(),
  autoDebit: z.boolean().optional(),
});

const createPromotionSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  discountType: z.enum(['PERCENTAGE', 'FLAT']).default('PERCENTAGE'),
  discountValue: z.number().nonnegative(),
  minMonths: z.number().int().positive().optional(),
  applicableSizeId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  active: z.boolean().optional(),
});

const updatePromotionSchema = createPromotionSchema.partial();

const floorPlanCanvasSchema = z.object({
  width: z.number().int().min(1).max(500).optional(),
  height: z.number().int().min(1).max(500).optional(),
  structure: z.unknown().nullable().optional(), // arbitrary JSONB decorations
});

const floorPlanListQuerySchema = z.object({
  branch: z.string().trim().min(1).optional(),
  level: z.coerce.number().int().min(1).optional(),
});

const floorPlanPlacementSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});

const floorPlanBlockSchema = z.object({
  name: z.string().trim().min(1).max(80), // operator label: "Lift", "Stair", "Walking area", ...
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  color: z.string().trim().max(20).nullish(), // optional render tint (hex)
});

router.get('/config', (req: Request, res: Response) => {
  // Security gate (deploy runbook "Phase 0 step 4 — SECURITY FLAG"): this endpoint
  // hands the CMS dashboard its live login credentials, so it must never be
  // reachable from a PUBLIC host. It is allowed ONLY on the cms host
  // (cms.storelah.sg) and local dev (localhost / loopback — classified 'cms').
  // Every other host (api.storelah.sg, the raw execute-api invoke URL, any
  // unknown/forged host) gets a 404.
  //
  // Deliberately host-kind-based and NOT NODE_ENV-based: the gate must not
  // silently deactivate if NODE_ENV is missing/misconfigured at Lambda runtime
  // (the original prod-flag version was bypassed in exactly that way on the live
  // function). The only legitimate consumers of /config are the dashboard on its
  // own host and local dev, neither of which ever arrive via an api-kind host.
  // The booking app never calls it.
  if (resolveHostKind(req) === 'api') {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }
  const email = process.env.STORELAH_ADMIN_EMAIL;
  const password = process.env.STORELAH_ADMIN_PASSWORD;
  if (!email || !password) {
    res.status(503).json({ error: 'Admin credentials not configured' });
    return;
  }
  res.json({ email, password });
});

router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid credentials', parsed.error.flatten());
    return;
  }
  const admin = await prisma.adminUser.findUnique({ where: { email: parsed.data.email } });
  if (!admin || !(await bcrypt.compare(parsed.data.password, admin.passwordHash))) {
    fail(res, 401, 'UNAUTHORIZED', 'Invalid email or password');
    return;
  }
  ok(res, { token: signToken(admin), user: { email: admin.email, name: admin.name, role: admin.role } });
});

router.get('/summary', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getSummary());
});

router.get('/units/map', requireAuth, async (req: Request, res: Response) => {
  const branch = (req.query.branch as string) || 'BM';
  const level = Number(req.query.level) || 1;
  ok(res, await getUnitMap(branch, level));
});

router.get('/units', requireAuth, async (req: Request, res: Response) => {
  const parsed = unitListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid unit query', parsed.error.flatten());
    return;
  }
  const { rows, meta } = await listUnits(parsed.data);
  ok(res, rows, meta);
});

// NOTE: must be registered before GET /units/:code so "activity" isn't parsed as a unit code.
router.get('/units/activity', requireAuth, async (req: Request, res: Response) => {
  const parsed = unitActivityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid activity query', parsed.error.flatten());
    return;
  }
  const items = await getUnitActivity(parsed.data.limit);
  ok(res, items, { count: items.length });
});

router.post('/units', requireAuth, async (req: Request, res: Response) => {
  const parsed = createUnitSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid unit payload', parsed.error.flatten());
    return;
  }
  created(res, await createUnit(parsed.data));
});

router.put('/units/:code', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateUnitSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid unit payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateUnit(String(req.params.code), parsed.data));
});

router.delete('/units/:code', requireAuth, async (req: Request, res: Response) => {
  ok(res, await softDeleteUnit(String(req.params.code)));
});

router.get('/units/:code', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getUnitDetail(String(req.params.code)));
});

router.post('/units/:code/rate', requireAuth, async (req: Request, res: Response) => {
  const parsed = adjustRateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid rate adjustment', parsed.error.flatten());
    return;
  }
  const appliedBy = (req as any).user?.name ?? 'Operator';
  created(res, await adjustRate(String(req.params.code), { ...parsed.data, appliedBy }));
});

router.get('/tenants', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listTenants();
  ok(res, rows, { count: rows.length });
});

router.post('/tenants', requireAuth, async (req: Request, res: Response) => {
  const parsed = createTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid tenant payload', parsed.error.flatten());
    return;
  }
  const input = {
    ...parsed.data,
    moveInDate: parsed.data.moveInDate ? new Date(parsed.data.moveInDate) : undefined,
  };
  created(res, await createTenant(input));
});

router.put('/tenants/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid tenant payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateTenant(String(req.params.id), parsed.data));
});

router.delete('/tenants/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deactivateTenant(String(req.params.id)));
});

router.get('/leads', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await listLeads());
});

// Lead funnel / source stats for the command centre and pipeline header.
router.get('/leads/stats', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getLeadStats());
});

router.get('/bookings', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listBookings();
  ok(res, rows, { count: rows.length });
});

router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
  const rows = await listInvoices(typeof req.query.status === 'string' ? req.query.status : undefined);
  ok(res, rows, { count: rows.length });
});

router.get('/branches', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await listBranches());
});

router.get('/floors', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listFloors();
  ok(res, rows, { count: rows.length });
});

router.get('/sizes', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listSizes();
  ok(res, rows, { count: rows.length });
});

router.get('/move-ins', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getMoveIns());
});

router.get('/action-items', requireAuth, async (_req: Request, res: Response) => {
  const items = await getActionItems();
  ok(res, items, { count: items.length });
});

// --- Promotions ---
router.get('/promotions', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listPromotions();
  ok(res, rows, { count: rows.length });
});

router.get('/promotions/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getPromotion(String(req.params.id)));
});

router.put('/promotions/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updatePromotionSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid promotion payload', parsed.error.flatten());
    return;
  }
  const input = {
    ...parsed.data,
    startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
    endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
  };
  ok(res, await updatePromotion(String(req.params.id), input));
});

router.delete('/promotions/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deletePromotion(String(req.params.id)));
});

// --- Appointments ---
router.get('/appointments', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listAppointments();
  ok(res, rows, { count: rows.length });
});

// --- Floor plans (facility setup editor) ---
// All plan reads/placement writes never touch Unit rows; placement reads join
// unit and filter deletedAt == null (soft-delete rule).

// List plans across branches/floors (optionally ?branch=BM&level=1), each with
// placements + unit summaries.
router.get('/floor-plans', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid floor-plan query', parsed.error.flatten());
    return;
  }
  const rows = await listFloorPlans(parsed.data);
  ok(res, rows, { count: rows.length });
});

// The plan for a floor (floorId is the upsert key). Includes placements joined
// to unit summaries and the floor's unplaced units. 200 with an empty scaffold
// (plan: null) when no plan exists yet so the editor can start fresh.
router.get('/floor-plans/:floorId', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getFloorPlan(String(req.params.floorId)));
});

// Upsert the plan canvas (width / height / structure) — create if absent, then
// update the provided fields. 201 (created/upserted).
router.post('/floor-plans/:floorId', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanCanvasSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid floor-plan canvas payload', parsed.error.flatten());
    return;
  }
  created(
    res,
    await upsertFloorPlan(String(req.params.floorId), {
      width: parsed.data.width,
      height: parsed.data.height,
      structure: parsed.data.structure,
    }),
  );
});

// Upsert one unit placement keyed by (floorPlanId, unitId): the unit must
// belong to the plan's floor, must not be soft-deleted, and the geometry must
// fit inside the canvas.
router.put('/floor-plans/:floorId/units/:unitId', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanPlacementSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid placement payload', parsed.error.flatten());
    return;
  }
  ok(res, await setUnitPlacement(String(req.params.floorId), String(req.params.unitId), parsed.data));
});

// Remove a unit placement (geometry only — never soft-deletes the Unit).
router.delete('/floor-plans/:floorId/units/:unitId', requireAuth, async (req: Request, res: Response) => {
  ok(res, await removeUnitPlacement(String(req.params.floorId), String(req.params.unitId)));
});

// Create a layout-decoration block (lift / stairs / exit / walking area, ...) on
// the floor's plan — plain name+rect primitives, addressable for edit/delete.
router.post('/floor-plans/:floorId/blocks', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanBlockSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid block payload', parsed.error.flatten());
    return;
  }
  const { name, x, y, width, height, color } = parsed.data;
  created(res, await createFloorPlanBlock(String(req.params.floorId), { name, x, y, width, height, color }));
});

// Upsert a block by id, scoped to the plan: updates an existing block on this
// plan (drag / resize / rename persistence), or creates it when the id is a
// fresh one. Cross-plan ids are rejected.
router.put('/floor-plans/:floorId/blocks/:blockId', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanBlockSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid block payload', parsed.error.flatten());
    return;
  }
  const { name, x, y, width, height, color } = parsed.data;
  ok(res, await setFloorPlanBlock(String(req.params.floorId), String(req.params.blockId), { name, x, y, width, height, color }));
});

// Remove a layout-decoration block (scoped to the plan; cross-plan ids 404).
router.delete('/floor-plans/:floorId/blocks/:blockId', requireAuth, async (req: Request, res: Response) => {
  ok(res, await removeFloorPlanBlock(String(req.params.floorId), String(req.params.blockId)));
});

// --- Promotion Plans ---

const planSchema = z.object({
  kind: z.enum(['DISCOUNT_MATRIX', 'FREE_MONTHS', 'PROMO_CODE', 'CREDITS']),
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().optional(),
  facilityScope: z.unknown().optional(),
  storageType: z.string().optional(),
  sizeScope: z.unknown().optional(),
  appliesTo: z.string().optional(),
  usagePerCustomer: z.number().int().positive().optional(),
  redemptionCap: z.number().int().positive().optional(),
  perUnitApplication: z.boolean().optional(),
  stackingRule: z.string().optional(),
  budgetCap: z.number().nonnegative().optional(),
  freeMonthCount: z.number().int().positive().optional(),
  commitmentMonths: z.number().int().positive().optional(),
  earlyExitTreatment: z.string().optional(),
  minStayPct: z.number().int().min(0).max(100).optional(),
  matrixCells: z.array(z.object({
    sizeCategory: z.string().min(1),
    accessType: z.string().min(1),
    commitmentMonths: z.number().int().positive(),
    discountPct: z.number().nonnegative(),
  })).optional(),
  freeMonths: z.array(z.object({
    monthIndex: z.number().int().min(0),
    free: z.boolean(),
    discountPct: z.number().optional(),
  })).optional(),
  rules: z.array(z.object({
    groupId: z.number().int(),
    field: z.string().min(1),
    operator: z.string().min(1),
    value: z.string().min(1),
  })).optional(),
});

const planUpdateSchema = planSchema.partial();
const planStatusSchema = z.object({ status: z.enum(['DRAFT', 'VALIDATED', 'SCHEDULED', 'ACTIVE', 'ENDED']) });

const safeguardSchema = z.object({
  facilityId: z.string().optional(),
  sizeId: z.string().optional(),
  minEffectiveRate: z.number().nonnegative(),
  requiresApprovalAbove: z.number().nonnegative().optional(),
  approverRole: z.string().optional(),
});
const safeguardUpdateSchema = safeguardSchema.partial();

// Enhanced promotion schema with new fields
const createPromotionSchemaExtended = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  discountType: z.enum(['PERCENTAGE', 'FLAT']).default('PERCENTAGE'),
  discountValue: z.number().nonnegative(),
  minMonths: z.number().int().positive().optional(),
  applicableSizeId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  active: z.boolean().optional(),
  planId: z.string().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'SCHEDULED', 'ENDED', 'USED']).optional(),
  benefitType: z.enum(['PERCENTAGE', 'DOLLAR', 'FREE_MONTHS', 'CREDITS']).optional(),
  applyTo: z.string().optional(),
  usagePerCustomer: z.number().int().positive().optional(),
  redemptionCap: z.number().int().positive().optional(),
  perUnitApplication: z.boolean().optional(),
  stackingRule: z.string().optional(),
  budgetCap: z.number().nonnegative().optional(),
});

// Promotion plan routes
router.get('/promotion-plans', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await listPlans(), { count: 0 });
});

router.post('/promotion-plans', requireAuth, async (req: Request, res: Response) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid plan payload', parsed.error.flatten());
    return;
  }
  created(res, await createPlan(parsed.data as any));
});

router.get('/promotion-plans/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getPlan(String(req.params.id)));
});

router.put('/promotion-plans/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = planUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid plan payload', parsed.error.flatten());
    return;
  }
  ok(res, await updatePlan(String(req.params.id), parsed.data as any));
});

router.patch('/promotion-plans/:id/status', requireAuth, async (req: Request, res: Response) => {
  const parsed = planStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid status', parsed.error.flatten());
    return;
  }
  ok(res, await setPlanStatus(String(req.params.id), parsed.data.status));
});

router.post('/promotion-plans/:id/validate', requireAuth, async (req: Request, res: Response) => {
  ok(res, await validatePlan(String(req.params.id)));
});

router.post('/promotion-plans/:id/duplicate', requireAuth, async (req: Request, res: Response) => {
  created(res, await duplicatePlan(String(req.params.id)));
});

router.delete('/promotion-plans/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deletePlan(String(req.params.id)));
});

// Safeguard routes
router.get('/safeguards', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await listSafeguards());
});

router.post('/safeguards', requireAuth, async (req: Request, res: Response) => {
  const parsed = safeguardSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid safeguard payload', parsed.error.flatten());
    return;
  }
  created(res, await createSafeguard(parsed.data));
});

router.put('/safeguards/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = safeguardUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid safeguard payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateSafeguard(String(req.params.id), parsed.data));
});

router.delete('/safeguards/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteSafeguard(String(req.params.id)));
});

// Enhanced promotion routes (keep existing, but use extended schema)
// Replace the existing create promotion schema reference
router.post('/promotions', requireAuth, async (req: Request, res: Response) => {
  const parsed = createPromotionSchemaExtended.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid promotion payload', parsed.error.flatten());
    return;
  }
  const input = {
    ...parsed.data,
    startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
    endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
  };
  created(res, await createPromotion(input));
});

// Delete the floor plan (cascades its placements; Unit rows untouched).
router.delete('/floor-plans/:floorId', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteFloorPlan(String(req.params.floorId)));
});

export default router;