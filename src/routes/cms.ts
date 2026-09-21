import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ok, created, fail, AppError } from '../lib/http';
import { dateRangeFields, resolveDateRange } from '../lib/dateRange';
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
  listSizes,
  getUnitActivity,
} from '../core/units';
import {
  listFloors,
  listFloorsAdmin,
  getFloor,
  createFloor,
  updateFloor,
  deleteFloor,
} from '../core/floors';
import { listTenants, createTenant, updateTenant, deactivateTenant, listMoveOuts, transitionMoveOut } from '../core/tenants';
import { listLeads, getLeadStats, getWeeklyAnalytics, createLead, updateLead, deleteLead } from '../core/leads';
import {
  listConversations,
  createConversation,
  updateConversation,
  getTimeline,
  postNote,
  sendMessageStub,
} from '../core/conversations';
import { getActionItems } from '../core/actionCenter';
import { listBookings, listInvoices } from '../core/finance';
import { listBranches, getMoveIns, getPortfolio } from '../core/branches';
import { getSettings, upsertSettings } from '../core/settings';
import { adjustRate, getNetPsf } from '../core/rates';
import { listQuotes, getQuote } from '../core/quotes';
import { listFees, createFee, updateFee, deleteFee, resolveFee } from '../core/fees';
import { listBusinessRules, upsertBusinessRules } from '../core/businessRules';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  setFacilityAccess,
  grantPermission,
  revokePermission,
  requirePermission,
  PERMISSIONS,
} from '../core/users';
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
  listVersions,
  compareVersions,
  restoreVersion,
  recordRedemption,
  listRedemptions,
  getPerformance,
} from '../core/promotionPlans';
import { listAppointments, createAppointment, updateAppointment, deleteAppointment, findAppointmentConflicts } from '../core/appointments';
import {
  listWorkOrders,
  getWorkOrder,
  createWorkOrder,
  updateWorkOrder,
  deleteWorkOrder,
  listPreventiveTasks,
  getPreventiveProgress,
  createPreventiveTask,
  updatePreventiveTask,
  deletePreventiveTask,
} from '../core/maintenance';
import {
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  deleteAsset,
  listVendors,
  getVendor,
  createVendor,
  updateVendor,
  deleteVendor,
} from '../core/assets';
import {
  listIncidents,
  getIncident,
  createIncident,
  updateIncident,
  deleteIncident,
} from '../core/incidents';
import {
  listDoors,
  createDoor,
  updateDoor,
  deleteDoor,
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
  listPolicies,
  createPolicy,
  updatePolicy,
  deletePolicy,
  listAccessEvents,
  createAccessEvent,
  getAccessStats,
} from '../core/access';
import {
  listChecklists,
  createChecklist,
  updateChecklist,
  deleteChecklist,
  listCertificates,
  createCertificate,
  updateCertificate,
  deleteCertificate,
} from '../core/inspections';
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
  listFloorPlanBoundaries,
  createFloorPlanBoundary,
  updateFloorPlanBoundary,
  removeFloorPlanBoundary,
} from '../core/floorPlans';
import {
  getFloorMetrics,
  createMetricsSnapshot,
  listMetricsSnapshots,
} from '../core/floorPlanMetricsService';
import {
  listProtectionPlans,
  createProtectionPlan,
  updateProtectionPlan,
  deleteProtectionPlan,
  listAddons,
  createAddon,
  updateAddon,
  deleteAddon,
} from '../core/extras';

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
  status: z.enum(['AVAILABLE', 'RESERVED', 'MAINTENANCE', 'INACTIVE', 'BLOCKED']).optional(),
  climateControl: z.string().optional(),
  name: z.string().trim().max(80).optional(),
});

const updateUnitSchema = z.object({
  sqft: z.number().positive().optional(),
  monthlyRate: z.number().nonnegative().optional(),
  status: z
    .enum(['OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE', 'INACTIVE', 'BLOCKED'])
    .optional(),
  climateControl: z.string().nullable().optional(),
  name: z.string().trim().max(80).nullable().optional(),
});

const unitListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
  status: z
    .enum(['OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE', 'INACTIVE', 'BLOCKED'])
    .optional(),
  branch: z.string().trim().min(1).optional(),
  level: z.coerce.number().int().min(1).optional(),
  ...dateRangeFields,
});

// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive day bounds) for every
// date-filtered list endpoint below. Garbage → 400 VALIDATION.
const dateRangeQuerySchema = z.object({ ...dateRangeFields });

const unitActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Facility floors: create needs branch + level; name defaults to "Level N"
// in core when omitted/blank. Update accepts any subset including the
// isActive toggle (the deactivation path — reversible, public-hiding).
const floorPayloadSchema = z.object({
  branchId: z.string().min(1),
  level: z.number().int().min(1).max(99),
  name: z.string().trim().max(80).optional(),
});

const floorUpdateSchema = z.object({
  level: z.number().int().min(1).max(99).optional(),
  name: z.string().trim().max(80).optional(),
  isActive: z.boolean().optional(),
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
  // Operator-entered GFA (sqft): positive, capped server-side at 10M; null
  // clears back to unset (metrics fall back to the canvas rect); omitted keeps.
  gfaSqft: z.number().positive().max(10000000).nullish(),
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
  // Stacking tier: 0 = ground/sole tier (default), 1 = upper tier of a
  // same-rect locker pair. Anything else is 400; omitted keeps the tier on update.
  stackTier: z.number().int().min(0).max(1).optional(),
  // Authored door compass edges (editor N/S/E/W toggles): omitted keeps the
  // placement's edges, null clears back to unauthored (AUTO_ALL_EDGES in
  // metrics), an array replaces. Additive — old clients simply omit it.
  doorEdges: z.array(z.enum(['N', 'S', 'E', 'W'])).max(4).nullish(),
});

const floorPlanBlockSchema = z.object({
  name: z.string().trim().min(1).max(80), // operator label: "Lift", "Stair", "Walking area", ...
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  color: z.string().trim().max(20).nullish(), // optional render tint (hex)
  // Authored door edges round-trip per region (same keep/clear/replace
  // semantics as placements; blocks are non-leasable so metrics ignores them).
  doorEdges: z.array(z.enum(['N', 'S', 'E', 'W'])).max(4).nullish(),
});

