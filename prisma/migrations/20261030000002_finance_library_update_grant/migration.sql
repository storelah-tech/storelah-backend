-- Finance Phase 2 — grant `bill-library:update` (submit / duplicate / restore /
-- archive / save-version, spec §16.3) to the Finance Operator and Finance
-- Approver roles. Approve/reject/set-current stay approver-only
-- (`bill-library:approve`, unchanged). Additive permission rows only; Owner
-- is untouched (ensureSystemRoles already keeps it on ALL_PERMISSIONS).

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_finance_operator_bill_library_update', 'role_finance_operator', 'bill-library:update'),
  ('role_finance_approver_bill_library_update', 'role_finance_approver', 'bill-library:update')
ON CONFLICT ("roleId", "permission") DO NOTHING;
