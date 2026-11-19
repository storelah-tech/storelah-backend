import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { MARKET_PSF } from './market';

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export async function getActionItems() {
  const now = new Date();
  const startTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const startDayAfter = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);

  const overdueTenants = await prisma.tenant.findMany({
    where: { status: 'OVERDUE' },
    include: { unit: true },
  });

  const dueSoon = await prisma.tenant.findMany({
    where: { nextPayment: { gte: startTomorrow, lt: startDayAfter } },
    include: { unit: true },
  });

  const belowMarket = await prisma.unit
    .findMany({ where: { status: 'OCCUPIED' }, include: { size: true } })
    .then((units) =>
      units
        .filter((u) => {
          const market = MARKET_PSF[u.size.code];
          if (!market) return false;
          const psf = toNum(u.monthlyRate) / u.sqft;
          return psf < market * 0.92;
        })
        .slice(0, 8),
    );

  // A-21: open Finance change requests (transfers, move-out settlements and
  // manual refunds returned to Operations). Newest first, capped so one
  // backlog never crowds out the other queues.
  const changeRequests = await prisma.settlementChangeRequest.findMany({
    where: { status: 'OPEN', settlement: { status: 'CHANGES_REQUESTED' } },
    include: { settlement: { select: { ref: true, tenant: { select: { name: true } } } } },
    orderBy: { requestedAt: 'desc' },
    take: 8,
  });
  const assigneeIds = [...new Set(changeRequests.map((c) => c.assigneeId).filter((v): v is string => !!v))];
  const assigneeNames = new Map(
    assigneeIds.length
      ? (
          await prisma.adminUser.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } })
        ).map((u) => [u.id, u.name] as const)
      : [],
  );

  const items = [
    // A-21: Finance change requests are Operations work items too — the
    // Command centre queue lists every open return (transfers, move-out
    // settlements and manual refunds) alongside the existing action items.
    // The chosen assignee additionally gets a StaffNotification (their
    // Overview notification queue); team-only returns surface here with no
    // user pinged.
    ...changeRequests.map((c) => {
      const due = ymd(c.dueDate);
      const who = assigneeNames.get(c.assigneeId ?? '') ?? c.assignTeam ?? 'Operations';
      return {
        icon: '📋',
        tone: 'red',
        title: `Finance change requested · ${c.settlement.ref} — ${c.settlement.tenant.name}`,
        desc: `${c.category} · ${who}${due ? ` · due ${due}` : ''} · asked by ${c.requestedBy}. ${c.reason}`.slice(0, 300),
        time: due ? `Due ${due}` : 'No due date',
        action: 'Review',
      };
    }),
    ...overdueTenants.map((t) => ({
      icon: '🚨',
      tone: 'red',
      title: `${t.name} — ${t.unit?.unitCode ?? ''} — overdue`,
      desc: `$${toNum(t.monthlyRate)} outstanding. ${t.missedPayments} missed payment(s). Consider access restriction.`,
      time: 'Today',
      action: 'Send Final Notice',
    })),
    ...(dueSoon.length
      ? [
          {
            icon: '⏰',
            tone: 'amber',
            title: `${dueSoon.length} payment${dueSoon.length > 1 ? 's' : ''} due tomorrow — ${dueSoon.map((t) => t.name).join(', ')}`,
            desc: `Total $${dueSoon.reduce((s, t) => s + toNum(t.monthlyRate), 0).toLocaleString()} due. Confirm bank details are valid.`,
            time: 'Tomorrow',
            action: 'Review',
          },
        ]
      : []),
    ...belowMarket.map((u) => ({
      icon: '📈',
      tone: 'terra',
      title: `Rate review — ${u.unitCode} below market`,
      desc: `${u.size.name} unit at $${toNum(u.monthlyRate)}/mo is 8%+ below the ${u.size.code} market of $${MARKET_PSF[u.size.code]}/psf.`,
      time: 'This week',
      action: 'Review Rates',
    })),
  ];

  return items;
}