// Facility-boundary line items: polylines in grid-ft units marking the
// facility boundary for NLA / GLA / UFA measurement. `points` is the full
// vertex list ([[x,y],...], integers); `closed` marks a finished loop — only
// closed loops feed `boundaryMetrics` on plan reads.
const floorPlanBoundarySchema = z.object({
  label: z.string().trim().min(1).max(80).optional(), // operator line name; defaults to "Boundary" on create
  kind: z.string().trim().min(1).max(24).nullish(), // line-kind tag; defaults to "BOUNDARY" on create
  points: z.array(z.tuple([z.number().int(), z.number().int()])).min(2).max(500).optional(),
  closed: z.boolean().optional(), // true once the loop is closed (3+ distinct vertices required)
  sortOrder: z.number().int().min(0).max(100000).nullish(), // stable editor ordering
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
  // P1 item 3: map filters — ?size=SMALL and ?nearLift=1.
  const size = typeof req.query.size === 'string' && req.query.size.trim() ? req.query.size.trim() : undefined;
  const nearLift = req.query.nearLift === '1' || req.query.nearLift === 'true';
  ok(res, await getUnitMap(branch, level, { size, nearLift }));
});

router.get('/units', requireAuth, async (req: Request, res: Response) => {
  const parsed = unitListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid unit query', parsed.error.flatten());
    return;
  }
  const range = resolveDateRange(parsed.data);
  const { rows, meta } = await listUnits({
    page: parsed.data.page,
    perPage: parsed.data.perPage,
    status: parsed.data.status,
    branch: parsed.data.branch,
    level: parsed.data.level,
    ...range,
  });
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

router.get('/tenants', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const rows = await listTenants(resolveDateRange(parsed.data));
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

router.get('/leads', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  ok(res, await listLeads(resolveDateRange(parsed.data)));
});

// Lead funnel / source stats for the command centre and pipeline header.
router.get('/leads/stats', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getLeadStats());
});

// Weekly enquiry/booking series for the analytics chart (?weeks=N, 1..26).
router.get('/analytics/weekly', requireAuth, async (req: Request, res: Response) => {
  const weeks = Number(req.query.weeks ?? 8);
  if (req.query.weeks !== undefined && (!Number.isFinite(weeks) || weeks < 1 || weeks > 26)) {
    fail(res, 400, 'VALIDATION', 'weeks must be an integer 1..26');
    return;
  }
  ok(res, await getWeeklyAnalytics(weeks || 8));
});

const leadPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['PERSONAL', 'BUSINESS']).optional(),
  segment: z.string().trim().max(80).nullable().optional(),
  stage: z.enum(['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST']).optional(),
  source: z.enum(['WEBSITE', 'WHATSAPP', 'REFERRAL', 'GOOGLE']).optional(),
  preferredSize: z.string().trim().max(40).nullable().optional(),
  preferredBranchId: z.string().min(1).nullable().optional(),
  monthlyRate: z.number().nonnegative().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  email: z.string().email().nullable().optional(),
  mobile: z.string().trim().max(40).nullable().optional(),
  owner: z.string().trim().max(80).nullable().optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
  lossReason: z.string().trim().max(80).nullable().optional(),
  lossValue: z.number().nonnegative().nullable().optional(),
});

const leadUpdateSchema = leadPayloadSchema.partial();

function toLeadInput(parsed: z.infer<typeof leadPayloadSchema>) {
  return {
    ...parsed,
    nextActionAt: parsed.nextActionAt === undefined ? undefined : parsed.nextActionAt ? new Date(parsed.nextActionAt) : null,
  };
}

router.post('/leads', requireAuth, async (req: Request, res: Response) => {
  const parsed = leadPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid lead payload', parsed.error.flatten());
    return;
  }
  created(res, await createLead(toLeadInput(parsed.data)));
});

router.patch('/leads/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = leadUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid lead payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateLead(String(req.params.id), toLeadInput(parsed.data as z.infer<typeof leadPayloadSchema>)));
});

router.delete('/leads/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteLead(String(req.params.id)));
});

// --- Conversations (operator inbox threads) ---
const createConversationSchema = z.object({
  leadId: z.string().min(1),
  channel: z.enum(['WHATSAPP', 'EMAIL', 'PHONE', 'IN_PERSON', 'WEBSITE']).optional(),
});

const updateConversationSchema = z.object({
  assignee: z.string().trim().max(80).nullable().optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});

const noteSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  author: z.string().trim().max(80).optional(),
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  sender: z.string().trim().max(80).optional(),
});

router.get('/conversations', requireAuth, async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !['OPEN', 'CLOSED'].includes(status)) {
    fail(res, 400, 'VALIDATION', 'Invalid status filter');
    return;
  }
  const rows = await listConversations(status);
  ok(res, rows, { count: rows.length });
});

router.post('/conversations', requireAuth, async (req: Request, res: Response) => {
  const parsed = createConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid conversation payload', parsed.error.flatten());
    return;
  }
  created(res, await createConversation(parsed.data.leadId, parsed.data.channel));
});

router.patch('/conversations/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid conversation payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateConversation(String(req.params.id), parsed.data));
});

router.get('/conversations/:id/messages', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getTimeline(String(req.params.id)));
});

router.post('/conversations/:id/notes', requireAuth, async (req: Request, res: Response) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid note payload', parsed.error.flatten());
    return;
  }
  const author = (req as any).user?.name ?? undefined;
  created(res, await postNote(String(req.params.id), parsed.data.body, parsed.data.author ?? author ?? null));
});

// Send stub — records the outbound message on the thread; real
// WhatsApp/email delivery is out of scope (see core/conversations.ts).
router.post('/conversations/:id/messages', requireAuth, async (req: Request, res: Response) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid message payload', parsed.error.flatten());
    return;
  }
  const sender = parsed.data.sender ?? (req as any).user?.name ?? null;
  created(res, await sendMessageStub(String(req.params.id), parsed.data.body, sender));
});

router.get('/bookings', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const rows = await listBookings(resolveDateRange(parsed.data));
  ok(res, rows, { count: rows.length });
});

router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const rows = await listInvoices(
    typeof req.query.status === 'string' ? req.query.status : undefined,
    resolveDateRange(parsed.data),
  );
  ok(res, rows, { count: rows.length });
});

router.get('/branches', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await listBranches());
});

// P1 item 1: portfolio overview — per-facility sqft cards + portfolio rollup
// (computed from Unit rows; no stored state).
router.get('/portfolio', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getPortfolio());
});

// P1 item 2: net rental rate per sqft per facility (computed aggregation).
router.get('/rates/net-psf', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getNetPsf());
});

