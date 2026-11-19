# A7 UI checklist — Track A CMS (manual verification + jump actions)

**Status: browser/screenshot verification PENDING owner run.** This repo has no
browser harness (vitest + supertest only), so prototype-v55 screenshots cannot
be produced here. API-level coverage is the gate:
`tests/e2e/moveout-ui.test.ts` (14 tests, all passing) proves every UI-called
route behaves, every §3 jump target exists and is permission-gated, and the
retired D14 action keeps its 410 contract. What follows must be walked through
in a real browser against a throwaway DB before sign-off.

## 0. Harness

1. `pnpm db:migrate` on a throwaway DB, `pnpm dev` (port 4000).
2. Sign in as Owner (`admin@storelah.sg`), plus one Finance Operator and one
   Finance Approver from Global Settings › Team & access.
3. Seed: two active tenants (one multi-unit), units AVAILABLE at two
   facilities, one portal notice (customer portal → move-out request).

## 1. Customer profile (Customer Management → Tenants → open customer)

- [ ] Hero shows **Preview transfer**, **Record move-out request**,
      **Change status**, ＋ Note (exact copy). Change status carries
      `data-perm="customer-tenants:update"`.
- [ ] **Change status** → modal lists the customer's rentals, status select
      (Active → Former customer), reason mandatory. Saving without a reason
      is refused; the safeguard copy is visible:
      “Use the move-out workflow … never creates a refund …”.
      Profile refreshes without a full reload.
- [ ] Rental & pricing → **Previous units · transfer history** appears after a
      posted transfer (previous unit, tenure, billed totals, transfer credit,
      **Open transfer record**, **View historical ledger**).
- [ ] Billing & payments → **Settlement & transfer postings** shows processed
      refunds / posted charges / posted transfers; pending requests show with
      “Pending Finance decision — no money moved”.
- [ ] Documents → RF/CH/TRF/CL records appear after Finance activity, plus
      **Open financial documents**.
- [ ] Move-out & transfers → **More actions** row (Record move-out notice,
      Transfer unit, Transactions & documents), portal notices timeline,
      **Record move-out request** / **Preview transfer** buttons, then the
      **Move-out & transfers workspace** card (cases + transfers with
      **Open case** / **Open Finance approval** / **Open transfer record**).
- [ ] Loading state (“Loading move-out cases & transfers…”), error state, and
      empty state (“No move-out cases or transfers for this customer yet…”).

## 2. Move-out notices register (NEW sidebar: Customer Management → Move-out notices, `#moveout-notices`)

- [ ] Sidebar entry visible for Owner/Manager/Finance roles, hidden for
      Viewer (no `customer-moveouts:view`).
- [ ] Header: **Record move-out request**, **Move-out policy**; subtitle
      (“Every move-out request in one place — notice, inspection and
      Finance-approved settlement.”); status-definitions disclosure (all 7
      case states, one line each); KPI row (Open move-outs, Awaiting
      inspection, Finance review, Notice policy days, Protection refund
      S$0.00 — never refunded); filters (search, 7 case statuses, facility);
      sub-count; loading/empty
      (“No move-out cases match these filters.”)/error+Retry/denied states.
- [ ] Row: case no, customer (→ profile), unit/facility, final access +
      “access ends 11:59 PM”, notice pill + days, **Est. rent refund**
      (server preview unused-rent figure, S$0.00 for free-agreement months),
      **Inspection** (Completed + release status, or Complete inspection
      action once the final day arrives), settlement ref + pill,
      status pill, **Open case** (+ **Open Finance approval** when settled).
- [ ] **＋ Record request** → modal (separate Customer select grouped by
      email + Unit/rental select with ACTIVE unit-holding rentals only —
      unit-less tenants excluded; final access defaults to request + notice
      days; live notice banner + server-computed settlement preview table
      refresh on every input change) → success toast + case workspace opens.
- [ ] **Move-out policy** → Global Settings › Move-outs & refunds tab.

## 3. Move-out case workspace (`#moveout-case`)

- [ ] Request card, final-access card (cut-off, notice days/compliance,
      deposit S$0), inspection card, settlement card (calc lines + outcome),
      reverse-chron audit timeline.
- [ ] **Change move-out date** (only pre-inspection; policy allows): modal
      shows current date + current estimate; reason required
      (“A reason is required to change the move-out date.”); save toast names
      before → after + revised compliance.
- [ ] **Complete inspection** (only on/after final day): four checks enforced
      (“Complete all four release checks before submitting.”), notes required
      (“Inspection notes or evidence are required.”); submit creates exactly
      one Finance record (or zero-close) with the right toast.
- [ ] **Reverse request**: confirm → reason modal → rental Active, case kept.
- [ ] **Open Finance approval** appears once a settlement exists.

## 4. Moves queue (Customer Management → Move-outs tab)

