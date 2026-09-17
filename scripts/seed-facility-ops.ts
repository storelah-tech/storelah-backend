// Targeted facility-operations seed: representative rows for the 5 new
// sidebar modules (maintenance, assets & vendors, incidents, access control,
// inspections & compliance). Idempotent: wipes ONLY the new facility-ops
// tables (they hold no pre-existing data) and recreates the rows below.
// Never touches units/tenants/leads/finance — use `pnpm db:seed-facility-ops`.
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

const day = (offsetDays: number, h = 9, min = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, min, 0, 0);
  return d;
};

async function main() {
  const branch = (await prisma.branch.findFirst({ where: { code: 'BM' } })) ??
    (await prisma.branch.findFirst());
  if (!branch) throw new Error('No branches found — run pnpm db:seed first');
  const branchId = branch.id;
  const unit = await prisma.unit.findFirst({ where: { branchId, deletedAt: null } });

  // Wipe only the new tables (idempotent re-runs).
  await prisma.accessEvent.deleteMany();
  await prisma.accessCredential.deleteMany();
  await prisma.accessDoor.deleteMany();
  await prisma.accessPolicy.deleteMany();
  await prisma.complianceCertificate.deleteMany();
  await prisma.inspectionChecklist.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.preventiveTask.deleteMany();
  await prisma.workOrder.deleteMany();

  // ---- Maintenance ----
  await prisma.workOrder.createMany({
    data: [
      {
        title: 'Service lobby aircon cassette',
        description: 'Weak cooling reported at the lobby unit.',
        branchId,
        unitId: unit?.id ?? null,
        status: 'OPEN',
        priority: 'High',
        value: 280,
        assignee: 'Ah Seng',
        dueDate: day(3),
      },
      {
        title: 'Replace corridor downlights L2',
        branchId,
        status: 'IN_PROGRESS',
        priority: 'Medium',
        value: 150,
        assignee: 'Mei',
        dueDate: day(5),
      },
      {
        title: 'Quarterly fire panel test',
        branchId,
        status: 'DONE',
        priority: 'Medium',
        value: 0,
        completedAt: day(-2),
      },
    ],
  });

  const categories = ['HVAC', 'FIRE', 'DOORS', 'CCTV'] as const;
  const pcts = [75, 50, 100, 25];
  for (let i = 0; i < categories.length; i++) {
    await prisma.preventiveTask.create({
      data: {
        title: `${categories[i]} monthly walkthrough`,
        category: categories[i],
        branchId,
        percentComplete: pcts[i],
        dueDate: day(7),
      },
    });
  }

  // ---- Assets & vendors ----
  await prisma.asset.createMany({
    data: [
      {
        code: `AST-${branch.code}-HVAC-04`,
        name: 'Lobby cassette aircon #4',
        category: 'HVAC',
        branchId,
        status: 'ACTIVE',
        value: 3200,
      },
      {
        code: `AST-${branch.code}-CCTV-01`,
        name: 'NVR + 8ch camera kit',
        category: 'CCTV',
        branchId,
        status: 'IN_SERVICE',
        value: 5400,
      },
    ],
  });

  await prisma.vendor.createMany({
    data: [
      { name: 'CoolServe Engineering', service: 'HVAC servicing', sla: '4h response', ytdSpend: 8600, status: 'ACTIVE', contact: '+65 6123 4567' },
      { name: 'SecureEye Systems', service: 'CCTV maintenance', sla: 'Next business day', ytdSpend: 3200, status: 'ACTIVE' },
    ],
  });

  // ---- Incidents ----
  await prisma.incident.create({
    data: {
      title: 'Water seepage near lift lobby',
      description: 'Damp patch reported by cleaner; monitor after rain.',
      severity: 'CRITICAL',
      status: 'OPEN',
      branchId,
      unitId: unit?.id ?? null,
      checklist: [
        { label: 'Isolate affected area', done: true },
        { label: 'Notify building manager', done: false },
        { label: 'Arrange waterproofing contractor', done: false },
      ],
      reportedBy: 'Ops hotline',
    },
  });

  // ---- Access control ----
  const door = await prisma.accessDoor.create({
    data: { code: `${branch.code}-GATE-01`, name: 'Main gate', branchId, location: 'Level 1 entrance', status: 'ACTIVE' },
  });
  const perm = await prisma.accessCredential.create({
    data: { holderName: 'Nur Aisyah', type: 'PERMANENT', status: 'ACTIVE', branchId },
  });
  const temp = await prisma.accessCredential.create({
    data: { holderName: 'Contractor — Ravi', type: 'TEMPORARY', status: 'ACTIVE', branchId, validFrom: day(0), validTo: day(7) },
  });
  await prisma.accessPolicy.create({
    data: { name: 'Contractor hours', description: 'Contractors may enter 9am–6pm weekdays.', scope: `${branch.code} · all doors`, active: true },
  });
  await prisma.accessEvent.createMany({
    data: [
      { doorId: door.id, credentialId: perm.id, branchId, result: 'GRANTED', occurredAt: day(0, 8, 55) },
      { doorId: door.id, credentialId: temp.id, branchId, result: 'GRANTED', occurredAt: day(0, 9, 5) },
      { doorId: door.id, credentialId: null, branchId, result: 'DENIED', occurredAt: day(0, 2, 14), note: 'Unknown fob after hours' },
    ],
  });

  // ---- Inspections & compliance ----
  await prisma.inspectionChecklist.createMany({
    data: [
      {
        title: 'Daily opening walkthrough',
        frequency: 'DAILY',
        branchId,
        items: [
          { label: 'Lights + signage on', done: true },
          { label: 'Corridors clear', done: true },
          { label: 'CCTV wall live', done: false },
        ],
        percentComplete: 66,
        status: 'IN_PROGRESS',
        dueDate: day(0, 18),
      },
      {
        title: 'Monthly fire equipment check',
        frequency: 'MONTHLY',
        branchId,
        items: [
          { label: 'Extinguishers in date', done: false },
          { label: 'Hose reels accessible', done: false },
        ],
        percentComplete: 0,
        status: 'OPEN',
        dueDate: day(14),
      },
    ],
  });

  await prisma.complianceCertificate.createMany({
    data: [
      { name: 'Fire Safety Certificate', type: 'Fire Safety', branchId, issuer: 'SCDF', expiryDate: day(200), status: 'VALID' },
      { name: 'Lift service certificate', type: 'Lift', branchId, issuer: 'LiftCo', expiryDate: day(30), status: 'EXPIRING' },
      { name: 'Public liability policy', type: 'Public Liability', branchId, issuer: 'Insurer', expiryDate: day(400), status: 'VALID' },
    ],
  });

  // eslint-disable-next-line no-console
  console.log('Seeded facility operations for branch', branch.code);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