// P1 item 4: quotes queue (PROPOSAL_SENT leads + live inventory) — read-model,
// no quote table by design (see src/core/quotes.ts).
router.get('/quotes', requireAuth, async (_req: Request, res: Response) => {
  const { rows, meta } = await listQuotes();
  ok(res, rows, meta);
});

router.get('/quotes/:id', requireAuth, async (req: Request, res: Response) => {
  const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
  const size = typeof req.query.size === 'string' ? req.query.size : undefined;
  ok(res, await getQuote(String(req.params.id), { branchId, size }));
});

// P1 item 4: operator move-outs queue over Notice + TenantStatus.NOTICE.
// Transitions are explicit operator actions (complete/cancel) — nothing here
// auto-flips tenant status.
router.get('/move-outs', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listMoveOuts();
  ok(res, rows, { count: rows.length });
});

const moveOutTransitionSchema = z.object({
  action: z.enum(['complete', 'cancel']),
});

router.patch('/move-outs/:tenantId', requireAuth, async (req: Request, res: Response) => {
  const parsed = moveOutTransitionSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid move-out action', parsed.error.flatten());
    return;
  }
  ok(res, await transitionMoveOut(String(req.params.tenantId), parsed.data.action));
});

router.get('/floors', requireAuth, async (req: Request, res: Response) => {
  // Admin reference list: ALL floors (active + inactive) with branch join +
  // unit counts. Inactive rows carry isActive:false + badge in the UI.
  // ?activeOnly=1 narrows to active floors (additive: level selectors can use
  // it; the default stays all-rows for the Floors management list).
  const branchId = typeof req.query.branchId === 'string' && req.query.branchId.trim()
    ? req.query.branchId.trim()
    : undefined;
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  const rows = activeOnly
    ? await listFloors({ branchId })
    : await listFloorsAdmin(branchId);
  ok(res, rows, { count: rows.length });
});

// NOTE: POST /floors is registered BEFORE GET /floors/:id so "create"-style
// literals are never parsed as an id (Express matches in order; keep this
// pairing together if new floor routes are added).
router.post('/floors', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid floor payload', parsed.error.flatten());
    return;
  }
  created(res, await createFloor(parsed.data));
});

router.get('/floors/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getFloor(String(req.params.id)));
});

router.put('/floors/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid floor payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateFloor(String(req.params.id), parsed.data));
});

router.delete('/floors/:id', requireAuth, async (req: Request, res: Response) => {
  // Guard lives in core: 409 while ANY Unit rows reference the floor.
  // ?deactivate=true converts to a reversible deactivation instead.
  const deactivate = req.query.deactivate === '1' || req.query.deactivate === 'true';
  ok(res, await deleteFloor(String(req.params.id), { deactivate }));
});

router.get('/sizes', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listSizes();
  ok(res, rows, { count: rows.length });
});

router.get('/move-ins', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  ok(res, await getMoveIns(resolveDateRange(parsed.data)));
});

router.get('/action-items', requireAuth, async (_req: Request, res: Response) => {
  const items = await getActionItems();
  ok(res, items, { count: items.length });
});

// --- Global Settings (whole-app key/value store; see src/core/settings.ts) ---
router.get('/settings', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getSettings());
});

const settingsBatchSchema = z.record(z.string(), z.unknown());

router.put('/settings', requireAuth, async (req: Request, res: Response) => {
  const parsed = settingsBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Settings payload must be an object of { key: value }', parsed.error.flatten());
    return;
  }
  ok(res, await upsertSettings(parsed.data));
});

// --- Promotions ---
router.get('/promotions', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const rows = await listPromotions(resolveDateRange(parsed.data));
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
router.get('/appointments', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const range = resolveDateRange(parsed.data);
  const rows = await listAppointments(range.from, range.to);
  ok(res, rows, { count: rows.length });
});

const appointmentPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  personName: z.string().trim().min(1).max(120),
  type: z.enum(['VIEWING', 'CALLBACK', 'VIDEO_CONSULT', 'MOVE_IN']),
  branchId: z.string().min(1).nullable().optional(),
  leadId: z.string().min(1).nullable().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const appointmentUpdateSchema = appointmentPayloadSchema
  .partial()
  .extend({ status: z.enum(['PENDING', 'CONFIRMED', 'DONE', 'CANCELLED']).optional() });

router.post('/appointments', requireAuth, async (req: Request, res: Response) => {
  const parsed = appointmentPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid appointment payload', parsed.error.flatten());
    return;
  }
  const createdRow = await createAppointment({
    ...parsed.data,
    startAt: new Date(parsed.data.startAt),
    endAt: parsed.data.endAt === undefined ? undefined : parsed.data.endAt ? new Date(parsed.data.endAt) : null,
  });
  const conflicts = await findAppointmentConflicts(
    createdRow.branchId,
    new Date(createdRow.startAt),
    createdRow.endAt ? new Date(createdRow.endAt) : null,
    createdRow.id,
  );
  created(
    res,
    createdRow,
    conflicts.length
      ? {
          overlapWarning: 'Overlaps with ' + conflicts.length + ' other appointment(s): ' + conflicts.map((c) => c.title).join(', '),
          conflicts,
        }
      : undefined,
  );
});

router.patch('/appointments/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = appointmentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid appointment payload', parsed.error.flatten());
    return;
  }
  const { startAt, endAt, ...rest } = parsed.data;
  const updated = await updateAppointment(String(req.params.id), {
    ...rest,
    ...(startAt !== undefined ? { startAt: new Date(startAt) } : {}),
    ...(endAt !== undefined ? { endAt: endAt ? new Date(endAt) : null } : {}),
  });
  // Non-blocking overlap warning for reschedules: the move is already saved;
  // callers (calendar drag-drop) surface this from meta without reverting.
  const conflicts = await findAppointmentConflicts(
    updated.branchId,
    new Date(updated.startAt),
    updated.endAt ? new Date(updated.endAt) : null,
    updated.id,
  );
  ok(
    res,
    updated,
    conflicts.length
      ? {
          overlapWarning: 'Overlaps with ' + conflicts.length + ' other appointment(s): ' + conflicts.map((c) => c.title).join(', '),
          conflicts,
        }
      : undefined,
  );
});

router.delete('/appointments/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteAppointment(String(req.params.id)));
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

// Upsert the plan canvas (width / height / structure / operator-entered GFA) —
// create if absent, then update the provided fields. 201 (created/upserted).
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
      gfaSqft: parsed.data.gfaSqft,
    }),
  );
});

