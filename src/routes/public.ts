import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, fail } from '../lib/http';
import { listPublicBranches } from '../core/branches';
import { getUnitMap, listPublicUnits } from '../core/units';
import { listActivePromotions, validatePromotion, DEFAULT_PROMO_TYPE, DEFAULT_PROMO_SCOPE } from '../core/promotions';
import { listActivePublicPromotionPlans } from '../core/promotionPlans';
import { getPublicFloorPlan } from '../core/floorPlans';
import { listProtectionPlans, listAddons } from '../core/extras';
import { getPublicSettings } from '../core/settings';
import { createPublicLead } from '../core/leads';

const router = Router();

// Minimal fixed-window rate limit for the public lead-capture endpoint
// (no shared limiter exists — the claim limiter in core/customers.ts is
// failure-count keyed and claim-specific, so it can't be reused). Keyed by
// client IP; tuned via PUBLIC_LEAD_RATE_LIMIT / PUBLIC_LEAD_RATE_WINDOW_MS.
// Same per-instance caveat as the claim limiter under serverless-http: each
// warm Lambda instance keeps its own Map. Swap in Redis/DynamoDB if a hard
// cross-instance limit is ever required.
const PUBLIC_LEAD_LIMIT = Number(process.env.PUBLIC_LEAD_RATE_LIMIT ?? 30);
const PUBLIC_LEAD_WINDOW_MS = Number(process.env.PUBLIC_LEAD_RATE_WINDOW_MS ?? 60_000);
const publicLeadHits = new Map<string, { windowStart: number; count: number }>();

function publicLeadLimiter(req: Request, res: Response, next: () => void): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = publicLeadHits.get(key);
  if (!entry || now - entry.windowStart >= PUBLIC_LEAD_WINDOW_MS) {
    publicLeadHits.set(key, { windowStart: now, count: 1 });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > PUBLIC_LEAD_LIMIT) {
    fail(res, 429, 'TOO_MANY_REQUESTS', 'Too many requests. Please try again shortly.');
    return;
  }
  next();
}

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

// PUBLIC settings subset for the booking frontend (unauthenticated).
// Additive: `{ data: { gstEnabled } }` — the booking app reads
// `data.gstEnabled` to decide whether to show GST UI/pricing. Backed by
// the CMS Global Settings key `billing.gstEnabled` (default false = GST
// hidden); operators toggle it on the CMS Global Settings page or via
// PUT /api/v1/cms/settings. No auth, no PII. Existing public routes are
// untouched.
router.get('/settings', async (_req: Request, res: Response) => {
  ok(res, await getPublicSettings());
});

// PUBLIC lead capture for the booking frontend "Your details" step —
// unauthenticated by design (no requireAuth; CORS unchanged). Creates a Lead
// with stage NEW_ENQUIRY; every booking-steps datum is persisted to a
// first-class Lead column (v2 field-sync — see core/leads.ts) and `note`
// carries only the message head. Pre-v2 note-packed rows still read via the
// legacy parser fallback in serializeLead.
// Dedupe: repeat idempotencyKey (24h) or same email+mobile+branch within
// 10 min returns the existing row with 200 instead of a duplicate.
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const publicLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.preprocess(emptyToNull, z.string().trim().max(254).email().nullable().optional()),
    mobile: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
    purpose: z.preprocess(emptyToNull, z.enum(['personal', 'business']).nullable().optional()),
    companyName: z.preprocess(emptyToNull, z.string().trim().max(120).nullable().optional()),
    uen: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
    branchCode: z.preprocess(emptyToNull, z.string().trim().max(10).nullable().optional()),
    preferredBranchId: z.preprocess(emptyToNull, z.string().trim().min(1).nullable().optional()),
    preferredSize: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
    unitCode: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
    moveInDate: z.preprocess(
      emptyToNull,
      z
        .string()
        .trim()
        .max(40)
        .nullable()
        .optional()
        .refine((v) => v == null || !Number.isNaN(Date.parse(v)), { message: 'moveInDate must be a parseable date string' }),
    ),
    durationMonths: z.number().int().positive().nullable().optional(),
    monthlyRate: z.number().nonnegative().nullable().optional(),
    message: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
    source: z.preprocess(emptyToNull, z.enum(['WEBSITE', 'WHATSAPP', 'REFERRAL', 'GOOGLE']).nullable().optional()),
    consentPdpa: z
      .boolean()
      .nullable()
      .optional()
      .refine((v) => v == null || v === true, { message: 'consentPdpa must be true when supplied' }),
    consentMarketing: z.boolean().nullable().optional(),
    protectionTier: z.preprocess(emptyToNull, z.string().trim().max(80).nullable().optional()),
    protectionCost: z.number().nonnegative().nullable().optional(),
    addons: z
      .array(
        z.object({
          id: z.string().trim().max(80).optional(),
          name: z.string().trim().min(1).max(120),
          qty: z.number().int().positive(),
          price: z.number().nonnegative(),
        }),
      )
      .max(20)
      .nullable()
      .optional(),
    promoCode: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
    promoDiscountAmt: z.number().nonnegative().nullable().optional(),
    movingService: z.boolean().nullable().optional(),
    totalDueToday: z.number().nonnegative().nullable().optional(),
    idempotencyKey: z.preprocess(emptyToNull, z.string().trim().max(80).nullable().optional()),
  })
  .refine((v) => Boolean(v.email ?? v.mobile), { message: 'At least one of email or mobile is required' });

router.post('/leads', publicLeadLimiter, async (req: Request, res: Response) => {
  const parsed = publicLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid lead payload', parsed.error.flatten());
    return;
  }
  const v = parsed.data;
  const { lead, deduped } = await createPublicLead({
    name: v.name,
    email: v.email ?? null,
    mobile: v.mobile ?? null,
    purpose: v.purpose ?? null,
    companyName: v.companyName ?? null,
    uen: v.uen ?? null,
    branchCode: v.branchCode ?? null,
    preferredBranchId: v.preferredBranchId ?? null,
    preferredSize: v.preferredSize ?? null,
    unitCode: v.unitCode ?? null,
    moveInDate: v.moveInDate ?? null,
    durationMonths: v.durationMonths ?? null,
    monthlyRate: v.monthlyRate ?? null,
    message: v.message ?? null,
    source: v.source ?? undefined,
    consentPdpa: v.consentPdpa ?? null,
    consentMarketing: v.consentMarketing ?? null,
    protectionTier: v.protectionTier ?? null,
    protectionCost: v.protectionCost ?? null,
    addons: v.addons ?? null,
    promoCode: v.promoCode ?? null,
    promoDiscountAmt: v.promoDiscountAmt ?? null,
    movingService: v.movingService ?? null,
    totalDueToday: v.totalDueToday ?? null,
    idempotencyKey: v.idempotencyKey ?? null,
  });
  if (deduped) {
    ok(res, lead);
    return;
  }
  created(res, lead);
});

export default router;
