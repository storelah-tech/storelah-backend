// Singpass review feedback (2026-10-27): the Myinfo review form must show
// the FULL NRIC/FIN as retrieved; after confirmation only the masked value is
// kept, and the pending row never holds it in a form readable without the
// review token.

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './fixtures';
import {
  confirmSingpassReview,
  createPendingSingpassVerification,
  getSingpassReview,
} from '../../src/core/verifications';

const PERSON = {
  sub: 'sp-sub-1',
  uinfin: 'S9812381D',
  name: 'TAN XIAO HUI',
  dob: '1990-01-01',
  regadd: '1 SAMPLE ROAD #01-01 Singapore 100001',
  mobileno: '+6597399245',
  email: 'sample@example.test',
};

describe('Singpass Myinfo review · NRIC display', () => {
  beforeEach(resetDb);

  it('shows the full NRIC/FIN on review, stores it only sealed while pending, masked after confirm', async () => {
    const token = await createPendingSingpassVerification('SL-REVIEW-1', PERSON);
    const id = token.split('.')[0];

    const review = await getSingpassReview(token);
    expect(review.verified.uinfin).toBe(PERSON.uinfin);

    const pending = await prisma.verification.findUniqueOrThrow({ where: { id } });
    expect(JSON.stringify(pending.payload)).not.toContain(PERSON.uinfin);

    // A wrong secret can't open the review (and so never the NRIC).
    await expect(getSingpassReview(`${id}.wrong`)).rejects.toMatchObject({ status: 404 });

    await confirmSingpassReview(token, {});
    const confirmed = await prisma.verification.findUniqueOrThrow({ where: { id } });
    const payload = confirmed.payload as Record<string, unknown>;
    expect(payload.uinfinMasked).toBe('S****381D');
    expect(payload.uinfinSealed).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(PERSON.uinfin);
  });
});
