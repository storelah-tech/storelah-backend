// CMS route → permission table (CMS RBAC, 2026-10-27).
//
// Every route on the CMS router must appear here as `METHOD /path` (the exact
// Express path string). applyRoutePermissions() runs once after the router is
// built and splices a permission check into each route, right after
// requireAuth. Deny by default: a route with no entry answers 403 and logs,
// and tests/e2e/cms-rbac.test.ts fails until it is added.
//
// Specs:
//   'PUBLIC'          no auth (sign-in only)
//   'AUTH'            any signed-in operator (shared reference data, own account)
//   'OWNER'           Owner role only (users and roles)
//   'res:action'      that permission
//   ['a:x', 'b:y']    any one of them (reads shared by several screens)
import type { NextFunction, Request, Response, Router } from 'express';
import { requireAuth, adminOf } from '../middleware/auth';
import { can } from '../core/users';
import { fail } from './http';

export type PermissionSpec = 'PUBLIC' | 'AUTH' | 'OWNER' | string | readonly string[];

const v = (...resources: string[]) => resources.map((r) => `${r}:view`);

const PROMO_TABS = ['promo-overview', 'promo-discount-matrix', 'promo-free-months', 'promo-code-builder', 'promo-library', 'promo-history', 'promo-safeguards', 'promo-performance'];
const PROMO_BUILDERS_UPDATE = ['promo-discount-matrix:update', 'promo-free-months:update', 'promo-code-builder:update', 'promo-library:update'];
const FLOORPLAN_VIEW = v('facility-floorplans', 'facility-floorplan-library');
const FP_EDIT = 'facility-floorplans:update';
const UNIT_READERS = v(
  'facility-units', 'facility-map', 'facility-floorplans', 'facility-maintenance', 'facility-assets', 'facility-incidents',
  'facility-access', 'facility-inspections', 'customer-tenants', 'customer-bookings', 'customer-moveins', 'quotes', 'command',
);
const TENANT_READERS = v('customer-tenants', 'customer-bookings', 'customer-moveins', 'customer-moveouts', 'facility-units', 'settings-fees', 'bill-invoices', 'bill-arrears');
const LEAD_READERS = v('leads', 'pipeline', 'quotes', 'inbox', 'calendar', 'command', 'analytics');
// Phase 1 finance audit reads: any finance view permission suffices.
const FINANCE_VIEWERS = v(
  'bill-overview', 'bill-invoices', 'bill-arrears', 'bill-transactions', 'bill-models', 'bill-performance',
  'bill-budgets', 'bill-pricing', 'bill-returns', 'bill-library', 'bill-credits', 'bill-reconciliation',
);

