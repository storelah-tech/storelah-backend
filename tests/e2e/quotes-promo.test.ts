// Quotation promotion auto-fill: promo-options ranking, promo-validate, and
// server-side re-validation on POST /quotes (client hint only — see
// resolveQuotationPromo in src/core/quotes.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';

async function seedPromos() {
  await prisma.promotion.create({
    data: { code: 'Q10', name: 'Quote 10%', discountType: 'PERCENTAGE', discountValue: 10, active: true },
  });
  await prisma.promotion.create({
    data: {
      code: 'QOLD',
      name: 'Expired',
      discountType: 'PERCENTAGE',
      discountValue: 50,
      active: true,
      endDate: new Date(Date.now() - 86400000),
    },
  });
  await prisma.promotion.create({
    data: {
      code: 'Q12M',
      name: 'Long stay',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      active: true,
      minMonths: 12,
    },
  });
}

describe('quotation promotions', () => {
  let auth: string;

  beforeEach(async () => {
    await resetDb();
    auth = (await createOperator('OWNER')).auth;
    await seedPromos();
  });

  it('promo-options ranks the best valid code first and flags inapplicable ones', async () => {
    const res = await api.get(`${CMS}/quotes/promo-options?rate=100&months=6`).set('Authorization', auth);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ code: string; valid: boolean; discountAmt: number }>;
    expect(rows[0]).toMatchObject({ code: 'Q10', valid: true, discountAmt: 10 });
    expect(res.body.meta.best).toMatchObject({ code: 'Q10' });
    // Expired: not an active promotion, so not offered at all.
    expect(rows.some((r) => r.code === 'QOLD')).toBe(false);
    // Below minMonths: listed but invalid.
    expect(rows.find((r) => r.code === 'Q12M')).toMatchObject({ valid: false });
  });

  it('promo-validate accepts a good code and reports a bad one as invalid', async () => {
    const good = await api
      .post(`${CMS}/quotes/promo-validate`)
      .set('Authorization', auth)
      .send({ code: 'Q10', rate: 100, months: 6 });
    expect(good.status).toBe(200);
    expect(good.body.data).toMatchObject({ valid: true, discountAmt: 10 });
    const bad = await api
      .post(`${CMS}/quotes/promo-validate`)
      .set('Authorization', auth)
      .send({ code: 'NOPE', rate: 100, months: 6 });
    expect(bad.status).toBe(200);
    expect(bad.body.data.valid).toBe(false);
  });

  it('POST /quotes auto-fills a blank discount and rejects invalid codes', async () => {
    const good = await api
      .post(`${CMS}/quotes`)
      .set('Authorization', auth)
      .send({ name: 'Promo Lead', monthlyRate: 100, durationMonths: 6, promoCode: 'Q10' });
    expect(good.status).toBe(201);
    const lead = await api.get(`${CMS}/leads/${good.body.data.quote.id}`).set('Authorization', auth);
    expect(lead.status).toBe(200);
    expect(lead.body.data).toMatchObject({ promoCode: 'Q10', promoDiscountAmt: 10 });

    for (const [name, promoCode] of [
      ['Bad Promo', 'NOPE'],
      ['Old Promo', 'QOLD'],
      ['Short Stay', 'Q12M'],
    ] as const) {
      const res = await api
        .post(`${CMS}/quotes`)
        .set('Authorization', auth)
        .send({ name, monthlyRate: 100, durationMonths: 6, promoCode });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
  });

  it('POST /quotes keeps a manual discount without a code', async () => {
    const res = await api
      .post(`${CMS}/quotes`)
      .set('Authorization', auth)
      .send({ name: 'Manual', monthlyRate: 100, durationMonths: 6, promoDiscountAmt: 7 });
    expect(res.status).toBe(201);
    const lead = await api.get(`${CMS}/leads/${res.body.data.quote.id}`).set('Authorization', auth);
    expect(lead.body.data).toMatchObject({ promoCode: null, promoDiscountAmt: 7 });
  });
});
