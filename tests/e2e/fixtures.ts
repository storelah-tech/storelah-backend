// Per-suite fixture builder for the backend move-in E2E suite.
//
// Every spec calls resetDb() first (truncate + cascade on the ISOLATED test
// DB only — see test-db.ts), then seedMoveInWorld() to build a pinned world:
// branch BM, floor L1 (authored plan with real placements) + floor L2
// (plan-less, for the plan:null empty state), and one unit per edge case with
// pinned unitCodes. Emails are unique per test (`e2e+<uuid>@test.local`) so
// Customer/Tenant uniqueness never collides across tests.

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { assertSafeTestDb } from './test-db';

export const api = request(app);

export const PIN = {
  branchCode: 'BM',
  level: 1,
  planlessLevel: 2,
  rentableUnit: 'BM-01-01',
  guestUnit: 'BM-01-02',
  occupiedUnit: 'BM-01-03',
  blockedUnit: 'BM-01-04',
  deletedUnit: 'BM-01-05',
  maintenanceUnit: 'BM-01-06',
} as const;

export function uniqueEmail(): string {
  return `e2e+${randomUUID()}@test.local`;
}

export function futureMoveInISO(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

/** Truncate every table in the isolated test DB (never dev — guarded). */
export async function resetDb(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  assertSafeTestDb(url);
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  )) as Array<{ tablename: string }>;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

export interface MoveInWorld {
  branchId: string;
  floorId: string;
  planlessFloorId: string;
}

/**
 * Pinned world: SMALL size, branch BM with floors L1 (plan + placements) and
 * L2 (no plan), and one unit per scenario. All units are 50 sqft with 5×10 ft
 * placement rects (1 grid unit = 1 ft) at non-overlapping positions.
 */
export async function seedMoveInWorld(): Promise<MoveInWorld> {
  const size = await prisma.unitSize.create({
    data: {
      code: 'SMALL',
      name: 'Small',
      sqftFrom: 30,
      sqftTo: 80,
      widthFt: 5,
      heightFt: 10,
      sortOrder: 2,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      code: PIN.branchCode,
      name: 'Bukit Merah (E2E)',
      address: '11 Jalan Bukit Merah, Singapore 159478',
      operatingHours: '9am – 9pm daily',
    },
  });

  const floor = await prisma.floor.create({
    data: { branchId: branch.id, level: PIN.level, name: 'Level 1' },
  });
  const planlessFloor = await prisma.floor.create({
    data: { branchId: branch.id, level: PIN.planlessLevel, name: 'Level 2' },
  });

  async function makeUnit(unitCode: string, status: 'AVAILABLE' | 'OCCUPIED' | 'BLOCKED' | 'MAINTENANCE', rate = 120) {
    return prisma.unit.create({
      data: {
        branchId: branch.id,
        floorId: floor.id,
        sizeId: size.id,
        unitCode,
        sqft: 50,
        monthlyRate: rate,
        status,
        climateControl: 'Ambient climate',
      },
    });
  }

  const rentable = await makeUnit(PIN.rentableUnit, 'AVAILABLE', 120);
  const guest = await makeUnit(PIN.guestUnit, 'AVAILABLE', 130);
  await makeUnit(PIN.occupiedUnit, 'OCCUPIED', 140);
  await makeUnit(PIN.blockedUnit, 'BLOCKED', 150);
  const deleted = await makeUnit(PIN.deletedUnit, 'AVAILABLE', 160);
  await makeUnit(PIN.maintenanceUnit, 'MAINTENANCE', 170);

  await prisma.unit.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

  // Real floor-plan layout: the authored canvas with placements joined to the
  // live unit rows (the booking renderer reads this via GET /floor-plans).
  const plan = await prisma.floorPlan.create({
    data: { floorId: floor.id, width: 70, height: 80 },
  });
  const rects = [
    { x: 2, y: 2 },
    { x: 10, y: 2 },
    { x: 18, y: 2 },
    { x: 26, y: 2 },
    { x: 34, y: 2 },
  ];
  const placedUnits = [rentable, guest];
  // Occupied/blocked/maintenance units are placed too (real layouts show every
  // non-deleted unit); the soft-deleted unit keeps NO placement surfacing.
  const others = await prisma.unit.findMany({
    where: { branchId: branch.id, deletedAt: null, id: { notIn: placedUnits.map((u) => u.id) } },
    orderBy: { unitCode: 'asc' },
  });
  const allPlaced = [...placedUnits, ...others];
  for (let i = 0; i < allPlaced.length; i++) {
    const origin = rects[i % rects.length];
    const row = Math.floor(i / rects.length);
    await prisma.unitPlacement.create({
      data: {
        floorPlanId: plan.id,
        unitId: allPlaced[i].id,
        x: origin.x,
        y: origin.y + row * 12,
        width: 5,
        height: 10,
      },
    });
  }

  return { branchId: branch.id, floorId: floor.id, planlessFloorId: planlessFloor.id };
}

export { prisma };