// Upsert one unit placement keyed by (floorPlanId, unitId): the unit must
// belong to the plan's floor, must not be soft-deleted, and the geometry must
// fit inside the canvas. `stackTier` (0 = ground/sole, 1 = upper) allows two
// lockers to share the exact same rect as a stacked pair (lockers-only,
// at most 2 high); all other overlaps are 409.
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
  created(res, await createFloorPlanBlock(String(req.params.floorId), { name, x, y, width, height, color, doorEdges: parsed.data.doorEdges ?? undefined }));
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
  ok(res, await setFloorPlanBlock(String(req.params.floorId), String(req.params.blockId), { name, x, y, width, height, color, doorEdges: parsed.data.doorEdges ?? undefined }));
});

// Remove a layout-decoration block (scoped to the plan; cross-plan ids 404).
router.delete('/floor-plans/:floorId/blocks/:blockId', requireAuth, async (req: Request, res: Response) => {
  ok(res, await removeFloorPlanBlock(String(req.params.floorId), String(req.params.blockId)));
});

// --- Floor-plan boundary line items (facility layout marks for UFA/NLA) ---
// Polylines in grid-ft units drawn with the editor's Line-item tool. Reads
// (CMS GET plan + public plan GET) embed `boundaries` plus the derived
// `boundaryMetrics { gla, ufa, nla, unit, boundaryClosed, facilityAreaSqft,
// gfaSqft, gfaSource }`; marked-area rule: closed loops AND open >= 3-vertex
// polylines (chord-closed) feed UFA/NLA, open 2-vertex segments persist
// honestly and contribute 0 until extended/closed.

// List a floor's boundary line items (editor sort order; [] when no plan yet).
router.get('/floor-plans/:floorId/boundaries', requireAuth, async (req: Request, res: Response) => {
  const rows = await listFloorPlanBoundaries(String(req.params.floorId));
  ok(res, rows, { count: rows.length });
});

// Create a boundary line item on the floor's plan (lazily creates the canvas
// when the floor has none yet). 201 (created).
router.post('/floor-plans/:floorId/boundaries', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanBoundarySchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid boundary payload', parsed.error.flatten());
    return;
  }
  created(res, await createFloorPlanBoundary(String(req.params.floorId), parsed.data));
});

// Update a boundary line item scoped to the plan: vertex drag / close-loop /
// rename persistence. Omitted fields keep their values. Cross-plan ids 404.
router.put('/floor-plans/:floorId/boundaries/:boundaryId', requireAuth, async (req: Request, res: Response) => {
  const parsed = floorPlanBoundarySchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid boundary payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateFloorPlanBoundary(String(req.params.floorId), String(req.params.boundaryId), parsed.data));
});

// Remove a boundary line item (scoped to the plan; cross-plan ids 404).
router.delete('/floor-plans/:floorId/boundaries/:boundaryId', requireAuth, async (req: Request, res: Response) => {
  ok(res, await removeFloorPlanBoundary(String(req.params.floorId), String(req.params.boundaryId)));
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
  // Discount commitment tiers: 1 / 3 / 6 / 12 months. Kept as positive-int
  // (not an enum) so legacy plans round-trip; the tier set itself is enforced
  // by validatePlan() in core/promotionPlans.ts (ALLOWED_COMMITMENT_MONTHS).
  commitmentMonths: z.number().int().positive().optional(),
  earlyExitTreatment: z.string().optional(),
  minStayPct: z.number().int().min(0).max(100).optional(),
  matrixCells: z.array(z.object({
    // Canonical size tiers LOCKER / SMALL / MEDIUM / LARGE / XL / XXL.
    // Legacy XS / S / M / L are still accepted and normalized to canonical
    // in core/promotionPlans.ts (assertCanonicalSizeCategory); unknown codes
    // 400 there with the tier list.
    sizeCategory: z.string().min(1),
    accessType: z.string().min(1),
    // 1 / 3 / 6 / 12 — see ALLOWED_COMMITMENT_MONTHS in core/promotionPlans.ts.
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
const planStatusSchema = z.object({
  status: z.enum(['DRAFT', 'VALIDATED', 'SCHEDULED', 'ACTIVE', 'ENDED']),
  changedBy: z.string().trim().max(80).optional(),
  approverRole: z.string().trim().max(80).optional(),
});
const planRestoreSchema = z.object({
  version: z.number().int().positive(),
  changedBy: z.string().trim().max(80).optional(),
});
const redemptionSchema = z.object({
  bookingId: z.string().min(1).optional(),
  code: z.string().trim().max(40).optional(),
  amount: z.number().nonnegative(),
});

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
// NOTE: /promotion-plans/performance is registered BEFORE /:id so
// "performance" is not parsed as a plan id.
router.get('/promotion-plans/performance', requireAuth, async (_req: Request, res: Response) => {
  ok(res, await getPerformance());
});

router.get('/promotion-plans', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  ok(res, await listPlans(resolveDateRange(parsed.data)), { count: 0 });
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
  ok(res, await setPlanStatus(String(req.params.id), parsed.data.status, {
    changedBy: parsed.data.changedBy,
    approverRole: parsed.data.approverRole,
    // P1 item 6: verified-permission gate for go-live edges (legacy fallback
    // when the actor holds no permission rows — see core/users.ts mayAct).
    actorId: (req as any).user?.sub,
  }));
});

router.get('/promotion-plans/:id/versions', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const rows = await listVersions(String(req.params.id), resolveDateRange(parsed.data));
  ok(res, rows, { count: rows.length });
});

router.get('/promotion-plans/:id/compare', requireAuth, async (req: Request, res: Response) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    fail(res, 400, 'VALIDATION', 'Query params from and to must be positive integers');
    return;
  }
  ok(res, await compareVersions(String(req.params.id), from, to));
});

router.post('/promotion-plans/:id/restore', requireAuth, async (req: Request, res: Response) => {
  const parsed = planRestoreSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid restore payload', parsed.error.flatten());
    return;
  }
  created(res, await restoreVersion(String(req.params.id), parsed.data.version, parsed.data.changedBy));
});

router.get('/promotion-plans/:id/redemptions', requireAuth, async (req: Request, res: Response) => {
  const parsed = dateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid date range', parsed.error.flatten());
    return;
  }
  const rows = await listRedemptions(String(req.params.id), resolveDateRange(parsed.data));
  ok(res, rows, { count: rows.length });
});