- [ ] Thead reads Case/Customer/Unit/Final access/Notice/Status; toolbar has
      **＋ Record request** + **Open Move-out notices register**.
- [ ] NO Complete/Withdraw buttons anywhere (D14 retired — server answers 410;
      proven by `moveout-ui.test.ts` “legacy retirement” + grep proof below).
- [ ] Rows jump to **Open case** / **Open Finance approval**.

## 5. Finance (Transactions, documents & approvals)

- [ ] **＋ Manual refund** (perm-gated) → modal validates
      (“Enter a refund amount greater than zero.”,
      “Notes and the refund basis are required.”,
      “Link the source transaction or invoice for this billing refund.”) →
      success concept “`<ref>` submitted for approval. No money has been
      sent.” → drawer opens on the new record.
- [ ] **Finance change requests** card lists Changes-requested rows with
      customer jump + **Review**; empty when none.
- [ ] Review drawer per status: Pending approval → **Request changes** /
      **Approve** (or **Approve & post transfer**); Approved refund →
      **Process refund**; Approved charge → **Post customer charge**;
      Approved transfer → **Post transfer**; Failed/Processing → reason +
      **Retry processing**; Changes requested → **Submit correction**
      (perm-gated) + “Awaiting Operations correction.”
- [ ] Request-changes modal: category, assign-to, due date, mandatory note.
      Correction modals recalculate (never key money).
- [ ] Processor reference stays in detail, never the table column.

## 6. Settings › Move-outs & refunds (`#settings` → Move-outs & refunds)

- [ ] Tab visible with `settings-moveouts:view`; hidden otherwise. Panel shows
      the six rules with handoff copy + the “Payments run on the first…”
      rule; approval-role select (Administrator or Finance / Administrator
      only); locked inspection note.
- [ ] Save disabled until dirty; Finance Approver can save moveout.* keys;
      booking.* keys are refused with the scoping message (server 403);
      Viewer save is hidden (no `settings-moveouts:update`).
- [ ] Audit: saving never rewrites open cases (R7 snapshots — verify by
      changing notice days with an open case and re-reading its
      `policySnapshot`).

## 7. §3 jump-action matrix (walk every one)

| From | Action | Lands on |
|---|---|---|
| Transfer submit confirmation | **Open Finance approval** | bill-transactions drawer on the new `TRF-` record |
| Finance change request save | (queue) | Ops queue row + customer transfer timeline entry |
| Case workspace (settled) | **Open Finance approval** | drawer on the settlement |
| Register header | **Move-out policy** | settings-moveouts tab |
| Register customer cell | customer name | customer profile |
| Previous-unit card | **Open transfer record** | transfer drawer |
| Previous-unit card | **View historical ledger** | profile Billing tab |
| Profile movement case row | **Open case** | case workspace |
| Manual-refund confirmation | **Open Finance approval** | drawer on the new `RF-` record |
| Queue row | **Open Finance approval** | drawer on the settlement |

## 8. §19 state matrix (spot-check per new panel)

Loading → skeleton/“Loading…”; empty → handoff copy; error → message +
Retry; permission → action hidden (`data-perm`) + denied panel copy where the
whole screen is gated. Queue/register/settings/profile-sections covered in
§§1–6.

## 9. Proofs already done (no browser needed)

- `grep -rn "patch(\`/move-outs\|data-mo-act\|transitionMoveOut" src/cms/` →
  zero UI triggers for the retired D14 complete/cancel (server keeps the 410
  + pointer; test asserts it).
- Button-copy grep: every §2/handoff label present (§4 of the A7 report).
- `pnpm check` clean; `tests/e2e/moveout-ui.test.ts` 14/14 on an isolated
  `*_test` DB; full `pnpm test:e2e` result vs the A6 baseline in the report.
- dashboard.html untouched (`git status` shows no modification).

## 10. Known deviations / follow-ups

1. **Browser/screenshots vs v55: PENDING** — no harness in repo (owner-run).
2. **Date-change Compare-before/after button removed**: no preview-for-date
   endpoint exists and the UI may not key money; the save toast reports
   before → after + compliance. A `GET /move-out-cases/:id/preview?date=`
   readout is the natural follow-up (additive, needs routePermissions entry).
3. **`#moveoutsSub` static HTML** keeps the pre-A7 sub until `bindMovesQueue`
   rewrites it (dashboard.html is frozen — runtime replacement only).
4. **Owner-only policy edits**: `PUT /business-rules` accepts
   `settings-moveouts:update` but scopes those callers to `moveout.*` keys
   until D1/D2 resolve approver-vs-Owner policy editing.
5. **Sidebar highlight** for the injected settings tab stays on Global
   Settings (no per-tab nav item exists for it).
6. **Phase-4 `＋ Calculate refund` calculator kept**: not named by §27/D14;
   flag for the owner whether to retire it in favour of ＋ Manual refund.
