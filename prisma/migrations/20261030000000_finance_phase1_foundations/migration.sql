-- Finance module Phase 1 foundations (FINANCE_MODULE_SPEC §§6/16.5/21).
--
-- Additive only: two brand-new tables, three seeded roles with zero members,
-- and the Owner delta for the 9 new bill-* resources. No drops, no renames,
-- no changes to Invoice / Tenant / Booking. Invoice lifecycle widening,
-- Tenant billing columns and every other §1 table land in later phases.

-- CreateTable
CREATE TABLE "FinanceAuditEvent" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "source" TEXT,
    "correlationId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "FinanceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinanceAuditEvent_entityType_entityId_idx" ON "FinanceAuditEvent"("entityType", "entityId");
CREATE INDEX "FinanceAuditEvent_correlationId_idx" ON "FinanceAuditEvent"("correlationId");
CREATE INDEX "FinanceAuditEvent_occurredAt_idx" ON "FinanceAuditEvent"("occurredAt");
CREATE INDEX "FinanceEvent_status_idx" ON "FinanceEvent"("status");
CREATE INDEX "FinanceEvent_correlationId_idx" ON "FinanceEvent"("correlationId");
CREATE INDEX "FinanceEvent_type_idx" ON "FinanceEvent"("type");

ALTER TABLE "FinanceAuditEvent" ADD CONSTRAINT "FinanceAuditEvent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seeded Finance roles (zero members; the Owner assigns operators in Team & access).