router.post('/promotion-plans/:id/redemptions', requireAuth, async (req: Request, res: Response) => {
  const parsed = redemptionSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid redemption payload', parsed.error.flatten());
    return;
  }
  created(res, await recordRedemption(String(req.params.id), parsed.data));
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

// --- Floor-plan area metrics (Phase 2) ---
// Live compute runs over the current canvas geometry (placements + blocks)
// joined to Unit status/rates/sizes; snapshots are append-only history rows.
// There is deliberately no PUT/PATCH on snapshots (updates forbidden by
// design) and non-rectangular geometry is rejected at the boundary (400).

const metricsSnapshotSchema = z.object({
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_date must be YYYY-MM-DD'),
});

// Live metrics for a floor: full payload with the assumptions block
// (measurement_basis CENTERLINE, pricing_basis, gla_convention,
// wall_thickness, residual_tolerance 0.25, min_aisle_width 3.0) plus
// facility + floor + coverage + geometry/occupancy/revenue/unit_mix/
// volumetric + units + circulation + reachability + validation.
router.get('/floor-plans/:floorId/metrics', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getFloorMetrics(String(req.params.floorId)));
});

// Publish an append-only snapshot for an effective date. Validation ERRORs
// block with 422 + the validation array (invalid geometry is never persisted).
// Publishing the same date twice creates two rows (history, not state).
router.post('/floor-plans/:floorId/metrics/snapshots', requireAuth, async (req: Request, res: Response) => {
  const parsed = metricsSnapshotSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid snapshot payload', parsed.error.flatten());
    return;
  }
  created(res, await createMetricsSnapshot(String(req.params.floorId), parsed.data.effective_date));
});

// Snapshot history for a floor (newest effective date first, payloads included).
router.get('/floor-plans/:floorId/metrics/snapshots', requireAuth, async (req: Request, res: Response) => {
  const rows = await listMetricsSnapshots(String(req.params.floorId));
  ok(res, rows, { count: rows.length });
});

// --- Maintenance (facilities sidebar module 2) ---
// Work orders: branch/unit scope, OPEN → IN_PROGRESS → DONE, monetary value.
// Preventive tasks: HVAC / Fire / Doors / CCTV trade categories with % complete.

const workOrderPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  branchId: z.string().min(1).nullable().optional(),
  unitId: z.string().min(1).nullable().optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE']).optional(),
  priority: z.string().trim().max(20).nullable().optional(),
  value: z.number().nonnegative().optional(),
  assignee: z.string().trim().max(80).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

const workOrderUpdateSchema = workOrderPayloadSchema.partial();

function toWorkOrderInput(parsed: z.infer<typeof workOrderPayloadSchema>) {
  return {
    ...parsed,
    dueDate:
      parsed.dueDate === undefined ? undefined : parsed.dueDate ? new Date(parsed.dueDate) : null,
  };
}

router.get('/work-orders', requireAuth, async (req: Request, res: Response) => {
  const rows = await listWorkOrders({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/work-orders', requireAuth, async (req: Request, res: Response) => {
  const parsed = workOrderPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid work order payload', parsed.error.flatten());
    return;
  }
  created(res, await createWorkOrder(toWorkOrderInput(parsed.data)));
});

router.get('/work-orders/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getWorkOrder(String(req.params.id)));
});

router.patch('/work-orders/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = workOrderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid work order payload', parsed.error.flatten());
    return;
  }
  ok(
    res,
    await updateWorkOrder(
      String(req.params.id),
      toWorkOrderInput(parsed.data as z.infer<typeof workOrderPayloadSchema>),
    ),
  );
});

router.delete('/work-orders/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteWorkOrder(String(req.params.id)));
});

const preventiveTaskPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: z.enum(['HVAC', 'FIRE', 'DOORS', 'CCTV']),
  branchId: z.string().min(1).nullable().optional(),
  percentComplete: z.number().int().min(0).max(100).optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

const preventiveTaskUpdateSchema = preventiveTaskPayloadSchema.partial();

function toPreventiveInput(parsed: z.infer<typeof preventiveTaskPayloadSchema>) {
  return {
    ...parsed,
    dueDate:
      parsed.dueDate === undefined ? undefined : parsed.dueDate ? new Date(parsed.dueDate) : null,
  };
}

router.get('/preventive-tasks', requireAuth, async (req: Request, res: Response) => {
  const rows = await listPreventiveTasks({
    category: typeof req.query.category === 'string' ? req.query.category : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
  });
  ok(res, rows, { count: rows.length });
});

// % complete per category (HVAC / Fire / Doors / CCTV). Registered BEFORE
// /preventive-tasks/:id so "progress" is not parsed as a task id.
router.get('/preventive-tasks/progress', requireAuth, async (req: Request, res: Response) => {
  ok(
    res,
    await getPreventiveProgress(
      typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
    ),
  );
});

router.post('/preventive-tasks', requireAuth, async (req: Request, res: Response) => {
  const parsed = preventiveTaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid preventive task payload', parsed.error.flatten());
    return;
  }
  created(res, await createPreventiveTask(toPreventiveInput(parsed.data)));
});

router.patch('/preventive-tasks/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = preventiveTaskUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid preventive task payload', parsed.error.flatten());
    return;
  }
  ok(
    res,
    await updatePreventiveTask(
      String(req.params.id),
      toPreventiveInput(parsed.data as z.infer<typeof preventiveTaskPayloadSchema>),
    ),
  );
});

router.delete('/preventive-tasks/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deletePreventiveTask(String(req.params.id)));
});

// --- Assets & vendors (facilities sidebar module 3) ---

const assetPayloadSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(40),
  branchId: z.string().min(1).nullable().optional(),
  status: z.enum(['ACTIVE', 'IN_SERVICE', 'RETIRED']).optional(),
  purchaseDate: z.string().datetime().nullable().optional(),
  value: z.number().nonnegative().nullable().optional(),
});

const assetUpdateSchema = assetPayloadSchema.partial().omit({ code: true });

function toAssetInput(parsed: z.infer<typeof assetPayloadSchema>) {
  return {
    ...parsed,
    purchaseDate:
      parsed.purchaseDate === undefined
        ? undefined
        : parsed.purchaseDate
          ? new Date(parsed.purchaseDate)
          : null,
  };
}

