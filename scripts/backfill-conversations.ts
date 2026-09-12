// One-off backfill: give every lead without a thread one conversation plus
// its opening inbound message (derived from the lead row itself — no canned
// review copy). Safe to re-run: skips leads that already have a thread.
// LOCAL ONLY — never run against the cloud DB.
import { prisma } from '../src/lib/prisma';
import { ConversationChannel } from '@prisma/client';

const SOURCE_TO_CHANNEL: Record<string, ConversationChannel> = {
  WHATSAPP: 'WHATSAPP',
  WEBSITE: 'WEBSITE',
};

async function main() {
  const leads = await prisma.lead.findMany({
    include: { conversations: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });
  let created = 0;
  for (const lead of leads) {
    if (lead.conversations.length) continue;
    const channel = SOURCE_TO_CHANNEL[lead.source] ?? 'WEBSITE';
    const body = lead.note ?? `New enquiry${lead.preferredSize ? ` — ${lead.preferredSize}` : ''}`;
    await prisma.conversation.create({
      data: {
        leadId: lead.id,
        channel,
        messages: {
          create: { direction: 'IN', sender: lead.name, body, sentAt: lead.createdAt },
        },
      },
    });
    created++;
  }
  console.log(`backfill-conversations: ${created} thread(s) created, ${leads.length - created} skipped`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
