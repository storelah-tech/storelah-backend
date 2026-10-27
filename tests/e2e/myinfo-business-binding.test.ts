// Myinfo Business phase 2 (2026-10-27): POST /customer/bookings binds a
// confirmed Myinfo Business verification to the tenant — verified company
// data overrides the client's, the row binds once, and anything invalid
// falls back to the typed company details, unverified.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';
import {
  confirmBusinessReview,
  createPendingBusinessVerification,
} from '../../src/core/verifications';
import { listTenants } from '../../src/core/tenants';

const DRAFT = 'DRAFT-0123456789ABCDEF';
const ENTITY = {
  sub: 'cp-sub-1',
  entityName: 'SAMPLE TRADING PTE. LTD.',
  uen: '201900001Z',
  uenStatus: 'Live Company',
  entityType: 'Local Company',
  registeredAddress: '1 RAFFLES PLACE #20-01 Singapore 048616',
  corppassEmail: 'admin@sample-trading.test',
};

async function confirmedVerification(draftRef = DRAFT): Promise<string> {
  const token = await createPendingBusinessVerification(draftRef, ENTITY);
  const { verification } = await confirmBusinessReview(token, {});
  return verification.id;
}

function book(unitCode: string, extra: Record<string, unknown>, email = uniqueEmail()) {
  return api.post('/api/v1/customer/bookings').send({
    unitCode, moveInDate: futureMoveInISO(), durationMonths: 1, email, name: 'Ops Lead', mobile: '81234567', ...extra,
  });
}

const tenantOf = async (bookingRef: string) =>
  (await prisma.booking.findUniqueOrThrow({ where: { bookingRef }, include: { tenant: true } })).tenant;

describe('Myinfo Business binding at booking submit', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('binds a confirmed verification: verified data overrides the typed company, row re-keyed to the booking', async () => {
    const verificationId = await confirmedVerification();
    const res = await book(PIN.rentableUnit, {
      companyName: 'Typed Co',
      uen: 'TYPED123',
      myinfoBusiness: { verificationId, draftRef: DRAFT },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.companyVerified).toBe(true);

    const tenant = await tenantOf(res.body.data.bookingRef);
    expect(tenant).toMatchObject({
      type: 'BUSINESS',
      companyName: ENTITY.entityName,
      uen: ENTITY.uen,
      companyAddress: ENTITY.registeredAddress,
      companyVerificationId: verificationId,
    });
    expect(tenant.companyVerifiedAt).toBeInstanceOf(Date);

    const row = await prisma.verification.findUniqueOrThrow({ where: { id: verificationId } });
    expect(row).toMatchObject({ tenantId: tenant.id, bookingRef: res.body.data.bookingRef });
    expect((row.payload as { draftRef?: string }).draftRef).toBe(DRAFT);

    const customer = await prisma.customer.findFirstOrThrow({ where: { email: tenant.email! } });
    expect(customer).toMatchObject({ companyName: ENTITY.entityName, uen: ENTITY.uen });

    // CMS row carries the company + verified stamp; the company check is not
    // mistaken for the person's identity verification.
    const cms = (await listTenants()).find((t) => t.id === tenant.id)!;
    expect(cms).toMatchObject({ companyName: ENTITY.entityName, uen: ENTITY.uen });
    expect(cms.companyVerifiedAt).not.toBeNull();
    expect(cms.latestVerification).toBeNull();
  });

  it('a verification binds once — a second booking with it stays unverified', async () => {
    const verificationId = await confirmedVerification();
    const ref = { myinfoBusiness: { verificationId, draftRef: DRAFT } };
    expect((await book(PIN.rentableUnit, ref)).body.data.companyVerified).toBe(true);

    const second = await book(PIN.guestUnit, { ...ref, companyName: 'Other Co', uen: 't999' });
    expect(second.status).toBe(201);
    expect(second.body.data.companyVerified).toBe(false);
    const tenant = await tenantOf(second.body.data.bookingRef);
    expect(tenant).toMatchObject({ companyName: 'Other Co', uen: 'T999', companyVerifiedAt: null, companyVerificationId: null });
  });

  it('rejects a wrong draft ref, an unconfirmed review and a stale confirmation — the booking still goes through', async () => {
    const email = uniqueEmail();
    const verificationId = await confirmedVerification();
    const wrongDraft = await book(PIN.rentableUnit, {
      companyName: 'Typed Co',
      myinfoBusiness: { verificationId, draftRef: 'DRAFT-FFFFFFFFFFFFFFFF' },
    }, email);
    expect(wrongDraft.status).toBe(201);
    expect(wrongDraft.body.data.companyVerified).toBe(false);
    expect((await tenantOf(wrongDraft.body.data.bookingRef)).companyName).toBe('Typed Co');
    // Untouched, still claimable by the right draft.
    expect((await prisma.verification.findUniqueOrThrow({ where: { id: verificationId } })).tenantId).toBeNull();

    const pendingToken = await createPendingBusinessVerification('DRAFT-AAAAAAAAAAAAAAAA', ENTITY);
    const pending = await book(PIN.guestUnit, {
      myinfoBusiness: { verificationId: pendingToken.split('.')[0], draftRef: 'DRAFT-AAAAAAAAAAAAAAAA' },
    });
    expect(pending.body.data.companyVerified).toBe(false);

    await prisma.verification.update({
      where: { id: verificationId },
      data: { verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    // Same booker re-books their held unit.
    const stale = await book(PIN.rentableUnit, { myinfoBusiness: { verificationId, draftRef: DRAFT } }, email);
    expect(stale.status).toBe(201);
    expect(stale.body.data.companyVerified).toBe(false);
  });

  it('manual company details are stored unverified; personal bookings leave the company empty', async () => {
    const manual = await book(PIN.rentableUnit, { companyName: '  Acme Pte Ltd ', uen: ' 202012345k ' });
    expect(manual.body.data.companyVerified).toBe(false);
    expect(await tenantOf(manual.body.data.bookingRef)).toMatchObject({
      type: 'BUSINESS',
      companyName: 'Acme Pte Ltd',
      uen: '202012345K',
      companyVerifiedAt: null,
    });

    const personal = await book(PIN.guestUnit, {});
    expect(await tenantOf(personal.body.data.bookingRef)).toMatchObject({ companyName: null, uen: null });
  });

  it('retyping the verified UEN on a later booking keeps the verified company', async () => {
    const email = uniqueEmail();
    const verificationId = await confirmedVerification();
    await book(PIN.rentableUnit, { myinfoBusiness: { verificationId, draftRef: DRAFT } }, email);
    const later = await book(PIN.guestUnit, { companyName: 'Sample Trading', uen: ENTITY.uen.toLowerCase() }, email);
    const tenant = await tenantOf(later.body.data.bookingRef);
    expect(tenant.companyName).toBe(ENTITY.entityName);
    expect(tenant.companyVerifiedAt).not.toBeNull();
  });
});