export const ROUTE_PERMISSIONS: Record<string, PermissionSpec> = {
  // ---- session ----
  'POST /login': 'PUBLIC',
  'GET /me': 'AUTH',
  'POST /me/password': 'AUTH',
  'POST /me/sign-out-all': 'AUTH',
  // Invite / reset links: the one-time token is the credential.
  'POST /auth/forgot': 'PUBLIC',
  'GET /auth/token': 'PUBLIC',
  'POST /auth/token': 'PUBLIC',

  // ---- Overview ----
  'GET /summary': v('command', 'analytics'),
  'GET /action-items': v('command'),
  'GET /analytics/weekly': v('analytics', 'command'),
  'GET /portfolio': v('portfolio'),
  'GET /rates/net-psf': v('portfolio'),

  // ---- shared reference data (sidebar facility picker, every form) ----
  'GET /branches': 'AUTH',
  'GET /floors': 'AUTH',
  'GET /floors/:id': 'AUTH',
  'GET /sizes': 'AUTH',
  'GET /settings': 'AUTH',

  // ---- units ----
  'GET /units/map': v('facility-map', 'command', 'portfolio'),
  'GET /units': UNIT_READERS,
  'GET /units/:code': UNIT_READERS,
  'GET /units/activity': v('facility-units', 'command'),
  'POST /units': 'facility-units:create',
  'PUT /units/:code': 'facility-units:update',
  'DELETE /units/:code': 'facility-units:delete',
  'GET /units/import/template': 'facility-units:create',
  'POST /units/import': 'facility-units:create',
  'POST /units/:code/rate': 'facility-units:update',
  // Unit photos: unit detail › Photos and the floor-plan new-unit form.
  'POST /units/:code/images': ['facility-units:update', 'facility-floorplans:update'],
  'POST /units/:code/images/:imageId/cover': ['facility-units:update', 'facility-floorplans:update'],
  'DELETE /units/:code/images/:imageId': ['facility-units:update', 'facility-floorplans:update'],

  // ---- customers ----
  'GET /tenants': TENANT_READERS,
  'POST /tenants': 'customer-tenants:create',
  'PUT /tenants/:id': 'customer-tenants:update',
  'DELETE /tenants/:id': 'customer-tenants:delete',
  'GET /verifications': v('customer-tenants'),
  'PATCH /verifications/:id': 'customer-tenants:update',
  'GET /bookings': v('customer-bookings', 'customer-tenants', 'facility-units'),
  'GET /move-ins': v('customer-moveins', 'customer-tenants', 'facility-units'),
  'GET /move-outs': v('customer-moveouts'),
  'PATCH /move-outs/:tenantId': 'customer-moveouts:update',

  // ---- leads ----
  'GET /leads': LEAD_READERS,
  'GET /leads/stats': LEAD_READERS,
  'GET /leads/groups': v('leads'),
  'GET /leads/groups/:key': v('leads'),
  'GET /leads/:id': LEAD_READERS,
  'POST /leads': 'leads:create',
  'PATCH /leads/:id': ['leads:update', 'pipeline:update'],
  'DELETE /leads/:id': 'leads:delete',
  'GET /conversations': v('inbox', 'leads'),
  'POST /conversations': ['inbox:create', 'leads:update'],
  'PATCH /conversations/:id': ['inbox:update', 'leads:update'],
  'GET /conversations/:id/messages': v('inbox', 'leads'),
  'POST /conversations/:id/notes': ['inbox:create', 'leads:update'],
  'POST /conversations/:id/messages': ['inbox:create', 'leads:update'],
  'GET /appointments': v('calendar', 'leads', 'command'),
  'POST /appointments': ['calendar:create', 'leads:update'],
  'PATCH /appointments/:id': ['calendar:update', 'leads:update'],
  'DELETE /appointments/:id': 'calendar:delete',
  'GET /quotes': v('quotes'),
  'POST /quotes': 'quotes:create',
  'GET /quotes/quotable-leads': v('quotes'),
  'GET /quotes/:id/pdf': v('quotes', 'leads'),
  'GET /quotes/:id': v('quotes', 'leads'),

  // ---- finance ----
  'GET /invoices': v('bill-overview', 'bill-invoices', 'bill-arrears'),

  // ---- finance module Phase 1 (FINANCE_MODULE_SPEC §29: every submodule route
  // is permissioned; audit reads ride on any bill view — no action grants an
  // audit mutation because no update/delete path exists) ----
  'GET /finance/overview': 'bill-overview:view',
  'GET /finance/overview/export.csv': 'bill-overview:view',
  'GET /finance/audit': FINANCE_VIEWERS,

  // ---- finance module Phase 2 — Planning workspace (§§11–16) ----
  // Models: drafts editable; CURRENT/ARCHIVED/PENDING locked in service code.
  'GET /finance/models': 'bill-models:view',
  'POST /finance/models': 'bill-models:create',
  'GET /finance/models/:id': 'bill-models:view',
  'PUT /finance/models/:id/inputs': 'bill-models:update',
  'PUT /finance/models/:id/assumptions': 'bill-models:update',
  'PUT /finance/models/:id/size-mix': ['bill-models:update', 'bill-pricing:update'],
  'PUT /finance/models/:id/opex': 'bill-models:update',
  'PUT /finance/models/:id/occupancy': 'bill-models:update',
  'PUT /finance/models/:id/capital': 'bill-models:update',
  'PUT /finance/models/:id/pricing': 'bill-models:update',
  'PUT /finance/models/:id/lease': 'bill-models:update',
  // Scenario/sensitivity are non-mutating computes over the saved base.
  'POST /finance/models/:id/scenarios': 'bill-models:view',
  'POST /finance/models/:id/sensitivity': 'bill-models:view',
  'GET /finance/models/:id/export.csv': 'bill-models:view',
  'DELETE /finance/models/:id': 'bill-models:delete',
  // Library: cards/versions/audit read with any library view; governance
  // transitions need update (submit/duplicate/restore/archive) or approve.
  'GET /finance/library': 'bill-library:view',
  'GET /finance/library/:id/versions': 'bill-library:view',
  'GET /finance/library/:id/audit': FINANCE_VIEWERS,
  'POST /finance/library/:id/save-version': 'bill-library:update',
  'POST /finance/library/:id/duplicate': ['bill-models:create', 'bill-library:update'],
  'POST /finance/library/:id/submit': 'bill-library:update',
  'POST /finance/library/:id/approve': 'bill-library:approve',
  'POST /finance/library/:id/reject': 'bill-library:approve',
  'POST /finance/library/:id/restore': 'bill-library:update',
  'POST /finance/library/:id/archive': 'bill-library:update',
  'POST /finance/library/:id/set-current': 'bill-library:approve',
  // Budgets: lease line is derived read-only (PUT on it always 403 in code);
  // the protected-override path additionally requires bill-budgets:approve.
  'GET /finance/budgets': 'bill-budgets:view',
  'POST /finance/budgets': 'bill-budgets:create',
  'PUT /finance/budgets/:id': 'bill-budgets:update',
  'GET /finance/expenses': 'bill-budgets:view',
  'POST /finance/expenses': 'bill-budgets:create',
  'PUT /finance/expenses/:id': 'bill-budgets:update',
  'GET /finance/expenses/export.csv': 'bill-budgets:view',
  // Pricing: manual override = update + audit (assumptions overlay, Q9 open).
  'GET /finance/pricing': 'bill-pricing:view',
  'PUT /finance/pricing/:sizeId': 'bill-pricing:update',
  // Returns: read-only over the CURRENT model.
  'GET /finance/returns': 'bill-returns:view',

  // ---- finance module Phase 5 — Investor Summary (§15.4, masked) ----
  // Approved-only, PII-free aggregates. The INVESTOR role holds exactly
  // this permission; finance staff keep their masked-summary view too.
  'GET /finance/investor/summary': 'bill-investor:view',
  'GET /finance/investor/summary.csv': 'bill-investor:view',

  // ---- finance module Phase 3 — Billing and payments (§§10/17) ----
  // Invoices: drafts are created (create), then approved AND issued (approve);
  // void is terminal and needs a reason (approve). The billing run creates
  // DRAFTs only (create); approval happens per invoice afterwards (Q2).
  'GET /finance/invoices': 'bill-invoices:view',
  'GET /finance/invoices/:id': 'bill-invoices:view',
  'POST /finance/invoices': 'bill-invoices:create',
  'POST /finance/invoices/:id/approve': 'bill-invoices:approve',
  'POST /finance/invoices/:id/issue': 'bill-invoices:approve',
  'POST /finance/invoices/:id/void': 'bill-invoices:approve',
  'POST /finance/billing-run': 'bill-invoices:create',
  // Transactions: instructions are created (create), then approved / charged /
  // retried INDIVIDUALLY (approve — no bulk path exists, spec §4.1);
  // cancellation is an update. Reads ride on the transactions view.
  'GET /finance/transactions': 'bill-transactions:view',
  'GET /finance/transactions/:id': 'bill-transactions:view',
  'POST /finance/transactions': 'bill-transactions:create',
  'POST /finance/transactions/:id/approve': 'bill-transactions:approve',
  'POST /finance/transactions/:id/retry': 'bill-transactions:approve',
  'POST /finance/transactions/:id/cancel': 'bill-transactions:update',

  // ---- finance module Phase 4 — Close and controls (§§12/18/19/20) ----
  // Credits: grant/apply = create; refunds = request (create) then approve /
  // reject / pay (approve — every refund needs a distinct requestor +
  // approver, Owner-only single-step with audit); bank verification = update.
  'GET /finance/credits': 'bill-credits:view',
  'GET /finance/credits/ledger': 'bill-credits:view',
  'POST /finance/credits/grant': 'bill-credits:create',
  'POST /finance/credits/apply': 'bill-credits:create',
  'POST /finance/refunds/calculate': 'bill-credits:view',
  'GET /finance/refunds': 'bill-credits:view',
  'GET /finance/refunds/:id': 'bill-credits:view',
  'POST /finance/refunds': 'bill-credits:create',
  'POST /finance/refunds/:id/approve': 'bill-credits:approve',
  'POST /finance/refunds/:id/reject': 'bill-credits:approve',
  'POST /finance/refunds/:id/bank-verify': 'bill-credits:update',
  'POST /finance/refunds/:id/pay': 'bill-credits:approve',
  // Arrears: open/advance/close/waiver-request = update (operator case work);
  // waiver decision = approve (approver-gated). Terminate is an UNDECIDED
  // stub (always 409). Write-off = bill-invoices:approve (terminal, audited).
  'GET /finance/arrears': 'bill-arrears:view',
  'GET /finance/arrears/candidates': 'bill-arrears:view',
  'GET /finance/arrears/:id': 'bill-arrears:view',
  'POST /finance/arrears': 'bill-arrears:update',
  'POST /finance/arrears/:id/advance': 'bill-arrears:update',
  'POST /finance/arrears/:id/close': 'bill-arrears:update',
  'POST /finance/arrears/:id/terminate': 'bill-arrears:update',
  'GET /finance/arrears/waivers': 'bill-arrears:view',
  'POST /finance/arrears/waivers': 'bill-arrears:update',
  'POST /finance/arrears/waivers/:id/decide': 'bill-arrears:approve',
  'POST /finance/invoices/:id/write-off': 'bill-invoices:approve',
  // Reconciliation: import = create, match/suspense = update, close =
  // approve; reopen needs elevated (Owner-only) approval.
  'GET /finance/reconciliation': 'bill-reconciliation:view',
  'POST /finance/reconciliation/import': 'bill-reconciliation:create',
  'POST /finance/reconciliation/:id/match': 'bill-reconciliation:update',
  'POST /finance/reconciliation/:id/suspense': 'bill-reconciliation:update',
  'POST /finance/reconciliation/close': 'bill-reconciliation:approve',
  'POST /finance/reconciliation/reopen': 'OWNER',
  // Forecast vs Actuals: read + variance notes (update); month close and
  // post-close adjustments = approve (the sign-off).
  'GET /finance/performance': 'bill-performance:view',
  'GET /finance/performance/series': 'bill-performance:view',
  'POST /finance/performance/notes': 'bill-performance:update',
  'GET /finance/month-close': 'bill-performance:view',
  'POST /finance/month-close': 'bill-performance:approve',
  'POST /finance/month-close/adjust': 'bill-performance:approve',

  // ---- facilities: floors / branches ----
  'POST /floors': 'facility-floors:create',
  'PUT /floors/:id': 'facility-floors:update',
  'DELETE /floors/:id': 'facility-floors:delete',
  'POST /branches': 'settings-facilities:create',
  'PUT /branches/:id': 'settings-facilities:update',
  'DELETE /branches/:id': 'settings-facilities:delete',

  // ---- facilities: floor plans (designer = edit, library = versions) ----
  'GET /floor-plans': [...FLOORPLAN_VIEW, ...v('portfolio', 'facility-map')],
  'GET /floor-plans/facility/:branchRef/metrics': [...FLOORPLAN_VIEW, ...v('portfolio')],
  'GET /floor-plans/:floorId': [...FLOORPLAN_VIEW, ...v('facility-map', 'portfolio')],
  'POST /floor-plans/:floorId': FP_EDIT,
  'DELETE /floor-plans/:floorId': 'facility-floorplans:delete',
  'PUT /floor-plans/:floorId/units/:unitId': FP_EDIT,
  'DELETE /floor-plans/:floorId/units/:unitId': FP_EDIT,
  'POST /floor-plans/:floorId/units': FP_EDIT,
  'POST /floor-plans/:floorId/blocks': FP_EDIT,
  'PUT /floor-plans/:floorId/blocks/:blockId': FP_EDIT,
  'DELETE /floor-plans/:floorId/blocks/:blockId': FP_EDIT,
  'GET /floor-plans/:floorId/boundaries': FLOORPLAN_VIEW,
  'POST /floor-plans/:floorId/boundaries': FP_EDIT,
  'PUT /floor-plans/:floorId/boundaries/:boundaryId': FP_EDIT,
  'DELETE /floor-plans/:floorId/boundaries/:boundaryId': FP_EDIT,
  'GET /floor-plans/:floorId/markers': FLOORPLAN_VIEW,
  'POST /floor-plans/:floorId/markers': FP_EDIT,
  'PUT /floor-plans/:floorId/markers/:markerId': FP_EDIT,
  'DELETE /floor-plans/:floorId/markers/:markerId': FP_EDIT,
  'GET /floor-plans/:floorId/underlay': FLOORPLAN_VIEW,
  'GET /floor-plans/:floorId/underlay/image': FLOORPLAN_VIEW,
  'POST /floor-plans/:floorId/underlay': FP_EDIT,
  'PUT /floor-plans/:floorId/underlay': FP_EDIT,
  'DELETE /floor-plans/:floorId/underlay': FP_EDIT,
  'POST /floor-plans/:floorId/batch': FP_EDIT,
  'POST /floor-plans/:floorId/reconcile': FP_EDIT,
  'GET /floor-plans/:floorId/size-mismatches': FLOORPLAN_VIEW,
  'GET /floor-plans/:floorId/publish-preview': FLOORPLAN_VIEW,
  // Publishing changes what customers can book → approve (was promotions.approve).
  'POST /floor-plans/:floorId/publish': 'facility-floorplans:approve',
  'POST /floor-plans/:floorId/revert-to-published': FP_EDIT,
  'POST /floor-plans/:floorId/drafts': 'facility-floorplans:create',
  'GET /floor-plans/:floorId/drafts': FLOORPLAN_VIEW,
  'GET /drafts/:draftId': FLOORPLAN_VIEW,
  'GET /drafts/:draftId/publish-preview': FLOORPLAN_VIEW,
  'PATCH /drafts/:draftId': 'facility-floorplan-library:update',
  'DELETE /drafts/:draftId': 'facility-floorplan-library:delete',
  'POST /drafts/:draftId/load': FP_EDIT,
  'POST /drafts/:draftId/publish': 'facility-floorplans:approve',
  'GET /floor-plans/:floorId/metrics': [...FLOORPLAN_VIEW, ...v('portfolio')],
  'GET /floor-plans/:floorId/metrics/snapshots': [...FLOORPLAN_VIEW, ...v('portfolio')],
  'GET /floor-plans/:floorId/metrics/snapshots/authoritative': [...FLOORPLAN_VIEW, ...v('portfolio')],
  'POST /floor-plans/:floorId/metrics/snapshots': 'facility-floorplans:create',
  // Approve edges are re-checked in the core (facility-floorplans:approve).
  'PATCH /floor-plans/metrics/snapshots/:id/status': ['facility-floorplans:update', 'facility-floorplans:approve'],

  // ---- facilities: operations ----
  'GET /work-orders': v('facility-maintenance'),
  'POST /work-orders': 'facility-maintenance:create',
  'GET /work-orders/:id': v('facility-maintenance'),
  'PATCH /work-orders/:id': 'facility-maintenance:update',
  'DELETE /work-orders/:id': 'facility-maintenance:delete',
  'GET /preventive-tasks': v('facility-maintenance'),
  'GET /preventive-tasks/progress': v('facility-maintenance'),
  'POST /preventive-tasks': 'facility-maintenance:create',
  'PATCH /preventive-tasks/:id': 'facility-maintenance:update',
  'DELETE /preventive-tasks/:id': 'facility-maintenance:delete',
  'GET /assets': v('facility-assets', 'facility-maintenance', 'facility-incidents'),
  'POST /assets': 'facility-assets:create',
  'GET /assets/:id': v('facility-assets', 'facility-maintenance', 'facility-incidents'),
  'PATCH /assets/:id': 'facility-assets:update',
  'DELETE /assets/:id': 'facility-assets:delete',
  'GET /vendors': v('facility-assets', 'facility-maintenance'),
  'POST /vendors': 'facility-assets:create',
  'GET /vendors/:id': v('facility-assets', 'facility-maintenance'),
  'PATCH /vendors/:id': 'facility-assets:update',
  'DELETE /vendors/:id': 'facility-assets:delete',
  'GET /incidents': v('facility-incidents'),
  'POST /incidents': 'facility-incidents:create',
  'GET /incidents/:id': v('facility-incidents'),
  'PATCH /incidents/:id': 'facility-incidents:update',
  'DELETE /incidents/:id': 'facility-incidents:delete',
  'GET /access/doors': v('facility-access'),
  'POST /access/doors': 'facility-access:create',
  'PATCH /access/doors/:id': 'facility-access:update',
  'DELETE /access/doors/:id': 'facility-access:delete',
  'GET /access/credentials': v('facility-access'),
  'POST /access/credentials': 'facility-access:create',
  'PATCH /access/credentials/:id': 'facility-access:update',
  'DELETE /access/credentials/:id': 'facility-access:delete',
  'GET /access/policies': v('facility-access'),
  'POST /access/policies': 'facility-access:create',
  'PATCH /access/policies/:id': 'facility-access:update',
  'DELETE /access/policies/:id': 'facility-access:delete',
  'GET /access/events': v('facility-access'),
  'POST /access/events': 'facility-access:create',
  'GET /access/stats': v('facility-access'),
  'GET /inspections/checklists': v('facility-inspections'),
  'POST /inspections/checklists': 'facility-inspections:create',
  'PATCH /inspections/checklists/:id': 'facility-inspections:update',
  'DELETE /inspections/checklists/:id': 'facility-inspections:delete',
  'GET /inspections/certificates': v('facility-inspections'),
  'POST /inspections/certificates': 'facility-inspections:create',
  'PATCH /inspections/certificates/:id': 'facility-inspections:update',
  'DELETE /inspections/certificates/:id': 'facility-inspections:delete',

  // ---- protection & addons ----
  'GET /protection-plans': v('extras-plans', 'quotes'),
  'POST /protection-plans': 'extras-plans:create',
  'PATCH /protection-plans/:id': 'extras-plans:update',
  'DELETE /protection-plans/:id': 'extras-plans:delete',
  'GET /addons': v('extras-addons', 'quotes'),
  'POST /addons': 'extras-addons:create',
  'PATCH /addons/:id': 'extras-addons:update',
  'DELETE /addons/:id': 'extras-addons:delete',

  // ---- discount & promotion ----
  'GET /promotions': v(...PROMO_TABS),
  'GET /promotions/:id': v(...PROMO_TABS),
  'POST /promotions': 'promo-code-builder:create',
  'PUT /promotions/:id': 'promo-code-builder:update',
  'DELETE /promotions/:id': 'promo-code-builder:delete',
  'GET /promotion-plans/performance': v('promo-performance', 'promo-overview', 'command'),
  'GET /promotion-plans': v(...PROMO_TABS),
  'POST /promotion-plans': ['promo-discount-matrix:create', 'promo-free-months:create', 'promo-code-builder:create', 'promo-library:create'],
  'GET /promotion-plans/:id': v(...PROMO_TABS),
  'PUT /promotion-plans/:id': PROMO_BUILDERS_UPDATE,
  // Go-live edges (→ SCHEDULED / ACTIVE) are re-checked in the core (promo-library:approve).
  'PATCH /promotion-plans/:id/status': [...PROMO_BUILDERS_UPDATE, 'promo-library:approve'],
  'GET /promotion-plans/:id/versions': v('promo-library', 'promo-history'),
  'GET /promotion-plans/:id/compare': v('promo-library', 'promo-history'),
  'POST /promotion-plans/:id/restore': 'promo-library:create',
  'GET /promotion-plans/:id/redemptions': v('promo-library', 'promo-performance', 'promo-history'),
  'POST /promotion-plans/:id/redemptions': 'promo-library:update',
  'POST /promotion-plans/:id/validate': [...PROMO_BUILDERS_UPDATE, 'promo-library:approve'],
  'POST /promotion-plans/:id/duplicate': 'promo-library:create',
  'DELETE /promotion-plans/:id': 'promo-library:delete',
  'GET /safeguards': v('promo-safeguards', 'promo-overview', 'promo-library'),
  'POST /safeguards': 'promo-safeguards:create',
  'PUT /safeguards/:id': 'promo-safeguards:update',
  'DELETE /safeguards/:id': 'promo-safeguards:delete',

  // ---- content ----
  'GET /site-content': v('content-list'),
  'GET /site-content/:key': v('content-list'),
  'PUT /site-content/:key': 'content-list:update',
  'GET /content': v('content-list'),
  'POST /content': 'content-list:create',
  'GET /content/:key': v('content-list'),
  'PUT /content/:key': 'content-list:update',
  'DELETE /content/:key': 'content-list:delete',
  'POST /content/:key/image': 'content-list:update',
  'DELETE /content/:key/image': 'content-list:update',

  // ---- site builder (approve = publish) ----
  'GET /site/schema': v('site-builder'),
  'GET /site/config': v('site-builder'),
  'GET /site/pages': v('site-builder'),
  'POST /site/pages': 'site-builder:create',
  'GET /site/pages/:id': v('site-builder'),
  'PATCH /site/pages/:id': 'site-builder:update',
  'PUT /site/pages/:id/draft': 'site-builder:update',
  'POST /site/pages/:id/duplicate': 'site-builder:create',
  'DELETE /site/pages/:id': 'site-builder:delete',
  'GET /site/pages/:id/versions': v('site-builder'),
  'GET /site/pages/:id/versions/:versionId': v('site-builder'),
  'POST /site/pages/:id/rollback/:versionId': 'site-builder:approve',
  'POST /site/publish': 'site-builder:approve',
  'GET /site/publishes': v('site-builder'),
  'GET /site/settings': v('site-builder'),
  'PUT /site/settings/draft': 'site-builder:update',
  'GET /site/media': v('site-builder'),
  'POST /site/media': 'site-builder:create',
  'PATCH /site/media/:id': 'site-builder:update',
  'DELETE /site/media/:id': 'site-builder:delete',

  // ---- global settings ----
  'PUT /settings': ['settings-general:update', 'settings-booking:update'],
  'GET /fees': v('settings-fees', 'bill-invoices', 'customer-tenants'),
  'GET /fees/resolve': v('settings-fees', 'bill-invoices', 'customer-tenants'),
  'POST /fees': 'settings-fees:create',
  'PATCH /fees/:id': 'settings-fees:update',
  'DELETE /fees/:id': 'settings-fees:delete',
  'GET /business-rules': v('settings-booking', 'settings-general'),
  'PUT /business-rules': 'settings-booking:update',

  // ---- team & access (Owner only) ----
  'GET /users': 'OWNER',
  'POST /users': 'OWNER',
  'PATCH /users/:id': 'OWNER',
  'DELETE /users/:id': 'OWNER',
  'POST /users/:id/invite': 'OWNER',
  'POST /users/:id/reset-password': 'OWNER',
  'POST /users/:id/sign-out': 'OWNER',
  'GET /users/:id/access': 'OWNER',
  'PUT /users/:id/access': 'OWNER',
  'GET /roles': 'OWNER',
  'GET /roles/catalog': 'OWNER',
  'POST /roles': 'OWNER',
  'PATCH /roles/:id': 'OWNER',
  'DELETE /roles/:id': 'OWNER',
  'GET /permission-audit': 'OWNER',
};