INSERT INTO "AdminRole" ("id", "key", "name", "description", "isSystem", "updatedAt") VALUES
  ('role_finance_operator', 'FINANCE_OPERATOR', 'Finance Operator', 'Day-to-day finance work. Cannot approve anything or touch the protected lease line.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "AdminRole" ("id", "key", "name", "description", "isSystem", "updatedAt") VALUES
  ('role_finance_approver', 'FINANCE_APPROVER', 'Finance Approver', 'Everything the Finance Operator has, plus approvals. Maker-checker enforced in service code.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "AdminRole" ("id", "key", "name", "description", "isSystem", "updatedAt") VALUES
  ('role_finance_auditor', 'FINANCE_AUDITOR', 'Finance Auditor', 'Read-only view of all finance areas. No mutations.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_finance_operator_bill_overview_view', 'role_finance_operator', 'bill-overview:view'),
  ('role_finance_operator_bill_invoices_view', 'role_finance_operator', 'bill-invoices:view'),
  ('role_finance_operator_bill_arrears_view', 'role_finance_operator', 'bill-arrears:view'),
  ('role_finance_operator_bill_transactions_view', 'role_finance_operator', 'bill-transactions:view'),
  ('role_finance_operator_bill_models_view', 'role_finance_operator', 'bill-models:view'),
  ('role_finance_operator_bill_performance_view', 'role_finance_operator', 'bill-performance:view'),
  ('role_finance_operator_bill_budgets_view', 'role_finance_operator', 'bill-budgets:view'),
  ('role_finance_operator_bill_pricing_view', 'role_finance_operator', 'bill-pricing:view'),
  ('role_finance_operator_bill_returns_view', 'role_finance_operator', 'bill-returns:view'),
  ('role_finance_operator_bill_library_view', 'role_finance_operator', 'bill-library:view'),
  ('role_finance_operator_bill_credits_view', 'role_finance_operator', 'bill-credits:view'),
  ('role_finance_operator_bill_reconciliation_view', 'role_finance_operator', 'bill-reconciliation:view'),
  ('role_finance_operator_bill_invoices_create', 'role_finance_operator', 'bill-invoices:create'),
  ('role_finance_operator_bill_invoices_update', 'role_finance_operator', 'bill-invoices:update'),
  ('role_finance_operator_bill_arrears_update', 'role_finance_operator', 'bill-arrears:update'),
  ('role_finance_operator_bill_transactions_create', 'role_finance_operator', 'bill-transactions:create'),
  ('role_finance_operator_bill_models_create', 'role_finance_operator', 'bill-models:create'),
  ('role_finance_operator_bill_models_update', 'role_finance_operator', 'bill-models:update'),
  ('role_finance_operator_bill_performance_update', 'role_finance_operator', 'bill-performance:update'),
  ('role_finance_operator_bill_budgets_create', 'role_finance_operator', 'bill-budgets:create'),
  ('role_finance_operator_bill_budgets_update', 'role_finance_operator', 'bill-budgets:update'),
  ('role_finance_operator_bill_pricing_update', 'role_finance_operator', 'bill-pricing:update'),
  ('role_finance_operator_bill_credits_create', 'role_finance_operator', 'bill-credits:create'),
  ('role_finance_operator_bill_credits_update', 'role_finance_operator', 'bill-credits:update'),
  ('role_finance_operator_bill_reconciliation_create', 'role_finance_operator', 'bill-reconciliation:create'),
  ('role_finance_operator_bill_reconciliation_update', 'role_finance_operator', 'bill-reconciliation:update')
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_finance_approver_bill_overview_view', 'role_finance_approver', 'bill-overview:view'),
  ('role_finance_approver_bill_invoices_view', 'role_finance_approver', 'bill-invoices:view'),
  ('role_finance_approver_bill_arrears_view', 'role_finance_approver', 'bill-arrears:view'),
  ('role_finance_approver_bill_transactions_view', 'role_finance_approver', 'bill-transactions:view'),
  ('role_finance_approver_bill_models_view', 'role_finance_approver', 'bill-models:view'),
  ('role_finance_approver_bill_performance_view', 'role_finance_approver', 'bill-performance:view'),
  ('role_finance_approver_bill_budgets_view', 'role_finance_approver', 'bill-budgets:view'),
  ('role_finance_approver_bill_pricing_view', 'role_finance_approver', 'bill-pricing:view'),
  ('role_finance_approver_bill_returns_view', 'role_finance_approver', 'bill-returns:view'),
  ('role_finance_approver_bill_library_view', 'role_finance_approver', 'bill-library:view'),
  ('role_finance_approver_bill_credits_view', 'role_finance_approver', 'bill-credits:view'),
  ('role_finance_approver_bill_reconciliation_view', 'role_finance_approver', 'bill-reconciliation:view'),
  ('role_finance_approver_bill_invoices_create', 'role_finance_approver', 'bill-invoices:create'),
  ('role_finance_approver_bill_invoices_update', 'role_finance_approver', 'bill-invoices:update'),
  ('role_finance_approver_bill_arrears_update', 'role_finance_approver', 'bill-arrears:update'),
  ('role_finance_approver_bill_transactions_create', 'role_finance_approver', 'bill-transactions:create'),
  ('role_finance_approver_bill_models_create', 'role_finance_approver', 'bill-models:create'),
  ('role_finance_approver_bill_models_update', 'role_finance_approver', 'bill-models:update'),
  ('role_finance_approver_bill_performance_update', 'role_finance_approver', 'bill-performance:update'),
  ('role_finance_approver_bill_budgets_create', 'role_finance_approver', 'bill-budgets:create'),
  ('role_finance_approver_bill_budgets_update', 'role_finance_approver', 'bill-budgets:update'),
  ('role_finance_approver_bill_pricing_update', 'role_finance_approver', 'bill-pricing:update'),
  ('role_finance_approver_bill_credits_create', 'role_finance_approver', 'bill-credits:create'),
  ('role_finance_approver_bill_credits_update', 'role_finance_approver', 'bill-credits:update'),
  ('role_finance_approver_bill_reconciliation_create', 'role_finance_approver', 'bill-reconciliation:create'),
  ('role_finance_approver_bill_reconciliation_update', 'role_finance_approver', 'bill-reconciliation:update'),
  ('role_finance_approver_bill_invoices_approve', 'role_finance_approver', 'bill-invoices:approve'),
  ('role_finance_approver_bill_arrears_approve', 'role_finance_approver', 'bill-arrears:approve'),
  ('role_finance_approver_bill_transactions_approve', 'role_finance_approver', 'bill-transactions:approve'),
  ('role_finance_approver_bill_models_approve', 'role_finance_approver', 'bill-models:approve'),
  ('role_finance_approver_bill_budgets_approve', 'role_finance_approver', 'bill-budgets:approve'),
  ('role_finance_approver_bill_credits_approve', 'role_finance_approver', 'bill-credits:approve'),
  ('role_finance_approver_bill_library_approve', 'role_finance_approver', 'bill-library:approve'),
  ('role_finance_approver_bill_reconciliation_approve', 'role_finance_approver', 'bill-reconciliation:approve')
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_finance_auditor_bill_overview_view', 'role_finance_auditor', 'bill-overview:view'),
  ('role_finance_auditor_bill_invoices_view', 'role_finance_auditor', 'bill-invoices:view'),
  ('role_finance_auditor_bill_arrears_view', 'role_finance_auditor', 'bill-arrears:view'),
  ('role_finance_auditor_bill_transactions_view', 'role_finance_auditor', 'bill-transactions:view'),
  ('role_finance_auditor_bill_models_view', 'role_finance_auditor', 'bill-models:view'),
  ('role_finance_auditor_bill_performance_view', 'role_finance_auditor', 'bill-performance:view'),
  ('role_finance_auditor_bill_budgets_view', 'role_finance_auditor', 'bill-budgets:view'),
  ('role_finance_auditor_bill_pricing_view', 'role_finance_auditor', 'bill-pricing:view'),
  ('role_finance_auditor_bill_returns_view', 'role_finance_auditor', 'bill-returns:view'),
  ('role_finance_auditor_bill_library_view', 'role_finance_auditor', 'bill-library:view'),
  ('role_finance_auditor_bill_credits_view', 'role_finance_auditor', 'bill-credits:view'),
  ('role_finance_auditor_bill_reconciliation_view', 'role_finance_auditor', 'bill-reconciliation:view')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Owner delta: full access to the 12 finance resources (append-only; existing rows untouched).

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_owner_bill_overview_view', 'role_owner', 'bill-overview:view'),
  ('role_owner_bill_invoices_view', 'role_owner', 'bill-invoices:view'),
  ('role_owner_bill_invoices_create', 'role_owner', 'bill-invoices:create'),
  ('role_owner_bill_invoices_update', 'role_owner', 'bill-invoices:update'),
  ('role_owner_bill_invoices_approve', 'role_owner', 'bill-invoices:approve'),
  ('role_owner_bill_arrears_view', 'role_owner', 'bill-arrears:view'),
  ('role_owner_bill_arrears_update', 'role_owner', 'bill-arrears:update'),
  ('role_owner_bill_arrears_approve', 'role_owner', 'bill-arrears:approve'),
  ('role_owner_bill_transactions_view', 'role_owner', 'bill-transactions:view'),
  ('role_owner_bill_transactions_create', 'role_owner', 'bill-transactions:create'),
  ('role_owner_bill_transactions_approve', 'role_owner', 'bill-transactions:approve'),
  ('role_owner_bill_models_view', 'role_owner', 'bill-models:view'),
  ('role_owner_bill_models_create', 'role_owner', 'bill-models:create'),
  ('role_owner_bill_models_update', 'role_owner', 'bill-models:update'),
  ('role_owner_bill_models_delete', 'role_owner', 'bill-models:delete'),
  ('role_owner_bill_models_approve', 'role_owner', 'bill-models:approve'),
  ('role_owner_bill_performance_view', 'role_owner', 'bill-performance:view'),
  ('role_owner_bill_performance_update', 'role_owner', 'bill-performance:update'),
  ('role_owner_bill_budgets_view', 'role_owner', 'bill-budgets:view'),
  ('role_owner_bill_budgets_create', 'role_owner', 'bill-budgets:create'),
  ('role_owner_bill_budgets_update', 'role_owner', 'bill-budgets:update'),
  ('role_owner_bill_budgets_approve', 'role_owner', 'bill-budgets:approve'),
  ('role_owner_bill_pricing_view', 'role_owner', 'bill-pricing:view'),
  ('role_owner_bill_pricing_update', 'role_owner', 'bill-pricing:update'),
  ('role_owner_bill_pricing_approve', 'role_owner', 'bill-pricing:approve'),
  ('role_owner_bill_returns_view', 'role_owner', 'bill-returns:view'),
  ('role_owner_bill_library_view', 'role_owner', 'bill-library:view'),
  ('role_owner_bill_library_update', 'role_owner', 'bill-library:update'),
  ('role_owner_bill_library_approve', 'role_owner', 'bill-library:approve'),
  ('role_owner_bill_credits_view', 'role_owner', 'bill-credits:view'),
  ('role_owner_bill_credits_create', 'role_owner', 'bill-credits:create'),
  ('role_owner_bill_credits_update', 'role_owner', 'bill-credits:update'),
  ('role_owner_bill_credits_approve', 'role_owner', 'bill-credits:approve'),
  ('role_owner_bill_reconciliation_view', 'role_owner', 'bill-reconciliation:view'),
  ('role_owner_bill_reconciliation_create', 'role_owner', 'bill-reconciliation:create'),
  ('role_owner_bill_reconciliation_update', 'role_owner', 'bill-reconciliation:update'),
  ('role_owner_bill_reconciliation_approve', 'role_owner', 'bill-reconciliation:approve')
ON CONFLICT ("roleId", "permission") DO NOTHING;
