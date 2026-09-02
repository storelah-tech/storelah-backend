import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, fail } from '../lib/http';
import {
  requireCustomerAuth,
  extractCustomerPayload,
  hasAuthorizationHeader,
} from '../middleware/auth';
import {
  registerCustomer,
  loginCustomer,
  claimGuestAccount,
  forgotPassword,
  resetPassword,
  getCustomerProfile,
  loadCustomer,
  findOrCreateGuestCustomer,
  createCustomerBooking,
  listCustomerBookings,
  getCustomerPortal,
  submitCustomerRequest,
  submitCustomerNotice,
} from '../core/customers';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  mobile: z.string().optional(),
  password: z.string().min(6),
  type: z.enum(['PERSONAL', 'BUSINESS']).default('PERSONAL'),
  companyName: z.string().optional(),
  uen: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Guest portal-password setup: public on purpose (no requireCustomerAuth) —
// identity is proven by the bookingRef delivered on confirmation + email +
// mobile, not by a session.
const claimSchema = z.object({
  email: z.string().trim().email(),
  bookingRef: z.string().trim().min(1),
  mobile: z.string().trim().min(6),
  password: z.string().trim().min(6),
});

const createBookingSchema = z.object({
  unitCode: z.string().min(1),
  moveInDate: z.string().datetime(),
  durationMonths: z.number().int().positive(),
  protectionPlan: z.object({ tier: z.string(), cost: z.number().nonnegative() }).optional(),
  addons: z
    .array(z.object({ name: z.string(), qty: z.number().int().nonnegative(), price: z.number().nonnegative() }))
    .optional(),
  promoCode: z.string().optional(),
  movingService: z.boolean().optional(),
  totalDueToday: z.number().nonnegative().optional(),
  // Guest checkout (flat fields, sent by the booking frontend on every submit):
  // required only when the request carries NO Authorization header.
  email: z.string().email().optional(),
  name: z.string().optional(),
  mobile: z.string().optional(),
});

const requestSchema = z.object({
  type: z.enum(['UPSIZE', 'DOWNSIZE', 'TRANSFER']),
  notes: z.string().optional(),
  preferredDate: z.string().optional(),
});

const noticeSchema = z.object({
  unitId: z.string().min(1),
  lastDay: z.string().datetime(),
});

function customerFrom(req: Request) {
  return (req as any).customer;
}

router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid registration payload', parsed.error.flatten());
    return;
  }
  created(res, await registerCustomer(parsed.data));
});

router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 401, 'UNAUTHORIZED', 'Invalid email or password');
    return;
  }
  ok(res, await loginCustomer(parsed.data));
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
});

// Public: rotates a GUEST account's shared default password to a real one.
router.post('/claim', async (req: Request, res: Response) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid claim payload', parsed.error.flatten());
    return;
  }
  ok(res, await claimGuestAccount(parsed.data, req.ip ?? 'unknown'));
});

router.post('/forgot-password', async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid request', parsed.error.flatten());
    return;
  }
  ok(res, await forgotPassword(parsed.data));
});

router.post('/reset-password', async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid request', parsed.error.flatten());
    return;
  }
  ok(res, await resetPassword(parsed.data));
});

router.get('/me', requireCustomerAuth, async (req: Request, res: Response) => {
  ok(res, await getCustomerProfile(customerFrom(req)));
});

// Dual-mode booking creation:
//  - WITH Authorization header → authenticated customer (unchanged behavior;
//    a present-but-invalid token is a hard 401, never downgraded to guest).
//  - WITHOUT any header → guest checkout: body must include a valid `email`;
//    the customer record is found-or-created (new ones saved as GUEST with a
//    bcrypt-hashed default password) and the booking linked to it.
router.post('/bookings', async (req: Request, res: Response) => {
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid booking payload', parsed.error.flatten());
    return;
  }

  if (hasAuthorizationHeader(req)) {
    const payload = extractCustomerPayload(req);
    const customer = await loadCustomer(payload);
    created(res, await createCustomerBooking(customer, parsed.data));
    return;
  }

  if (!parsed.data.email) {
    fail(res, 400, 'VALIDATION', 'A valid email is required to complete your booking');
    return;
  }
  const guest = await findOrCreateGuestCustomer({
    email: parsed.data.email,
    name: parsed.data.name,
    mobile: parsed.data.mobile,
  });
  created(res, await createCustomerBooking(guest, parsed.data));
});

router.get('/bookings', requireCustomerAuth, async (req: Request, res: Response) => {
  ok(res, await listCustomerBookings(customerFrom(req)));
});

router.get('/portal', requireCustomerAuth, async (req: Request, res: Response) => {
  ok(res, await getCustomerPortal(customerFrom(req)));
});

router.post('/requests', requireCustomerAuth, async (req: Request, res: Response) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid request payload', parsed.error.flatten());
    return;
  }
  created(res, await submitCustomerRequest(customerFrom(req), parsed.data));
});

router.post('/notice', requireCustomerAuth, async (req: Request, res: Response) => {
  const parsed = noticeSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, 'VALIDATION', 'Invalid notice payload', parsed.error.flatten());
    return;
  }
  ok(res, await submitCustomerNotice(customerFrom(req), parsed.data));
});

export default router;