router.get('/assets', requireAuth, async (req: Request, res: Response) => {
  const rows = await listAssets({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/assets', requireAuth, async (req: Request, res: Response) => {
  const parsed = assetPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid asset payload', parsed.error.flatten());
    return;
  }
  created(res, await createAsset(toAssetInput(parsed.data)));
});

router.get('/assets/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getAsset(String(req.params.id)));
});

router.patch('/assets/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = assetUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid asset payload', parsed.error.flatten());
    return;
  }
  const { purchaseDate, ...rest } = parsed.data;
  ok(
    res,
    await updateAsset(String(req.params.id), {
      ...rest,
      ...(purchaseDate !== undefined
        ? { purchaseDate: purchaseDate ? new Date(purchaseDate) : null }
        : {}),
    }),
  );
});

router.delete('/assets/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteAsset(String(req.params.id)));
});

const vendorPayloadSchema = z.object({
  name: z.string().trim().min(1).max(160),
  service: z.string().trim().max(160).nullable().optional(),
  sla: z.string().trim().max(160).nullable().optional(),
  ytdSpend: z.number().nonnegative().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  contact: z.string().trim().max(160).nullable().optional(),
});

const vendorUpdateSchema = vendorPayloadSchema.partial();

router.get('/vendors', requireAuth, async (req: Request, res: Response) => {
  const rows = await listVendors({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/vendors', requireAuth, async (req: Request, res: Response) => {
  const parsed = vendorPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid vendor payload', parsed.error.flatten());
    return;
  }
  created(res, await createVendor(parsed.data));
});

router.get('/vendors/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getVendor(String(req.params.id)));
});

router.patch('/vendors/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = vendorUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid vendor payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateVendor(String(req.params.id), parsed.data));
});

router.delete('/vendors/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteVendor(String(req.params.id)));
});

// --- Incidents (facilities sidebar module 4) ---

const incidentPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  branchId: z.string().min(1).nullable().optional(),
  unitId: z.string().min(1).nullable().optional(),
  checklist: z.unknown().optional(),
  reportedBy: z.string().trim().max(80).nullable().optional(),
});

const incidentUpdateSchema = incidentPayloadSchema.partial();

router.get('/incidents', requireAuth, async (req: Request, res: Response) => {
  const rows = await listIncidents({
    severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/incidents', requireAuth, async (req: Request, res: Response) => {
  const parsed = incidentPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid incident payload', parsed.error.flatten());
    return;
  }
  created(res, await createIncident(parsed.data));
});

router.get('/incidents/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await getIncident(String(req.params.id)));
});

router.patch('/incidents/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = incidentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid incident payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateIncident(String(req.params.id), parsed.data));
});

router.delete('/incidents/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteIncident(String(req.params.id)));
});

// --- Access control (facilities sidebar module 5) ---
// Sub-panels: Live (events) / Credentials / Temporary (expiring credentials) /
// Exceptions (DENIED events) / Policies.

const doorPayloadSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  branchId: z.string().min(1).nullable().optional(),
  location: z.string().trim().max(160).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const doorUpdateSchema = doorPayloadSchema.partial().omit({ code: true });

router.get('/access/doors', requireAuth, async (req: Request, res: Response) => {
  const rows = await listDoors({
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/access/doors', requireAuth, async (req: Request, res: Response) => {
  const parsed = doorPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid door payload', parsed.error.flatten());
    return;
  }
  created(res, await createDoor(parsed.data));
});

router.patch('/access/doors/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = doorUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid door payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateDoor(String(req.params.id), parsed.data));
});

router.delete('/access/doors/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteDoor(String(req.params.id)));
});

const credentialPayloadSchema = z.object({
  holderName: z.string().trim().min(1).max(160),
  type: z.enum(['PERMANENT', 'TEMPORARY', 'VISITOR']).optional(),
  status: z.enum(['ACTIVE', 'REVOKED', 'EXPIRED']).optional(),
  branchId: z.string().min(1).nullable().optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validTo: z.string().datetime().nullable().optional(),
});

const credentialUpdateSchema = credentialPayloadSchema.partial();

function toCredentialInput(parsed: z.infer<typeof credentialPayloadSchema>) {
  return {
    ...parsed,
    validFrom:
      parsed.validFrom === undefined
        ? undefined
        : parsed.validFrom
          ? new Date(parsed.validFrom)
          : null,
    validTo:
      parsed.validTo === undefined ? undefined : parsed.validTo ? new Date(parsed.validTo) : null,
  };
}

router.get('/access/credentials', requireAuth, async (req: Request, res: Response) => {
  const rows = await listCredentials({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
    temporary: req.query.temporary === '1' || req.query.temporary === 'true',
  });
  ok(res, rows, { count: rows.length });
});

router.post('/access/credentials', requireAuth, async (req: Request, res: Response) => {
  const parsed = credentialPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid credential payload', parsed.error.flatten());
    return;
  }
  created(res, await createCredential(toCredentialInput(parsed.data)));
});

router.patch('/access/credentials/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = credentialUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid credential payload', parsed.error.flatten());
    return;
  }
  ok(
    res,
    await updateCredential(
      String(req.params.id),
      toCredentialInput(parsed.data as z.infer<typeof credentialPayloadSchema>),
    ),
  );
});

router.delete('/access/credentials/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteCredential(String(req.params.id)));
});

const policyPayloadSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  scope: z.string().trim().max(160).nullable().optional(),
  active: z.boolean().optional(),
});

const policyUpdateSchema = policyPayloadSchema.partial();

router.get('/access/policies', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listPolicies();
  ok(res, rows, { count: rows.length });
});

router.post('/access/policies', requireAuth, async (req: Request, res: Response) => {
  const parsed = policyPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid policy payload', parsed.error.flatten());
    return;
  }
  created(res, await createPolicy(parsed.data));
});

router.patch('/access/policies/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = policyUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid policy payload', parsed.error.flatten());
    return;
  }
  ok(res, await updatePolicy(String(req.params.id), parsed.data));
});

router.delete('/access/policies/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deletePolicy(String(req.params.id)));
});

const accessEventPayloadSchema = z.object({
  doorId: z.string().min(1).nullable().optional(),
  credentialId: z.string().min(1).nullable().optional(),
  branchId: z.string().min(1).nullable().optional(),
  result: z.enum(['GRANTED', 'DENIED']).optional(),
  occurredAt: z.string().datetime().optional(),
  note: z.string().max(1000).nullable().optional(),
});

