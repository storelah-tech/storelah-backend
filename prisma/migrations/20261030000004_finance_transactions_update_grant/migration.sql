-- Finance Phase 3 — grant `bill-transactions:update` (cancel a queued/failed
-- instruction: mistake recovery, customer-paid-at-counter) to the Finance
-- Operator and Finance Approver roles. Charging (approve/submit) stays
-- approver-only (`bill-transactions:approve`, unchanged). Additive permission
-- rows only; Owner is untouched (ensureSystemRoles already keeps it on
-- ALL_PERMISSIONS).

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_finance_operator_bill_transactions_update', 'role_finance_operator', 'bill-transactions:update'),
  ('role_finance_approver_bill_transactions_update', 'role_finance_approver', 'bill-transactions:update')
ON CONFLICT ("roleId", "permission") DO NOTHING;
