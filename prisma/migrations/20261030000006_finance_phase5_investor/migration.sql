-- Finance Phase 5 — Investor role + masked-summary view grant (spec §15.4).
--
-- Additive only: one new AdminRole row (INVESTOR, seeded with zero members —
-- the Owner assigns operators to it in Global Settings › Team & access) plus
-- `bill-investor:view` permission rows for the Owner and the three Finance
-- roles. No existing row is touched; ON CONFLICT DO NOTHING makes the
-- migration idempotent. Owner rows are belt-and-braces (ensureSystemRoles
-- already rebuilds the Owner matrix from ALL_PERMISSIONS on boot/seed).

INSERT INTO "AdminRole" ("id", "key", "name", "description", "isSystem", "updatedAt") VALUES
  ('role_investor', 'INVESTOR', 'Investor', 'Masked approved-only summary (modelling + returns + closed months). No mutations, no customer data.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_investor_bill_investor_view', 'role_investor', 'bill-investor:view'),
  ('role_owner_bill_investor_view', 'role_owner', 'bill-investor:view'),
  ('role_finance_operator_bill_investor_view', 'role_finance_operator', 'bill-investor:view'),
  ('role_finance_approver_bill_investor_view', 'role_finance_approver', 'bill-investor:view'),
  ('role_finance_auditor_bill_investor_view', 'role_finance_auditor', 'bill-investor:view')
ON CONFLICT ("roleId", "permission") DO NOTHING;
