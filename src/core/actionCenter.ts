import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { MARKET_PSF } from './market';

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

  const items = [
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