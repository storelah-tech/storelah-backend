# P1 item 6 — Users & Roles facility scoping (design + leftovers)

## Model

- `OperatorFacilityAccess` (admin ↔ branch, or `scope: ALL` / branch null for
  everything). No rows = unscoped legacy full access.
- `Permission` grants from the catalog in `src/core/users.ts`
  (`promotions.approve`, `fees.manage`, `businessRules.manage`,
  `users.manage`).

## Gated enforcement (what is live)

`mayAct(adminUserId, permission)`: operators with **zero** permission rows are
unchecked (legacy fallback → allow). Enforcement bites **only** for operators
that hold at least one grant row. Applied at:

- `PATCH /promotion-plans/:id/status` go-live edges (`→ SCHEDULED`,
  `→ ACTIVE`) require `promotions.approve` (free-text `approverRole` is still
  recorded as an audit label);
- `POST/PATCH/DELETE /fees` require `fees.manage`;
- `PUT /business-rules` requires `businessRules.manage`;
- `POST/PATCH/DELETE /users[/:id/...]` require `users.manage`.

Reads are never gated. Login / JWT / `requireAuth` are unchanged (role claim
only). `scopedBranchIds()` helper is available for future per-facility
filtering but is **not** wired into list endpoints yet (see leftovers).

## Leftovers (explicit)

1. Free-text `approverRole` is NOT replaced — it remains the audit label on
   version snapshots; the verified check is additive for grant-holding actors.
2. No route-wide RBAC: list endpoints do not filter by facility scope yet
   (`scopedBranchIds` is the seam; wiring it into `listUnits`/`listTenants`
   needs a product decision on deny-vs-filter semantics).
3. JWT carries no permission claims — grants are read per-request from the DB
   (revocation is immediate, at one extra query per gated write).
4. No UI for per-facility *deny* rules or role templates — grant toggles +
   facility checkboxes cover the current ops need.