router.get('/access/events', requireAuth, async (req: Request, res: Response) => {
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
    fail(res, 400, 'VALIDATION', 'limit must be an integer 1..200');
    return;
  }
  const rows = await listAccessEvents({
    result: typeof req.query.result === 'string' ? req.query.result : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
    limit,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/access/events', requireAuth, async (req: Request, res: Response) => {
  const parsed = accessEventPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid access event payload', parsed.error.flatten());
    return;
  }
  created(
    res,
    await createAccessEvent({
      ...parsed.data,
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
    }),
  );
});

// Header stats (entries / credentials / doors). Registered BEFORE any
// /access/:param route would shadow it (none exist today — kept explicit).
router.get('/access/stats', requireAuth, async (req: Request, res: Response) => {
  ok(
    res,
    await getAccessStats(
      typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
    ),
  );
});

// --- Inspections & compliance (facilities sidebar module 6) ---

const checklistPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']).optional(),
  branchId: z.string().min(1).nullable().optional(),
  items: z.unknown().optional(),
  percentComplete: z.number().int().min(0).max(100).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE']).optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

const checklistUpdateSchema = checklistPayloadSchema.partial();

function toChecklistInput(parsed: z.infer<typeof checklistPayloadSchema>) {
  return {
    ...parsed,
    dueDate:
      parsed.dueDate === undefined ? undefined : parsed.dueDate ? new Date(parsed.dueDate) : null,
  };
}

router.get('/inspections/checklists', requireAuth, async (req: Request, res: Response) => {
  const rows = await listChecklists({
    frequency: typeof req.query.frequency === 'string' ? req.query.frequency : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
  });
  ok(res, rows, { count: rows.length });
});

router.post('/inspections/checklists', requireAuth, async (req: Request, res: Response) => {
  const parsed = checklistPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid checklist payload', parsed.error.flatten());
    return;
  }
  created(res, await createChecklist(toChecklistInput(parsed.data)));
});

router.patch('/inspections/checklists/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = checklistUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid checklist payload', parsed.error.flatten());
    return;
  }
  ok(
    res,
    await updateChecklist(
      String(req.params.id),
      toChecklistInput(parsed.data as z.infer<typeof checklistPayloadSchema>),
    ),
  );
});

router.delete('/inspections/checklists/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteChecklist(String(req.params.id)));
});

const certificatePayloadSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.string().trim().min(1).max(80),
  branchId: z.string().min(1).nullable().optional(),
  issuer: z.string().trim().max(160).nullable().optional(),
  expiryDate: z.string().datetime(),
  status: z.enum(['VALID', 'EXPIRING', 'EXPIRED']).optional(),
});

const certificateUpdateSchema = certificatePayloadSchema.partial();

function toCertificateInput(parsed: z.infer<typeof certificatePayloadSchema>) {
  return {
    ...parsed,
    expiryDate: new Date(parsed.expiryDate),
  };
}

router.get('/inspections/certificates', requireAuth, async (req: Request, res: Response) => {
  const rows = await listCertificates({
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
    expiring: req.query.expiring === '1' || req.query.expiring === 'true',
  });
  ok(res, rows, { count: rows.length });
});

router.post('/inspections/certificates', requireAuth, async (req: Request, res: Response) => {
  const parsed = certificatePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid certificate payload', parsed.error.flatten());
    return;
  }
  created(res, await createCertificate(toCertificateInput(parsed.data)));
});

router.patch('/inspections/certificates/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = certificateUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid certificate payload', parsed.error.flatten());
    return;
  }
  const { expiryDate, ...rest } = parsed.data;
  ok(
    res,
    await updateCertificate(String(req.params.id), {
      ...rest,
      ...(expiryDate !== undefined ? { expiryDate: new Date(expiryDate) } : {}),
    }),
  );
});

router.delete('/inspections/certificates/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteCertificate(String(req.params.id)));
});

// --- Fees & deposits (P1 item 5) ---
// FacilityFee rows express the Global → Facility → Product → Exception chain;
// GET /fees/resolve collapses it to the effective rule for a context.

const feePayloadSchema = z.object({
  kind: z.enum(['FEE', 'DEPOSIT']).optional(),
  key: z.string().trim().min(1).max(80),
  scope: z.enum(['GLOBAL', 'FACILITY', 'PRODUCT', 'EXCEPTION']).optional(),
  branchId: z.string().min(1).nullable().optional(),
  sizeId: z.string().min(1).nullable().optional(),
  tenantId: z.string().min(1).nullable().optional(),
  amount: z.number().nonnegative(),
  amountKind: z.enum(['FLAT', 'PCT', 'MONTHS']).optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const feeUpdateSchema = feePayloadSchema.partial();

router.get('/fees', requireAuth, async (req: Request, res: Response) => {
  const active =
    req.query.active === undefined ? undefined : req.query.active === '1' || req.query.active === 'true';
  const rows = await listFees({
    kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
    key: typeof req.query.key === 'string' ? req.query.key : undefined,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
    active,
  });
  ok(res, rows, { count: rows.length });
});

// Effective-rule lookup. Registered BEFORE /fees/:id so "resolve" is not
// parsed as a fee id.
router.get('/fees/resolve', requireAuth, async (req: Request, res: Response) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!key.trim()) {
    fail(res, 400, 'VALIDATION', 'Query param key is required');
    return;
  }
  const kind = typeof req.query.kind === 'string' ? req.query.kind : 'FEE';
  if (kind !== 'FEE' && kind !== 'DEPOSIT') {
    fail(res, 400, 'VALIDATION', 'kind must be FEE or DEPOSIT');
    return;
  }
  ok(
    res,
    await resolveFee({
      kind,
      key: key.trim(),
      branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
      sizeId: typeof req.query.sizeId === 'string' ? req.query.sizeId : undefined,
      tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
    }),
  );
});

router.post('/fees', requireAuth, async (req: Request, res: Response) => {
  const parsed = feePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid fee payload', parsed.error.flatten());
    return;
  }
  // P1 item 6 (gated): operators with permission rows need 'fees.manage'.
  await requirePermission((req as any).user?.sub, 'fees.manage');
  created(res, await createFee(parsed.data));
});

router.patch('/fees/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = feeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid fee payload', parsed.error.flatten());
    return;
  }
  await requirePermission((req as any).user?.sub, 'fees.manage');
  ok(res, await updateFee(String(req.params.id), parsed.data));
});

