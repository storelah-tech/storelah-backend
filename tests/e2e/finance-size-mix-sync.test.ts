// Size mix Sync pulls real lettable inventory only (owner 2026-11-07): retired
// (INACTIVE) units and unpublished floor-plan drafts (DRAFT) are left out.

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './fixtures';
import { getPricing } from '../../src/core/finance/pricing';

describe('size mix sync — live inventory', () => {
  beforeEach(resetDb);

  it('counts available/occupied/blocked units and skips INACTIVE and DRAFT', async () => {
    const size = await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 26, sqftTo: 60, sortOrder: 1 } });
    const branch = await prisma.branch.create({ data: { code: 'SY', name: 'Sync Bay', address: '1 Sync Rd', operatingHours: '9-9' } });
    const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
    const statuses = ['AVAILABLE', 'OCCUPIED', 'BLOCKED', 'INACTIVE', 'DRAFT'] as const;
    for (const [i, status] of statuses.entries()) {
      await prisma.unit.create({ data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: String(9100 + i), sqft: 40, monthlyRate: 200, status } });
    }
    await prisma.unit.create({ data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: '9199', sqft: 40, monthlyRate: 200, deletedAt: new Date() } });

    const p = await getPricing({ branchId: branch.id });
    expect(p.facilityUnits).toBe(3);
    expect(p.facilityNla).toBe(120);
    expect(p.rows.find((r) => r.code === 'SMALL')).toMatchObject({ units: 3, nlaSqft: 120 });
  });
});
