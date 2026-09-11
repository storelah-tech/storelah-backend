import {
  PrismaClient,
  AccountType,
  UnitStatus,
  TenantStatus,
  LeadStage,
  LeadSource,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();

const SIZES = {
  LOCKER: { name: 'Locker', sqft: 12, psf: 5.2, sort: 1 },
  SMALL: { name: 'Small', sqft: 30, psf: 4.8, sort: 2 },
  MEDIUM: { name: 'Medium', sqft: 60, psf: 4.4, sort: 3 },
  LARGE: { name: 'Large', sqft: 120, psf: 3.8, sort: 4 },
} as const;
type SizeKey = keyof typeof SIZES;

interface U {
  n: number;
  size: SizeKey;
  psf: number;
  status: UnitStatus;
}

interface Selector {
  id: string;
  sqft: number;
  size: SizeKey;
  code: string;
  monthly: number;
  status: UnitStatus;
}

// Bukit Merah Level 1 — mix of legacy dashboard units and synthetic seeds
// (generated via genSeeds to match the same density as other branches).
// BM L1 gets the same 60-unit layout as every other floor.
const BM_L1: U[] = ((s: Record<number, U[]>) => s[1] ?? [])(genSeeds('BM'));

function genSeeds(_branch: string): Record<number, U[]> {
  // 60 units per level for every branch → rich floor plan with X+Y scroll
  const out: Record<number, U[]> = {};
  for (const lv of [1, 2, 3, 4]) {
    const level = Number(lv);
    const arr: U[] = [];
    for (let i = 0; i < 60; i++) {
      const sizeOrder: SizeKey[] = ['SMALL', 'MEDIUM', 'SMALL', 'LOCKER', 'LARGE', 'MEDIUM', 'SMALL', 'LOCKER', 'MEDIUM', 'SMALL'];
      const size = sizeOrder[i % sizeOrder.length];
      const psf = Math.round((SIZES[size].psf + 0.08 * Math.sin(i * 1.5)) * 100) / 100;
      // Status distribution: ~60% AVAILABLE, ~20% RESERVED, ~20% OCCUPIED
      let status: UnitStatus;
      const r = (level * 13 + i * 7) % 20;
      if (r < 12) status = 'AVAILABLE';
      else if (r < 16) status = 'RESERVED';
      else status = 'OCCUPIED';
      arr.push({ n: i + 1, size, psf, status });
    }
    out[level] = arr;
  }
  return out;
}

const REAL_TENANTS: Array<{
  name: string; unit: string; type: AccountType; segment: string; rate: number;
  sinceMonths: number; payInDays: number; status: TenantStatus; pay: number; missed: number; ltv: number;
}> = [
  { name:'Priya Nair', unit:'BM-01-01', type:'BUSINESS', segment:'E-commerce', rate:144, sinceMonths:14, payInDays:12, status:'ACTIVE', pay:14, missed:0, ltv:2016 },
  { name:'Aisha & Farid', unit:'BM-01-05', type:'PERSONAL', segment:'Renovation', rate:264, sinceMonths:5, payInDays:1, status:'DUE_SOON', pay:5, missed:0, ltv:1320 },
  { name:'Mr & Mrs Tan', unit:'BM-01-06', type:'PERSONAL', segment:'Downsizing', rate:138, sinceMonths:21, payInDays:-30, status:'OVERDUE', pay:20, missed:2, ltv:2760 },
  { name:'Wei Ming Lim', unit:'WD-02-03', type:'PERSONAL', segment:'Between homes', rate:456, sinceMonths:2, payInDays:1, status:'ACTIVE', pay:2, missed:0, ltv:912 },
  { name:'Ravi Kumar', unit:'UB-03-01', type:'BUSINESS', segment:'SME inventory', rate:480, sinceMonths:7, payInDays:1, status:'ACTIVE', pay:7, missed:0, ltv:4480 },
];

const LEADS: Array<{ name: string; type: AccountType; size: SizeKey; branch: string; stage: LeadStage; source: LeadSource }> = [
  { name:'Sarah Lim', type:'PERSONAL', size:'SMALL', branch:'BM', stage:'NEW_ENQUIRY', source:'WEBSITE' },
  { name:'James Koh', type:'PERSONAL', size:'MEDIUM', branch:'WD', stage:'NEW_ENQUIRY', source:'WEBSITE' },
  { name:'Mei Ling', type:'PERSONAL', size:'LARGE', branch:'UB', stage:'NEW_ENQUIRY', source:'REFERRAL' },
  { name:'David Ng', type:'BUSINESS', size:'LARGE', branch:'UB', stage:'CONTACTED', source:'GOOGLE' },
  { name:'Siti Rahman', type:'PERSONAL', size:'SMALL', branch:'BM', stage:'CONTACTED', source:'WHATSAPP' },
  { name:'Ahmad Fauzi', type:'BUSINESS', size:'MEDIUM', branch:'WD', stage:'VIEWING_BOOKED', source:'WHATSAPP' },
  { name:'TechFlow Pte Ltd', type:'BUSINESS', size:'LARGE', branch:'UB', stage:'PROPOSAL_SENT', source:'GOOGLE' },
  { name:'Priya Nair', type:'BUSINESS', size:'SMALL', branch:'BM', stage:'WON', source:'WEBSITE' },
];

const namePool = [
  'Cassandra Lim', 'Farhan Osman', 'Grace Tan', 'Hafiz Rahman', 'Isabella Chua',
  'Jonathan Teo', 'Karen Yap', 'Lester Wong', 'Maya Krishnan', 'Nurul Huda',
  'Owen Goh', 'Pei Ling Chia', 'Quentin Ng', 'Rachel Neo', 'Samuel Tan',
  'Thara Devi', 'Uma Rajan', 'Victor Lee', 'Wendy Ong', 'Xander Phua',
];
const segmentPool = ['Renovation', 'Downsizing', 'Between homes', 'E-commerce', 'SME inventory', 'Archives', 'Seasonal gear'];
const typePool: AccountType[] = ['PERSONAL', 'PERSONAL', 'PERSONAL', 'BUSINESS'];

function dayOffset(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

function monthAgo(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setMonth(d.getMonth() - n);
  return d;
}

/** Generate placement geometry for N units on a 40×40 floor plan grid.
 *  Units sit in 6 rows of 10, with a central corridor. Each unit is 3×3 grid
 *  units, with varying column spans to create visual variety. */
function getPlacementPositions(count: number): Array<{ x: number; y: number; width: number; height: number }> {
  const positions: Array<{ x: number; y: number; width: number; height: number }> = [];
  // 10 columns per row, unit width varies but fits in 3-4 spaces
  const colStarts = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28];
  const rows = [1, 5, 9, 16, 20, 24];
  for (const y of rows) {
    for (const x of colStarts) {
      if (positions.length >= count) break;
      positions.push({ x, y, width: 2, height: 3 });
    }
    if (positions.length >= count) break;
  }
  return positions;
}

async function main() {
  console.log('Seeding StoreLah CMS…');

  await prisma.$transaction([
    prisma.booking.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.rateChange.deleteMany(),
    prisma.tenant.deleteMany(),
    prisma.lead.deleteMany(),
    prisma.floorPlanBlock.deleteMany(),
    prisma.unitPlacement.deleteMany(),
    prisma.floorPlan.deleteMany(),
    prisma.unit.deleteMany(),
    prisma.floor.deleteMany(),
    prisma.branch.deleteMany(),
    prisma.unitSize.deleteMany(),
    prisma.adminUser.deleteMany(),
  ]);

  // Admin from env so a one-shot CLOUD seed (deploy runbook Phase A) creates the
  // login the deployed Lambda actually uses; local dev falls back to the old
  // defaults. STORELAH_ADMIN_EMAIL/PASSWORD are also the /config + Lambda env
  // values, so seed → login stays consistent everywhere.
  const adminEmail = process.env.STORELAH_ADMIN_EMAIL || 'admin@storelah.sg';
  const adminPassword = process.env.STORELAH_ADMIN_PASSWORD || 'password';
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await prisma.adminUser.create({
    data: { email: adminEmail, name: 'Faisal Z.', passwordHash, role: 'MANAGER' },
  });

  const sizeIds: Record<SizeKey, string> = {} as any;
  for (const [code, s] of Object.entries(SIZES)) {
    const rec = await prisma.unitSize.create({
      data: { code, name: s.name, sqftFrom: s.sqft, sqftTo: s.sqft, sortOrder: s.sort },
    });
    sizeIds[code as SizeKey] = rec.id;
  }

  const branches = [
    { code: 'BM', name: 'Bukit Merah', address: '11 Jalan Bukit Merah, Singapore 159478', floors: 4 },
    { code: 'WD', name: 'Woodlands', address: '12 Woodlands Loop, Singapore 738999', floors: 4 },
    { code: 'UB', name: 'Ubi', address: '13 Ubi Close, Singapore 409761', floors: 4 },
  ];

  const branchMap = new Map<string, { id: string; floorId: (l: number) => string }>();

  for (const b of branches) {
    const branch = await prisma.branch.create({
      data: { code: b.code, name: b.name, address: b.address, operatingHours: 'Mon–Sun 7am–11pm' },
    });
    const floorIds: Record<number, string> = {};
    for (let l = 1; l <= b.floors; l++) {
      const f = await prisma.floor.create({
        data: { branchId: branch.id, level: l, name: `Level ${l}` },
      });
      floorIds[l] = f.id;
    }
    branchMap.set(b.code, { id: branch.id, floorId: (l) => floorIds[l] });
  }

  const unitByCode = new Map<string, Selector>();

  const mkUnit = async (branchCode: string, level: number, n: number, size: SizeKey, psf: number, status: UnitStatus) => {
    const { id: branchId, floorId } = branchMap.get(branchCode)!;
    const code = `${branchCode}-${String(level).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    const sqft = SIZES[size].sqft;
    const monthly = Math.round(psf * sqft);
    await prisma.unit.create({
      data: {
        branchId,
        floorId: floorId(level),
        sizeId: sizeIds[size],
        unitCode: code,
        sqft,
        monthlyRate: monthly,
        status,
        climateControl: 'Ambient climate',
      },
    });
    const created = await prisma.unit.findUnique({ where: { unitCode: code } });
    unitByCode.set(code, { id: created!.id, sqft, size, code, monthly, status });
  };

  for (const s of BM_L1) await mkUnit('BM', 1, s.n, s.size, s.psf, s.status);
  let next = 61;
  for (const lv of [2, 3, 4]) {
    const seeds = genSeeds('BM')[lv] ?? [];
    for (const u of seeds) await mkUnit('BM', lv, next++, u.size, u.psf, u.status);
  }
  for (const code of ['WD', 'UB']) {
    let start = 1;
    for (const lv of [1, 2, 3, 4]) {
      const seeds = genSeeds(code)[lv] ?? [];
      for (const u of seeds) await mkUnit(code, lv, start++, u.size, u.psf, u.status);
    }
  }

  // ── Publish floor plans for every floor ──
  console.log('Publishing floor plans…');
  // Build a unit map per floor for placement
  const unitsByFloor = new Map<string, { code: string; id: string }[]>();
  for (const [code, sel] of unitByCode) {
    const branchCode = code.split('-')[0];
    const level = Number(code.split('-')[1]);
    const branchMapEntry = branchMap.get(branchCode);
    if (!branchMapEntry) continue;
    const fId = branchMapEntry.floorId(level);
    if (!unitsByFloor.has(fId)) unitsByFloor.set(fId, []);
    unitsByFloor.get(fId)!.push({ code, id: sel.id });
  }

  for (const [floorId, floorUnits] of unitsByFloor) {
     // Upsert floor plan (40×30 canvas)
     const plan = await prisma.floorPlan.upsert({
       where: { floorId },
       create: { floorId, width: 40, height: 30 },
       update: { width: 40, height: 30 },
     });
     // Delete stale placements/blocks (on re-seed)
     await prisma.unitPlacement.deleteMany({ where: { floorPlanId: plan.id } });
     await prisma.floorPlanBlock.deleteMany({ where: { floorPlanId: plan.id } });

     // Create blocks: corridor, lift, stairs, entrance
     await prisma.floorPlanBlock.createMany({
       data: [
{ floorPlanId: plan.id, name: 'Corridor', x: 0, y: 13, width: 40, height: 2, color: '#E9E1D0' },
          { floorPlanId: plan.id, name: 'Lift', x: 32, y: 1, width: 4, height: 5, color: '#D4C9B8' },
          { floorPlanId: plan.id, name: 'Stairs', x: 32, y: 18, width: 4, height: 5, color: '#D4C9B8' },
          { floorPlanId: plan.id, name: 'Entrance', x: 17, y: 0, width: 3, height: 1, color: '#C5E0B4' },
       ],
     });

     // Create placements in a grid layout
     const positions = getPlacementPositions(floorUnits.length);
     await prisma.unitPlacement.createMany({
       data: floorUnits.slice(0, positions.length).map((u, i) => ({
         floorPlanId: plan.id,
         unitId: u.id,
         x: positions[i].x,
         y: positions[i].y,
         width: positions[i].width,
         height: positions[i].height,
       })),
     });
  }
  const planCount = await prisma.floorPlan.count();
  console.log(`Floor plans: ${planCount}`);

  const occupied = [...unitByCode.values()].filter((u) =>
    u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED');

  const generated: string[] = [];
  let nameIdx = 0;
  for (const u of occupied) {
    generated.push(u.code);
    const real = REAL_TENANTS.find((r) => r.unit === u.code);
    const start = monthAgo(real ? real.sinceMonths : nameIdx % 18);
    const pay = real ? real.pay : 2 + (nameIdx % 15);
    const rate = real ? real.rate : u.monthly;
    await prisma.tenant.create({
      data: {
        name: real ? real.name : namePool[nameIdx++ % namePool.length],
        type: real ? real.type : typePool[nameIdx % 4],
        segment: real ? real.segment : segmentPool[nameIdx % segmentPool.length],
        email: `${real ? real.name : namePool[(nameIdx - 1) % namePool.length]}@example.com`
          .toLowerCase()
          .replace(/\s+/g, '.')
          .replace(/[^a-z0-9.@]/g, ''),
        unitId: u.id,
        moveInDate: start,
        monthlyRate: rate,
        psf: rate / u.sqft,
        nextPayment: real
          ? dayOffset(real.payInDays)
          : dayOffset(u.status === 'OVERDUE' ? -30 : 1),
        status: real ? real.status : u.status === 'OVERDUE' ? 'OVERDUE' : 'ACTIVE',
        autoDebit: real ? true : nameIdx % 3 !== 0,
        missedPayments: real ? real.missed : u.status === 'OVERDUE' ? 1 + (nameIdx % 2) : 0,
        paymentCount: pay,
        lifetimeValue: rate * pay,
      },
    });
  }

  // Rate history for BM-01-01 (from dashboard unit detail)
  const bm001 = await prisma.unit.findUnique({ where: { unitCode: 'BM-01-01' } });
  if (bm001) {
    await prisma.rateChange.createMany({
      data: [
        { unitId: bm001.id, date: monthAgo(1), previous: 136, current: 144, changePct: 5.88, reason: 'Annual review', appliedBy: 'Faisal Z.' },
        { unitId: bm001.id, date: monthAgo(7), previous: 130, current: 136, changePct: 4.61, reason: 'CPI adjustment', appliedBy: 'System' },
      ],
    });
  }

  // Leads
  for (const l of LEADS) {
    const branch = await prisma.branch.findUnique({ where: { code: l.branch } });
    await prisma.lead.create({
      data: { name: l.name, type: l.type, segment: null, stage: l.stage, source: l.source, preferredSize: l.size, preferredBranchId: branch?.id ?? null },
    });
  }

  // Invoices: current billing cycle per tenant
  const allTenants = await prisma.tenant.findMany({ where: { unitId: { not: null } } });
  const invoiceData = allTenants.map((t, i) => {
    const overdue = t.status === 'OVERDUE';
    const dueSoon = t.status === 'DUE_SOON';
    return {
      invoiceNo: `INV-2026-${String(8410 + i).padStart(4, '0')}`,
      tenantId: t.id,
      unitId: t.unitId!,
      amount: t.monthlyRate,
      dueDate: t.nextPayment ?? dayOffset(1),
      status: overdue ? 'OVERDUE' : dueSoon ? 'DUE' : 'PAID',
      method: t.autoDebit ? 'Auto-debit' : 'Card',
      billedMonth: monthAgo(1),
    };
  });
  await prisma.invoice.createMany({ data: invoiceData as any });

  // Bookings: 3 confirmed move-ins today (units prepped, PINs ready)
  const today = new Date();
  const availUnits = await prisma.unit.findMany({ where: { status: 'AVAILABLE' }, take: 3 });
  const moveIns = [
    { tenant: 'Ahmad Fauzi', hour: 11, minute: 0, duration: '3 months' },
    { tenant: 'Sarah Lim', hour: 14, minute: 0, duration: 'Monthly' },
    { tenant: 'James Koh', hour: 16, minute: 0, duration: '6 months' },
  ];
  const bookingRefs = ['SL-2026-0912', 'SL-2026-0913', 'SL-2026-0914'];
  for (let i = 0; i < moveIns.length; i++) {
    const unit = availUnits[i];
    if (!unit) break;
    const t = await prisma.tenant.create({
      data: {
        name: moveIns[i].tenant,
        type: i === 0 ? 'BUSINESS' : 'PERSONAL',
        segment: i === 0 ? 'SME' : i === 1 ? 'Renovation' : 'Between homes',
        monthlyRate: unit.monthlyRate,
        psf: unit.monthlyRate.toNumber() / unit.sqft,
        status: 'ACTIVE',
        nextPayment: dayOffset(30),
      },
    });
    const moveIn = new Date(today);
    moveIn.setHours(moveIns[i].hour, moveIns[i].minute, 0, 0);
    await prisma.booking.create({
      data: {
        bookingRef: bookingRefs[i],
        tenantId: t.id,
        unitId: unit.id,
        moveInDate: moveIn,
        duration: moveIns[i].duration,
        amount: unit.monthlyRate,
        status: 'CONFIRMED',
      },
    });
  }

  const tenantCount = await prisma.tenant.count();
  const unitCount = await prisma.unit.count();
  console.log(
    `Seeded: ${unitCount} units, ${tenantCount} tenants, ${generated.length} occupied slots, ${LEADS.length} leads, 1 admin.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());