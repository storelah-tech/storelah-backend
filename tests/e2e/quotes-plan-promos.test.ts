// Create quotation: promotion PLANS (discount matrix / free months, no code)
// from the promotion library are offered in GET /quotes/promo-options and can
// be attached with promoPlanId on POST /quotations (re-scored server-side).
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, seedMoveInWorld, PIN } from './fixtures';

const CMS = '/api/v1/cms';

async function seedPlans() {
  const matrix = await prisma.promotionPlan.create({
    data: {
      kind: 'DISCOUNT_MATRIX',
      name: 'E2E matrix',
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01'),
      matrixCells: { create: { sizeCategory: 'SMALL', accessType: 'Standard', commitmentMonths: 6, discountPct: 10 } },
    },
  });
  const free = await prisma.promotionPlan.create({
    data: {
      kind: 'FREE_MONTHS',
      name: 'E2E stay 12 pay 10',
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01'),
      commitmentMonths: 12,
      freeMonths: { create: [{ monthIndex: 10 }, { monthIndex: 11 }] },
    },
  });
  await prisma.promotionPlan.create({
    data: { kind: 'DISCOUNT_MATRIX', name: 'E2E draft', status: 'DRAFT', effectiveFrom: new Date('2026-01-01') },
  });
  return { matrixId: matrix.id, freeId: free.id };
}

describe('quotation promotion plans', () => {
  let auth: string;
  let plans: { matrixId: string; freeId: string };

  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    auth = (await createOperator('OWNER')).auth;
    plans = await seedPlans();
  });

  it('lists active plans scored against the unit and term', async () => {
    const six = await api
      .get(`${CMS}/quotes/promo-options?rate=120&months=6&unitCode=${PIN.rentableUnit}`)
      .set('Authorization', auth);
    expect(six.status).toBe(200);
    const rows = six.body.data as Array<{ planId: string | null; valid: boolean; discountAmt: number; name: string }>;
    expect(rows.find((r) => r.planId === plans.matrixId)).toMatchObject({ valid: true, discountAmt: 12 });
    expect(rows.find((r) => r.planId === plans.freeId)).toMatchObject({ valid: false });
    expect(rows.some((r) => r.name === 'E2E draft')).toBe(false);
    expect(six.body.meta.best).toMatchObject({ planId: plans.matrixId });

    const twelve = await api
      .get(`${CMS}/quotes/promo-options?rate=120&months=12&unitCode=${PIN.rentableUnit}`)
      .set('Authorization', auth);
    const r12 = twelve.body.data as Array<{ planId: string | null; valid: boolean; discountAmt: number }>;
    // 2 free months over 12 = 20/month equivalent; no 12-month matrix cell.
    expect(r12.find((r) => r.planId === plans.freeId)).toMatchObject({ valid: true, discountAmt: 20 });
    expect(r12.find((r) => r.planId === plans.matrixId)).toMatchObject({ valid: false });
  });

  it('POST /quotations with promoPlanId sets promoPct from the plan', async () => {
    const lead = await prisma.lead.create({ data: { name: 'Plan quote lead' } });
    const res = await api
      .post(`${CMS}/quotations`)
      .set('Authorization', auth)
      .send({ leadId: lead.id, unitCode: PIN.rentableUnit, grossRate: 120, promoPlanId: plans.matrixId, commitmentMonths: 6 });
    expect(res.status).toBe(201);
    const q = await prisma.quotation.findFirst({ where: { leadId: lead.id } });
    expect(Number(q?.promoPct)).toBe(10);
    const after = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(Number(after?.promoDiscountAmt)).toBe(12);
  });

  it('POST /quotations rejects a plan that does not apply to the term', async () => {
    const lead = await prisma.lead.create({ data: { name: 'Short term plan lead' } });
    const res = await api
      .post(`${CMS}/quotations`)
      .set('Authorization', auth)
      .send({ leadId: lead.id, unitCode: PIN.rentableUnit, grossRate: 120, promoPlanId: plans.freeId, commitmentMonths: 6 });
    expect(res.status).toBe(400);
    expect(await prisma.quotation.count({ where: { leadId: lead.id } })).toBe(0);
  });
});