function describe(spec: PermissionSpec): string {
  return typeof spec === 'string' ? spec : spec.join(' or ');
}

export function permissionGuard(spec: PermissionSpec) {
  return function checkPermission(req: Request, res: Response, next: NextFunction): void {
    const p = adminOf(req);
    if (!p) {
      fail(res, 401, 'UNAUTHORIZED', 'Sign in to continue');
      return;
    }
    if (spec === 'AUTH') return next();
    if (spec === 'OWNER') {
      if (p.isOwner) return next();
      fail(res, 403, 'FORBIDDEN', 'Only an Owner can manage users and roles.');
      return;
    }
    const anyOf = typeof spec === 'string' ? [spec] : spec;
    if (anyOf.some((perm) => can(p, perm))) return next();
    fail(res, 403, 'FORBIDDEN', `You don't have permission to do this (${describe(spec)}).`, { required: anyOf });
  };
}

function denyUndeclared(key: string) {
  return function undeclaredRoute(_req: Request, res: Response): void {
    console.error(`[rbac] route ${key} has no permission declared — denied`);
    fail(res, 403, 'FORBIDDEN', 'This action is not available.');
  };
}

interface RouteLayer {
  route?: { path: string | string[]; stack: Array<{ method?: string; handle: unknown }>; [m: string]: any };
}

