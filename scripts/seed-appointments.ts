// One-shot idempotent seed: populates ~12 appointments across the current week.
// Idempotent: deletes all existing Appointment rows first.
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

function day(y: number, m: number, d: number, h = 0, min = 0) {
  return new Date(y, m, d, h, min, 0, 0);
}

async function main() {
  const branches = await prisma.branch.findMany({ select: { id: true, code: true } });
  const branchMap = Object.fromEntries(branches.map((b) => [b.code, b.id]));

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = now.getDate();
  // Monday of the current week
  const dow = now.getDay(); // 0=Sun, 1=Mon…
  const mon = today - (dow === 0 ? 6 : dow - 1);

  // eslint-disable-next-line no-console
  console.log(`Seeding appointments for week starting ${y}-${String(m + 1).padStart(2, '0')}-${String(mon).padStart(2, '0')}`);

  // Clear existing appointments
  await prisma.appointment.deleteMany();

  const data = [
    // ---- Today (3-5 items) ----
    {
      title: 'Woodlands viewing',
      personName: 'Sarah Tan',
      type: 'VIEWING' as const,
      branchId: branchMap['WD'] ?? null,
      startAt: day(y, m, today, 9, 30),
      endAt: day(y, m, today, 10, 0),
      status: 'CONFIRMED' as const,
    },
    {
      title: 'Pricing callback',
      personName: 'Jason Lee',
      type: 'CALLBACK' as const,
      branchId: null,
      startAt: day(y, m, today, 11, 0),
      endAt: day(y, m, today, 11, 15),
      status: 'PENDING' as const,
    },
    {
      title: 'BM unit viewing',
      personName: 'Nadia Mohd',
      type: 'VIEWING' as const,
      branchId: branchMap['BM'] ?? null,
      startAt: day(y, m, today, 14, 0),
      endAt: day(y, m, today, 14, 30),
      status: 'CONFIRMED' as const,
    },
    {
      title: 'Video consultation',
      personName: 'Ahmad Fauzi',
      type: 'VIDEO_CONSULT' as const,
      branchId: null,
      startAt: day(y, m, today, 15, 30),
      endAt: day(y, m, today, 16, 0),
      status: 'CONFIRMED' as const,
    },
    // ---- This week (spread Mon-Fri) ----
    {
      title: 'Ubi move-in',
      personName: 'Priya Nair',
      type: 'MOVE_IN' as const,
      branchId: branchMap['UB'] ?? null,
      startAt: day(y, m, mon + 1, 10, 0),
      endAt: day(y, m, mon + 1, 11, 0),
      status: 'CONFIRMED' as const,
    },
    {
      title: 'Woodlands callback',
      personName: 'Kenji Wong',
      type: 'CALLBACK' as const,
      branchId: branchMap['WD'] ?? null,
      startAt: day(y, m, mon + 1, 14, 0),
      endAt: day(y, m, mon + 1, 14, 15),
      status: 'PENDING' as const,
    },
    {
      title: 'BM viewing — large unit',
      personName: 'Siti Rahman',
      type: 'VIEWING' as const,
      branchId: branchMap['BM'] ?? null,
      startAt: day(y, m, mon + 2, 11, 0),
      endAt: day(y, m, mon + 2, 11, 45),
      status: 'CONFIRMED' as const,
    },
    {
      title: 'Video walkthrough',
      personName: 'Marcus Lim',
      type: 'VIDEO_CONSULT' as const,
      branchId: null,
      startAt: day(y, m, mon + 2, 16, 0),
      endAt: day(y, m, mon + 2, 16, 30),
      status: 'CONFIRMED' as const,
    },
    {
      title: 'Ubi viewing',
      personName: 'Mei Ling',
      type: 'VIEWING' as const,
      branchId: branchMap['UB'] ?? null,
      startAt: day(y, m, mon + 3, 9, 0),
      endAt: day(y, m, mon + 3, 9, 30),
      status: 'PENDING' as const,
    },
    {
      title: 'Woodlands move-in',
      personName: 'Ravi Kumar',
      type: 'MOVE_IN' as const,
      branchId: branchMap['WD'] ?? null,
      startAt: day(y, m, mon + 3, 13, 30),
      endAt: day(y, m, mon + 3, 14, 30),
      status: 'CONFIRMED' as const,
    },
    {
      title: 'BM callback — pricing',
      personName: 'Priyanka Das',
      type: 'CALLBACK' as const,
      branchId: branchMap['BM'] ?? null,
      startAt: day(y, m, mon + 4, 10, 30),
      endAt: day(y, m, mon + 4, 10, 45),
      status: 'PENDING' as const,
    },
    {
      title: 'Ubi video consultation',
      personName: 'Zul Fadli',
      type: 'VIDEO_CONSULT' as const,
      branchId: branchMap['UB'] ?? null,
      startAt: day(y, m, mon + 4, 15, 0),
      endAt: day(y, m, mon + 4, 15, 30),
      status: 'CONFIRMED' as const,
    },
  ];

  for (const row of data) {
    await prisma.appointment.create({ data: row });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${data.length} appointments`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
