import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ok, created, fail, AppError } from '../lib/http';
import { config } from '../lib/config';
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
import { listLeads } from '../core/leads';
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

router.get('/config', (req: Request, res: Response) => {
  // Security gate (deploy runbook "Phase 0 step 4 — SECURITY FLAG"): this endpoint
  // hands the CMS dashboard its live login credentials, so it must never be
  // reachable from the PUBLIC api host in production. Only the cms host
  // (cms.storelah.sg) and local dev (NODE_ENV != production / localhost) may use
  // it — the api host 404s it once production. The booking app never calls it.
  if (config.isProd && resolveHostKind(req) === 'api') {
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

router.post('/promotions', requireAuth, async (req: Request, res: Response) => {
  const parsed = createPromotionSchema.safeParse(req.body);
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

export default router;