/** Lists `METHOD /path` for every route on the router (used by the coverage test). */
export function listRouteKeys(router: Router): string[] {
  const keys: string[] = [];
  for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
    const route = layer.route;
    if (!route || typeof route.path !== 'string') continue;
    const method = route.stack.find((l) => l.method)?.method;
    if (method) keys.push(`${method.toUpperCase()} ${route.path}`);
  }
  return keys;
}

/**
 * Splices requireAuth (if missing) and the permission guard into every route.
 * Call once, after all routes are registered.
 */
export function applyRoutePermissions(router: Router, table: Record<string, PermissionSpec> = ROUTE_PERMISSIONS): void {
  for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
    const route = layer.route;
    if (!route || typeof route.path !== 'string') continue;
    const method = route.stack.find((l) => l.method)?.method;
    if (!method) continue;
    const key = `${method.toUpperCase()} ${route.path}`;
    const spec = table[key];
    if (spec === 'PUBLIC') continue;

    // Route.<method>(fn) appends a Layer; move it to the right position.
    const insert = (fn: unknown, index: number) => {
      route[method.toLowerCase()](fn);
      const added = route.stack.pop()!;
      route.stack.splice(index, 0, added);
    };
    let authIndex = route.stack.findIndex((l) => l.handle === requireAuth);
    if (authIndex < 0) {
      insert(requireAuth, 0);
      authIndex = 0;
    }
    insert(spec === undefined ? denyUndeclared(key) : permissionGuard(spec), authIndex + 1);
  }
}
