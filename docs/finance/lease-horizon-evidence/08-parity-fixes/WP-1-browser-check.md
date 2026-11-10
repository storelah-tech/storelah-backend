# WP-1 browser check (2026-11-10)

Checked by the Claude Code orchestrator session in a real browser against the worktree CMS
(`localhost:4176`, local `storelah_lh` DB, test model "LH verify 5735" on Sembawang), after backend-agent
reported WP-1 without browser access. Model reset afterwards to 1 Dec 2026 / 60 months / S$5,000, operational
start 1 Dec 2026, deposit 0.

| Bug | Result | What was seen |
|---|---|---|
| B1 decimal term | **Pass** | 36.5 stays in the field; Update disabled; inline "Committed lease term must be a whole number of months — decimals such as 36.5 are rejected…" |
| B2 operational start save | **Pass** | PUT `…/inputs` sends `{startDate, nlaSqft}` only → 200; toast appears after the response; value persists after reload |
| B3 part-month opening | **Pass** (see note) | Lease 1 Dec / opening 15 Dec: Dec 26 revenue S$305 (was S$0), full-month lease S$5,000 + opex S$1,200 |
| B4 Year 1 payable | **Pass** | Lease 15 Dec / opening 1 Dec: Year 1 "15 Dec 2026 – 14 Dec 2027 · S$60,000 · 12 months" |
| B5 shorten then extend | **Pass** | 60 (Years 4–5 at S$5,400 / S$5,600) → 36 shows them as "kept for re-extension" → 72 restores them once as Entered; only Year 6 Estimated; no duplicates; all three Updates saved |
| B6 "All N" label | **Pass** | "All 61" for a 15 Dec 60-month lease (61 rows); "All 60" for a 1 Dec start |
| B7 budget months | **Pass** | List runs Dec 2026 – Dec 2027 for a lease ending 14 Dec 2027; Dec 2027 lease line S$2,258 |
| B8 term 121 | **Pass** | Inline "Committed lease term must be between 12 and 120 months."; Update disabled; 0 Estimated rows |

## New bug found — B9 (blocks WP-1 sign-off)

**False "changed by another user" conflict after a toolbar Operational start change.** Saving the Operational
start bumps the model version (e.g. 25 → 26) but Section 4 and Section 5 keep the old `rowVersion`. The next
Section 4 or Section 5 Update returns 409 and shows "This model was changed by another user. Reload the latest
version before updating." No other user is involved. Reproduced three times; reload clears it.

Fix: after any successful model write outside the section (toolbar inputs, other sections, size mix,
budgets), refresh `srv.lease.rowVersion` (and the valuation draft's version) from the response, or re-fetch
`GET …/landlord-lease`. Add a regression test that runs inputs PUT → lease PUT with the returned version.

## Notes for the owner

- **B3 reverse order** (opening 1 Dec, lease 15 Dec): December revenue is S$305, so revenue starts at the lease
  date, not the opening date. D6B defines only pre-opening days; operating before the lease starts is not
  covered by any decision. Owner to confirm.
- D6B says periods before opening are labelled "Pre-opening". With opening 15 Dec the row reads "Dec 26"; the
  1–14 Dec pre-opening days are not labelled.
