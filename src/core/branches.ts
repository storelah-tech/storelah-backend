import { prisma } from '../lib/prisma';

export async function listBranches() {
  const branches = await prisma.branch.findMany({
    include: {
      _count: { select: { units: true, tenants: true, leads: true } },
      floors: { select: { level: true }, orderBy: { level: 'asc' } },
    },
    orderBy: { code: 'asc' },
  });

  return branches.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    address: b.address,
    operatingHours: b.operatingHours,
    status: b.status,
    floors: b.floors.map((f) => f.level),
    unitCount: b._count.units,
    tenantCount: b._count.tenants,
    leadCount: b._count.leads,
  }));
}

// Customer-facing branch list: no internal counters, only availability.
export async function listPublicBranches() {
  const branches = await prisma.branch.findMany({
    include: {
      floors: { select: { level: true }, orderBy: { level: 'asc' } },
      units: { select: { status: true } },
    },
    orderBy: { code: 'asc' },
  });

  return branches.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    address: b.address,
    operatingHours: b.operatingHours,
    floors: b.floors.map((f) => f.level),
    availableUnits: b.units.filter((u) => u.status === 'AVAILABLE').length,
  }));
}

export async function getMoveIns() {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const bookings = await prisma.booking.findMany({
    where: { moveInDate: { gte: startToday, lt: startTomorrow } },
    include: { tenant: true, unit: true },
  });

  return bookings.map((b) => ({
    ref: b.bookingRef,
    tenant: b.tenant.name,
    unit: b.unit.unitCode,
    moveInDate: b.moveInDate,
    duration: b.duration,
    status: b.status,
  }));
}