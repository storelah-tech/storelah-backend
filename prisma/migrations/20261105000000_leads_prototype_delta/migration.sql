-- Leads prototype delta (2026-11-04 handover). Additive: new enum values,
-- nullable columns, two new tables. Existing leads keep their stage values;
-- the CMS relabels them to the prototype stage names.

-- Prototype stages that have no stored equivalent yet (PG12+: ADD VALUE is
-- allowed inside the migration transaction because nothing below uses them).
ALTER TYPE "LeadStage" ADD VALUE 'QUALIFIED' BEFORE 'VIEWING_BOOKED';
ALTER TYPE "LeadStage" ADD VALUE 'PAID_BOOKING' BEFORE 'WON';
ALTER TYPE "LeadStage" ADD VALUE 'NURTURING' AFTER 'LOST';

ALTER TYPE "LeadSource" ADD VALUE 'PHONE';
ALTER TYPE "LeadSource" ADD VALUE 'WALK_IN';
ALTER TYPE "LeadSource" ADD VALUE 'PARTNER';

ALTER TYPE "AppointmentStatus" ADD VALUE 'AWAITING_REPLY' AFTER 'CONFIRMED';
ALTER TYPE "AppointmentStatus" ADD VALUE 'READY' AFTER 'AWAITING_REPLY';

-- Lead: identity + enquiry fields.
ALTER TABLE "Lead" ADD COLUMN "accessFrequency" TEXT,
ADD COLUMN "enquiryDate" DATE,
ADD COLUMN "representative" TEXT,
ADD COLUMN "leadNo" INTEGER;

-- SL-<leadNo>: number existing leads 1001.. in creation order, then let the
-- sequence continue after the highest number.
UPDATE "Lead" l SET "leadNo" = n.rn + 1000
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Lead") n
WHERE l."id" = n."id";
CREATE SEQUENCE "Lead_leadNo_seq" START WITH 1001 MINVALUE 1001 OWNED BY "Lead"."leadNo";
-- Continue after the highest backfilled number (is_called=false when empty so the first lead is 1001).
SELECT setval('"Lead_leadNo_seq"', COALESCE((SELECT MAX("leadNo") FROM "Lead"), 1001), (SELECT COUNT(*) > 0 FROM "Lead"));
ALTER TABLE "Lead" ALTER COLUMN "leadNo" SET DEFAULT nextval('"Lead_leadNo_seq"'),
ALTER COLUMN "leadNo" SET NOT NULL;
CREATE UNIQUE INDEX "Lead_leadNo_key" ON "Lead"("leadNo");

-- Date of enquiry for existing leads = the Singapore date they were created.
UPDATE "Lead" SET "enquiryDate" = ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Singapore')::date
WHERE "enquiryDate" IS NULL;

-- Quotation register fields; DRAFT quotes have no PDF until sent.
ALTER TABLE "Quotation" ADD COLUMN "commitmentMonths" INTEGER,
ADD COLUMN "delivery" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "grossRate" DECIMAL(10,2),
ADD COLUMN "promoPct" DECIMAL(5,2),
ADD COLUMN "protectionMonthly" DECIMAL(10,2),
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SENT',
ADD COLUMN "voidReason" TEXT,
ADD COLUMN "voidedAt" TIMESTAMP(3),
ADD COLUMN "voidedBy" TEXT,
ALTER COLUMN "pdf" DROP NOT NULL;

ALTER TABLE "Appointment" ADD COLUMN "staff" TEXT;

CREATE TABLE "RecordNote" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "mentions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecordNote_entityType_entityId_idx" ON "RecordNote"("entityType", "entityId");

CREATE TABLE "StaffNotification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "actor" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffNotification_recipientId_readAt_idx" ON "StaffNotification"("recipientId", "readAt");
ALTER TABLE "StaffNotification" ADD CONSTRAINT "StaffNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
