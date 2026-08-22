-- Add GUEST to AccountType.
-- Auto-provisioned during unauthenticated (guest) booking checkout: customers
-- created by POST /api/v1/customer/bookings without a bearer token get type
-- GUEST and a bcrypt-hashed default password until they register properly.
-- Applied manually via `prisma db execute` + `migrate resolve` because the dev
-- database carries pre-existing drift (20260820030247_add_customer_profile_fields
-- is applied remotely but missing from this checkout) and `migrate dev` would
-- otherwise demand a destructive reset. See decisions log 2026-08-22.

ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'GUEST';
