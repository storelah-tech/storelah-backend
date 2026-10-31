-- Expenditure ledger detail for Budgets & Expenses parity (spec §13.4).
-- Additive only: three nullable text columns + a status with a default, so
-- every existing row reads as a PAID (actual) line exactly as before.
ALTER TABLE "Expense" ADD COLUMN "description" TEXT;
ALTER TABLE "Expense" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PAID';
ALTER TABLE "Expense" ADD COLUMN "note" TEXT;
