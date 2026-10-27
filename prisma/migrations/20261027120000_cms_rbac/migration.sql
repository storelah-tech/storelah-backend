-- CMS RBAC (2026-10-27): editable roles replace the unused Role enum and the
-- opt-in per-user Permission grants; adds sign-in lockout + session
-- invalidation columns and an append-only permission audit log.
--
-- Data steps (in order):
--   1. create AdminRole / AdminRolePermission / PermissionAudit
--   2. seed the system roles OWNER (locked) / MANAGER / VIEWER with the default
--      matrix from src/lib/permissions.ts (generated, keep in sync)
--   3. map every AdminUser to the role matching its old enum value
--   4. if no OWNER exists, promote the oldest AdminUser to OWNER so someone can
--      still manage users and roles
--   5. drop the old enum column, the Role enum and the Permission table
--      (legacy grants promotions.approve / fees.manage / businessRules.manage /
--      users.manage are superseded by the role matrix)

-- CreateTable
CREATE TABLE "AdminRole" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "AdminRolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionAudit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRole_key_key" ON "AdminRole"("key");
CREATE INDEX "AdminRolePermission_roleId_idx" ON "AdminRolePermission"("roleId");
CREATE UNIQUE INDEX "AdminRolePermission_roleId_permission_key" ON "AdminRolePermission"("roleId", "permission");
CREATE INDEX "PermissionAudit_targetType_targetId_idx" ON "PermissionAudit"("targetType", "targetId");
CREATE INDEX "PermissionAudit_createdAt_idx" ON "PermissionAudit"("createdAt");

ALTER TABLE "AdminRolePermission" ADD CONSTRAINT "AdminRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- System roles + default matrix (generated from src/lib/permissions.ts SYSTEM_ROLES)
INSERT INTO "AdminRole" ("id", "key", "name", "description", "isSystem", "updatedAt") VALUES
  ('role_owner', 'OWNER', 'Owner', 'Full access, including users and roles. Cannot be edited.', true, CURRENT_TIMESTAMP),
  ('role_manager', 'MANAGER', 'Manager', 'Day-to-day operations. No settings edits, approvals or lead/tenant deletes.', false, CURRENT_TIMESTAMP),
  ('role_viewer', 'VIEWER', 'Viewer', 'Read-only access. Finance is hidden.', false, CURRENT_TIMESTAMP);

INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_owner_command_view', 'role_owner', 'command:view'),
  ('role_owner_portfolio_view', 'role_owner', 'portfolio:view'),
  ('role_owner_analytics_view', 'role_owner', 'analytics:view'),
  ('role_owner_leads_view', 'role_owner', 'leads:view'),
  ('role_owner_leads_create', 'role_owner', 'leads:create'),
  ('role_owner_leads_update', 'role_owner', 'leads:update'),
  ('role_owner_leads_delete', 'role_owner', 'leads:delete'),
  ('role_owner_pipeline_view', 'role_owner', 'pipeline:view'),
  ('role_owner_pipeline_update', 'role_owner', 'pipeline:update'),
  ('role_owner_quotes_view', 'role_owner', 'quotes:view'),
  ('role_owner_quotes_create', 'role_owner', 'quotes:create'),
  ('role_owner_inbox_view', 'role_owner', 'inbox:view'),
  ('role_owner_inbox_create', 'role_owner', 'inbox:create'),
  ('role_owner_inbox_update', 'role_owner', 'inbox:update'),
  ('role_owner_calendar_view', 'role_owner', 'calendar:view'),
  ('role_owner_calendar_create', 'role_owner', 'calendar:create'),
  ('role_owner_calendar_update', 'role_owner', 'calendar:update'),
  ('role_owner_calendar_delete', 'role_owner', 'calendar:delete'),
  ('role_owner_automation_view', 'role_owner', 'automation:view'),
  ('role_owner_customer_tenants_view', 'role_owner', 'customer-tenants:view'),
  ('role_owner_customer_tenants_create', 'role_owner', 'customer-tenants:create'),
  ('role_owner_customer_tenants_update', 'role_owner', 'customer-tenants:update'),
  ('role_owner_customer_tenants_delete', 'role_owner', 'customer-tenants:delete'),
  ('role_owner_customer_bookings_view', 'role_owner', 'customer-bookings:view'),
  ('role_owner_customer_moveins_view', 'role_owner', 'customer-moveins:view'),
  ('role_owner_customer_moveouts_view', 'role_owner', 'customer-moveouts:view'),
  ('role_owner_customer_moveouts_update', 'role_owner', 'customer-moveouts:update'),
  ('role_owner_facility_map_view', 'role_owner', 'facility-map:view'),
  ('role_owner_facility_units_view', 'role_owner', 'facility-units:view'),
  ('role_owner_facility_units_create', 'role_owner', 'facility-units:create'),
  ('role_owner_facility_units_update', 'role_owner', 'facility-units:update'),
  ('role_owner_facility_units_delete', 'role_owner', 'facility-units:delete'),
  ('role_owner_facility_floors_view', 'role_owner', 'facility-floors:view'),
  ('role_owner_facility_floors_create', 'role_owner', 'facility-floors:create'),
  ('role_owner_facility_floors_update', 'role_owner', 'facility-floors:update'),
  ('role_owner_facility_floors_delete', 'role_owner', 'facility-floors:delete'),
  ('role_owner_facility_floorplans_view', 'role_owner', 'facility-floorplans:view'),
  ('role_owner_facility_floorplans_create', 'role_owner', 'facility-floorplans:create'),
  ('role_owner_facility_floorplans_update', 'role_owner', 'facility-floorplans:update'),
  ('role_owner_facility_floorplans_delete', 'role_owner', 'facility-floorplans:delete'),
  ('role_owner_facility_floorplans_approve', 'role_owner', 'facility-floorplans:approve'),
  ('role_owner_facility_floorplan_library_view', 'role_owner', 'facility-floorplan-library:view'),
  ('role_owner_facility_floorplan_library_update', 'role_owner', 'facility-floorplan-library:update'),
  ('role_owner_facility_floorplan_library_delete', 'role_owner', 'facility-floorplan-library:delete'),
  ('role_owner_facility_maintenance_view', 'role_owner', 'facility-maintenance:view'),
  ('role_owner_facility_maintenance_create', 'role_owner', 'facility-maintenance:create'),
  ('role_owner_facility_maintenance_update', 'role_owner', 'facility-maintenance:update'),
  ('role_owner_facility_maintenance_delete', 'role_owner', 'facility-maintenance:delete'),
  ('role_owner_facility_assets_view', 'role_owner', 'facility-assets:view'),
  ('role_owner_facility_assets_create', 'role_owner', 'facility-assets:create'),
  ('role_owner_facility_assets_update', 'role_owner', 'facility-assets:update'),
  ('role_owner_facility_assets_delete', 'role_owner', 'facility-assets:delete'),
  ('role_owner_facility_incidents_view', 'role_owner', 'facility-incidents:view'),
  ('role_owner_facility_incidents_create', 'role_owner', 'facility-incidents:create'),
  ('role_owner_facility_incidents_update', 'role_owner', 'facility-incidents:update'),
  ('role_owner_facility_incidents_delete', 'role_owner', 'facility-incidents:delete'),
  ('role_owner_facility_access_view', 'role_owner', 'facility-access:view'),
  ('role_owner_facility_access_create', 'role_owner', 'facility-access:create'),
  ('role_owner_facility_access_update', 'role_owner', 'facility-access:update'),
  ('role_owner_facility_access_delete', 'role_owner', 'facility-access:delete'),
  ('role_owner_facility_inspections_view', 'role_owner', 'facility-inspections:view'),
  ('role_owner_facility_inspections_create', 'role_owner', 'facility-inspections:create'),
  ('role_owner_facility_inspections_update', 'role_owner', 'facility-inspections:update'),
  ('role_owner_facility_inspections_delete', 'role_owner', 'facility-inspections:delete'),
  ('role_owner_extras_plans_view', 'role_owner', 'extras-plans:view'),
  ('role_owner_extras_plans_create', 'role_owner', 'extras-plans:create'),
  ('role_owner_extras_plans_update', 'role_owner', 'extras-plans:update'),
  ('role_owner_extras_plans_delete', 'role_owner', 'extras-plans:delete'),
  ('role_owner_extras_addons_view', 'role_owner', 'extras-addons:view'),
  ('role_owner_extras_addons_create', 'role_owner', 'extras-addons:create'),
  ('role_owner_extras_addons_update', 'role_owner', 'extras-addons:update'),
  ('role_owner_extras_addons_delete', 'role_owner', 'extras-addons:delete'),
  ('role_owner_promo_overview_view', 'role_owner', 'promo-overview:view'),
  ('role_owner_promo_discount_matrix_view', 'role_owner', 'promo-discount-matrix:view'),
  ('role_owner_promo_discount_matrix_create', 'role_owner', 'promo-discount-matrix:create'),
  ('role_owner_promo_discount_matrix_update', 'role_owner', 'promo-discount-matrix:update'),
  ('role_owner_promo_free_months_view', 'role_owner', 'promo-free-months:view'),
  ('role_owner_promo_free_months_create', 'role_owner', 'promo-free-months:create'),
  ('role_owner_promo_free_months_update', 'role_owner', 'promo-free-months:update'),
  ('role_owner_promo_code_builder_view', 'role_owner', 'promo-code-builder:view'),
  ('role_owner_promo_code_builder_create', 'role_owner', 'promo-code-builder:create'),
  ('role_owner_promo_code_builder_update', 'role_owner', 'promo-code-builder:update'),
  ('role_owner_promo_code_builder_delete', 'role_owner', 'promo-code-builder:delete'),
  ('role_owner_promo_library_view', 'role_owner', 'promo-library:view'),
  ('role_owner_promo_library_create', 'role_owner', 'promo-library:create'),
  ('role_owner_promo_library_update', 'role_owner', 'promo-library:update'),
  ('role_owner_promo_library_delete', 'role_owner', 'promo-library:delete'),
  ('role_owner_promo_library_approve', 'role_owner', 'promo-library:approve'),
  ('role_owner_promo_history_view', 'role_owner', 'promo-history:view'),
  ('role_owner_promo_safeguards_view', 'role_owner', 'promo-safeguards:view'),
  ('role_owner_promo_safeguards_create', 'role_owner', 'promo-safeguards:create'),
  ('role_owner_promo_safeguards_update', 'role_owner', 'promo-safeguards:update'),
  ('role_owner_promo_safeguards_delete', 'role_owner', 'promo-safeguards:delete'),
  ('role_owner_promo_performance_view', 'role_owner', 'promo-performance:view'),
  ('role_owner_bill_overview_view', 'role_owner', 'bill-overview:view'),
  ('role_owner_bill_invoices_view', 'role_owner', 'bill-invoices:view'),
  ('role_owner_bill_arrears_view', 'role_owner', 'bill-arrears:view'),
  ('role_owner_content_list_view', 'role_owner', 'content-list:view'),
  ('role_owner_content_list_create', 'role_owner', 'content-list:create'),
  ('role_owner_content_list_update', 'role_owner', 'content-list:update'),
  ('role_owner_content_list_delete', 'role_owner', 'content-list:delete'),
  ('role_owner_settings_general_view', 'role_owner', 'settings-general:view'),
  ('role_owner_settings_general_update', 'role_owner', 'settings-general:update'),
  ('role_owner_settings_booking_view', 'role_owner', 'settings-booking:view'),
  ('role_owner_settings_booking_update', 'role_owner', 'settings-booking:update'),
  ('role_owner_settings_fees_view', 'role_owner', 'settings-fees:view'),
  ('role_owner_settings_fees_create', 'role_owner', 'settings-fees:create'),
  ('role_owner_settings_fees_update', 'role_owner', 'settings-fees:update'),
  ('role_owner_settings_fees_delete', 'role_owner', 'settings-fees:delete'),
  ('role_owner_settings_facilities_view', 'role_owner', 'settings-facilities:view'),
  ('role_owner_settings_facilities_create', 'role_owner', 'settings-facilities:create'),
  ('role_owner_settings_facilities_update', 'role_owner', 'settings-facilities:update'),
  ('role_owner_settings_facilities_delete', 'role_owner', 'settings-facilities:delete'),
  ('role_manager_command_view', 'role_manager', 'command:view'),
  ('role_manager_portfolio_view', 'role_manager', 'portfolio:view'),
  ('role_manager_analytics_view', 'role_manager', 'analytics:view'),
  ('role_manager_leads_view', 'role_manager', 'leads:view'),
  ('role_manager_leads_create', 'role_manager', 'leads:create'),
  ('role_manager_leads_update', 'role_manager', 'leads:update'),
  ('role_manager_pipeline_view', 'role_manager', 'pipeline:view'),
  ('role_manager_pipeline_update', 'role_manager', 'pipeline:update'),
  ('role_manager_quotes_view', 'role_manager', 'quotes:view'),
  ('role_manager_quotes_create', 'role_manager', 'quotes:create'),
  ('role_manager_inbox_view', 'role_manager', 'inbox:view'),
  ('role_manager_inbox_create', 'role_manager', 'inbox:create'),
  ('role_manager_inbox_update', 'role_manager', 'inbox:update'),
  ('role_manager_calendar_view', 'role_manager', 'calendar:view'),
  ('role_manager_calendar_create', 'role_manager', 'calendar:create'),
  ('role_manager_calendar_update', 'role_manager', 'calendar:update'),
  ('role_manager_calendar_delete', 'role_manager', 'calendar:delete'),
  ('role_manager_automation_view', 'role_manager', 'automation:view'),
  ('role_manager_customer_tenants_view', 'role_manager', 'customer-tenants:view'),
  ('role_manager_customer_tenants_create', 'role_manager', 'customer-tenants:create'),
  ('role_manager_customer_tenants_update', 'role_manager', 'customer-tenants:update'),
  ('role_manager_customer_bookings_view', 'role_manager', 'customer-bookings:view'),
  ('role_manager_customer_moveins_view', 'role_manager', 'customer-moveins:view'),
  ('role_manager_customer_moveouts_view', 'role_manager', 'customer-moveouts:view'),
  ('role_manager_customer_moveouts_update', 'role_manager', 'customer-moveouts:update'),
  ('role_manager_facility_map_view', 'role_manager', 'facility-map:view'),
  ('role_manager_facility_units_view', 'role_manager', 'facility-units:view'),
  ('role_manager_facility_units_create', 'role_manager', 'facility-units:create'),
  ('role_manager_facility_units_update', 'role_manager', 'facility-units:update'),
  ('role_manager_facility_units_delete', 'role_manager', 'facility-units:delete'),
  ('role_manager_facility_floors_view', 'role_manager', 'facility-floors:view'),
  ('role_manager_facility_floors_create', 'role_manager', 'facility-floors:create'),
  ('role_manager_facility_floors_update', 'role_manager', 'facility-floors:update'),
  ('role_manager_facility_floors_delete', 'role_manager', 'facility-floors:delete'),
  ('role_manager_facility_floorplans_view', 'role_manager', 'facility-floorplans:view'),
  ('role_manager_facility_floorplans_create', 'role_manager', 'facility-floorplans:create'),
  ('role_manager_facility_floorplans_update', 'role_manager', 'facility-floorplans:update'),
  ('role_manager_facility_floorplans_delete', 'role_manager', 'facility-floorplans:delete'),
  ('role_manager_facility_floorplan_library_view', 'role_manager', 'facility-floorplan-library:view'),
  ('role_manager_facility_floorplan_library_update', 'role_manager', 'facility-floorplan-library:update'),
  ('role_manager_facility_floorplan_library_delete', 'role_manager', 'facility-floorplan-library:delete'),
  ('role_manager_facility_maintenance_view', 'role_manager', 'facility-maintenance:view'),
  ('role_manager_facility_maintenance_create', 'role_manager', 'facility-maintenance:create'),
  ('role_manager_facility_maintenance_update', 'role_manager', 'facility-maintenance:update'),
  ('role_manager_facility_maintenance_delete', 'role_manager', 'facility-maintenance:delete'),
  ('role_manager_facility_assets_view', 'role_manager', 'facility-assets:view'),
  ('role_manager_facility_assets_create', 'role_manager', 'facility-assets:create'),
  ('role_manager_facility_assets_update', 'role_manager', 'facility-assets:update'),
  ('role_manager_facility_assets_delete', 'role_manager', 'facility-assets:delete'),
  ('role_manager_facility_incidents_view', 'role_manager', 'facility-incidents:view'),
  ('role_manager_facility_incidents_create', 'role_manager', 'facility-incidents:create'),
  ('role_manager_facility_incidents_update', 'role_manager', 'facility-incidents:update'),
  ('role_manager_facility_incidents_delete', 'role_manager', 'facility-incidents:delete'),
  ('role_manager_facility_access_view', 'role_manager', 'facility-access:view'),
  ('role_manager_facility_access_create', 'role_manager', 'facility-access:create'),
  ('role_manager_facility_access_update', 'role_manager', 'facility-access:update'),
  ('role_manager_facility_access_delete', 'role_manager', 'facility-access:delete'),
  ('role_manager_facility_inspections_view', 'role_manager', 'facility-inspections:view'),
  ('role_manager_facility_inspections_create', 'role_manager', 'facility-inspections:create'),
  ('role_manager_facility_inspections_update', 'role_manager', 'facility-inspections:update'),
  ('role_manager_facility_inspections_delete', 'role_manager', 'facility-inspections:delete'),
  ('role_manager_extras_plans_view', 'role_manager', 'extras-plans:view'),
  ('role_manager_extras_plans_create', 'role_manager', 'extras-plans:create'),
  ('role_manager_extras_plans_update', 'role_manager', 'extras-plans:update'),
  ('role_manager_extras_plans_delete', 'role_manager', 'extras-plans:delete'),
  ('role_manager_extras_addons_view', 'role_manager', 'extras-addons:view'),
  ('role_manager_extras_addons_create', 'role_manager', 'extras-addons:create'),
  ('role_manager_extras_addons_update', 'role_manager', 'extras-addons:update'),
  ('role_manager_extras_addons_delete', 'role_manager', 'extras-addons:delete'),
  ('role_manager_promo_overview_view', 'role_manager', 'promo-overview:view'),
  ('role_manager_promo_discount_matrix_view', 'role_manager', 'promo-discount-matrix:view'),
  ('role_manager_promo_discount_matrix_create', 'role_manager', 'promo-discount-matrix:create'),
  ('role_manager_promo_discount_matrix_update', 'role_manager', 'promo-discount-matrix:update'),
  ('role_manager_promo_free_months_view', 'role_manager', 'promo-free-months:view'),
  ('role_manager_promo_free_months_create', 'role_manager', 'promo-free-months:create'),
  ('role_manager_promo_free_months_update', 'role_manager', 'promo-free-months:update'),
  ('role_manager_promo_code_builder_view', 'role_manager', 'promo-code-builder:view'),
  ('role_manager_promo_code_builder_create', 'role_manager', 'promo-code-builder:create'),
  ('role_manager_promo_code_builder_update', 'role_manager', 'promo-code-builder:update'),
  ('role_manager_promo_code_builder_delete', 'role_manager', 'promo-code-builder:delete'),
  ('role_manager_promo_library_view', 'role_manager', 'promo-library:view'),
  ('role_manager_promo_library_create', 'role_manager', 'promo-library:create'),
  ('role_manager_promo_library_update', 'role_manager', 'promo-library:update'),
  ('role_manager_promo_library_delete', 'role_manager', 'promo-library:delete'),
  ('role_manager_promo_history_view', 'role_manager', 'promo-history:view'),
  ('role_manager_promo_safeguards_view', 'role_manager', 'promo-safeguards:view'),
  ('role_manager_promo_safeguards_create', 'role_manager', 'promo-safeguards:create'),
  ('role_manager_promo_safeguards_update', 'role_manager', 'promo-safeguards:update'),
  ('role_manager_promo_safeguards_delete', 'role_manager', 'promo-safeguards:delete'),
  ('role_manager_promo_performance_view', 'role_manager', 'promo-performance:view'),
  ('role_manager_bill_overview_view', 'role_manager', 'bill-overview:view'),
  ('role_manager_bill_invoices_view', 'role_manager', 'bill-invoices:view'),
  ('role_manager_bill_arrears_view', 'role_manager', 'bill-arrears:view'),
  ('role_manager_content_list_view', 'role_manager', 'content-list:view'),
  ('role_manager_content_list_create', 'role_manager', 'content-list:create'),
  ('role_manager_content_list_update', 'role_manager', 'content-list:update'),
  ('role_manager_content_list_delete', 'role_manager', 'content-list:delete'),
  ('role_manager_settings_general_view', 'role_manager', 'settings-general:view'),
  ('role_manager_settings_booking_view', 'role_manager', 'settings-booking:view'),
  ('role_manager_settings_fees_view', 'role_manager', 'settings-fees:view'),
  ('role_manager_settings_facilities_view', 'role_manager', 'settings-facilities:view'),
  ('role_viewer_command_view', 'role_viewer', 'command:view'),
  ('role_viewer_portfolio_view', 'role_viewer', 'portfolio:view'),
  ('role_viewer_analytics_view', 'role_viewer', 'analytics:view'),
  ('role_viewer_leads_view', 'role_viewer', 'leads:view'),
  ('role_viewer_pipeline_view', 'role_viewer', 'pipeline:view'),
  ('role_viewer_quotes_view', 'role_viewer', 'quotes:view'),
  ('role_viewer_inbox_view', 'role_viewer', 'inbox:view'),
  ('role_viewer_calendar_view', 'role_viewer', 'calendar:view'),
  ('role_viewer_automation_view', 'role_viewer', 'automation:view'),
  ('role_viewer_customer_tenants_view', 'role_viewer', 'customer-tenants:view'),
  ('role_viewer_customer_bookings_view', 'role_viewer', 'customer-bookings:view'),
  ('role_viewer_customer_moveins_view', 'role_viewer', 'customer-moveins:view'),
  ('role_viewer_customer_moveouts_view', 'role_viewer', 'customer-moveouts:view'),
  ('role_viewer_facility_map_view', 'role_viewer', 'facility-map:view'),
  ('role_viewer_facility_units_view', 'role_viewer', 'facility-units:view'),
  ('role_viewer_facility_floors_view', 'role_viewer', 'facility-floors:view'),
  ('role_viewer_facility_floorplans_view', 'role_viewer', 'facility-floorplans:view'),
  ('role_viewer_facility_floorplan_library_view', 'role_viewer', 'facility-floorplan-library:view'),
  ('role_viewer_facility_maintenance_view', 'role_viewer', 'facility-maintenance:view'),
  ('role_viewer_facility_assets_view', 'role_viewer', 'facility-assets:view'),
  ('role_viewer_facility_incidents_view', 'role_viewer', 'facility-incidents:view'),
  ('role_viewer_facility_access_view', 'role_viewer', 'facility-access:view'),
  ('role_viewer_facility_inspections_view', 'role_viewer', 'facility-inspections:view'),
  ('role_viewer_extras_plans_view', 'role_viewer', 'extras-plans:view'),
  ('role_viewer_extras_addons_view', 'role_viewer', 'extras-addons:view'),
  ('role_viewer_promo_overview_view', 'role_viewer', 'promo-overview:view'),
  ('role_viewer_promo_discount_matrix_view', 'role_viewer', 'promo-discount-matrix:view'),
  ('role_viewer_promo_free_months_view', 'role_viewer', 'promo-free-months:view'),
  ('role_viewer_promo_code_builder_view', 'role_viewer', 'promo-code-builder:view'),
  ('role_viewer_promo_library_view', 'role_viewer', 'promo-library:view'),
  ('role_viewer_promo_history_view', 'role_viewer', 'promo-history:view'),
  ('role_viewer_promo_safeguards_view', 'role_viewer', 'promo-safeguards:view'),
  ('role_viewer_promo_performance_view', 'role_viewer', 'promo-performance:view'),
  ('role_viewer_content_list_view', 'role_viewer', 'content-list:view'),
  ('role_viewer_settings_general_view', 'role_viewer', 'settings-general:view'),
  ('role_viewer_settings_booking_view', 'role_viewer', 'settings-booking:view'),
  ('role_viewer_settings_fees_view', 'role_viewer', 'settings-fees:view'),
  ('role_viewer_settings_facilities_view', 'role_viewer', 'settings-facilities:view');

-- AdminUser: new columns, roleId nullable until backfilled
ALTER TABLE "AdminUser"
ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lockedUntil" TIMESTAMP(3),
ADD COLUMN "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "roleId" TEXT;

-- Existing users keep their current role
UPDATE "AdminUser" SET "roleId" = CASE "role"::text
  WHEN 'OWNER' THEN 'role_owner'
  WHEN 'VIEWER' THEN 'role_viewer'
  ELSE 'role_manager'
END;

-- Guarantee at least one Owner (users and roles are Owner-only)
UPDATE "AdminUser" SET "roleId" = 'role_owner'
WHERE NOT EXISTS (SELECT 1 FROM "AdminUser" WHERE "roleId" = 'role_owner')
  AND "id" = (SELECT "id" FROM "AdminUser" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);

ALTER TABLE "AdminUser" ALTER COLUMN "roleId" SET NOT NULL;
CREATE INDEX "AdminUser_roleId_idx" ON "AdminUser"("roleId");
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Retire the old enum column, the enum and the opt-in grants
ALTER TABLE "AdminUser" DROP COLUMN "role";
ALTER TABLE "Permission" DROP CONSTRAINT "Permission_adminUserId_fkey";
DROP TABLE "Permission";
DROP TYPE "Role";