router.delete('/fees/:id', requireAuth, async (req: Request, res: Response) => {
  await requirePermission((req as any).user?.sub, 'fees.manage');
  ok(res, await deleteFee(String(req.params.id)));
});

// --- Business rules (P1 item 7) ---
// Typed org + booking rules beyond the 3 scalar booking settings.

router.get('/business-rules', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listBusinessRules();
  ok(res, rows, { count: rows.length });
});

const businessRulesBatchSchema = z.record(z.string(), z.unknown());

router.put('/business-rules', requireAuth, async (req: Request, res: Response) => {
  const parsed = businessRulesBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Business-rules payload must be an object of { key: value }', parsed.error.flatten());
    return;
  }
  // P1 item 6 (gated): operators with permission rows need 'businessRules.manage'.
  await requirePermission((req as any).user?.sub, 'businessRules.manage');
  ok(res, await upsertBusinessRules(parsed.data));
});

// --- Users & roles (P1 item 6) ---
// Facility scoping + verified permissions. Reads are never gated; writes use
// the gated requirePermission (legacy fallback when the actor has no rows).

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
  role: z.enum(['OWNER', 'MANAGER', 'VIEWER']).optional(),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['OWNER', 'MANAGER', 'VIEWER']).optional(),
  password: z.string().min(8).max(200).optional(),
});

const facilityAccessSchema = z.object({
  access: z.array(
    z.object({
      branchId: z.string().min(1).nullable().optional(),
      scope: z.enum(['FACILITY', 'ALL']).optional(),
    }),
  ),
});

const grantPermissionSchema = z.object({
  permission: z.string().trim().min(1).max(80),
});

router.get('/users', requireAuth, async (_req: Request, res: Response) => {
  const rows = await listUsers();
  ok(res, rows, { count: rows.length });
});

router.get('/users/permissions', requireAuth, async (_req: Request, res: Response) => {
  // Permission catalog (reference for the Settings Users section).
  ok(res, [...PERMISSIONS]);
});

router.post('/users', requireAuth, async (req: Request, res: Response) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid user payload', parsed.error.flatten());
    return;
  }
  await requirePermission((req as any).user?.sub, 'users.manage');
  created(res, await createUser(parsed.data));
});

router.patch('/users/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid user payload', parsed.error.flatten());
    return;
  }
  await requirePermission((req as any).user?.sub, 'users.manage');
  ok(res, await updateUser(String(req.params.id), parsed.data));
});

router.delete('/users/:id', requireAuth, async (req: Request, res: Response) => {
  await requirePermission((req as any).user?.sub, 'users.manage');
  ok(res, await deleteUser(String(req.params.id), { actorId: (req as any).user?.sub }));
});

router.get('/users/:id/access', requireAuth, async (req: Request, res: Response) => {
  const rows = await listUsers();
  const user = rows.find((u) => u.id === String(req.params.id));
  if (!user) {
    fail(res, 404, 'NOT_FOUND', `User ${String(req.params.id)} not found`);
    return;
  }
  ok(res, user.facilityAccess);
});

router.put('/users/:id/access', requireAuth, async (req: Request, res: Response) => {
  const parsed = facilityAccessSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid access payload', parsed.error.flatten());
    return;
  }
  await requirePermission((req as any).user?.sub, 'users.manage');
  ok(res, await setFacilityAccess(String(req.params.id), parsed.data.access));
});

router.post('/users/:id/permissions', requireAuth, async (req: Request, res: Response) => {
  const parsed = grantPermissionSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid permission payload', parsed.error.flatten());
    return;
  }
  await requirePermission((req as any).user?.sub, 'users.manage');
  created(res, await grantPermission(String(req.params.id), parsed.data.permission));
});

router.delete('/users/:id/permissions/:permission', requireAuth, async (req: Request, res: Response) => {
  await requirePermission((req as any).user?.sub, 'users.manage');
  ok(res, await revokePermission(String(req.params.id), String(req.params.permission)));
});

// --- Booking extras (protection plans + packing-supply addons) ---
// CMS-editable catalog for the booking flow. GET lists every row (active +
// inactive) in sortOrder; ?activeOnly=1 narrows to active rows. POST creates a
// row keyed by its frontend slug (409 on clash). PATCH updates any subset
// including the active toggle (deactivation is preferred over delete —
// bookings snapshot catalog values as free text). DELETE is a hard delete.
// Writes are intentionally NOT permission-gated (catalog edits, like
// promotions) — Bearer JWT via requireAuth is the gate.

const protectionPlanPayloadSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be a URL-safe slug (e.g. "essential")'),
  name: z.string().trim().min(1).max(120),
  price: z.number().nonnegative(),
  coverage: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
});

const protectionPlanUpdateSchema = protectionPlanPayloadSchema.partial().omit({ id: true });

const addonPayloadSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be a URL-safe slug (e.g. "medium-box")'),
  name: z.string().trim().min(1).max(120),
  price: z.number().nonnegative(),
  unit: z.string().trim().max(40).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
});

const addonUpdateSchema = addonPayloadSchema.partial().omit({ id: true });

router.get('/protection-plans', requireAuth, async (req: Request, res: Response) => {
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  const rows = await listProtectionPlans(activeOnly ? { activeOnly: true } : {});
  ok(res, rows, { count: rows.length });
});

router.post('/protection-plans', requireAuth, async (req: Request, res: Response) => {
  const parsed = protectionPlanPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid protection plan payload', parsed.error.flatten());
    return;
  }
  created(res, await createProtectionPlan(parsed.data));
});

router.patch('/protection-plans/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = protectionPlanUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid protection plan payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateProtectionPlan(String(req.params.id), parsed.data));
});

router.delete('/protection-plans/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteProtectionPlan(String(req.params.id)));
});

router.get('/addons', requireAuth, async (req: Request, res: Response) => {
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  const rows = await listAddons(activeOnly ? { activeOnly: true } : {});
  ok(res, rows, { count: rows.length });
});

router.post('/addons', requireAuth, async (req: Request, res: Response) => {
  const parsed = addonPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid addon payload', parsed.error.flatten());
    return;
  }
  created(res, await createAddon(parsed.data));
});

router.patch('/addons/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = addonUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid addon payload', parsed.error.flatten());
    return;
  }
  ok(res, await updateAddon(String(req.params.id), parsed.data));
});

router.delete('/addons/:id', requireAuth, async (req: Request, res: Response) => {
  ok(res, await deleteAddon(String(req.params.id)));
});

export default router;