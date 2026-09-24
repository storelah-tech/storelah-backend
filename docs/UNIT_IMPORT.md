# Unit Import (templated spreadsheet → CSV)

Import storage units in bulk from a templated spreadsheet. **CSV-only**: there
is no workbook dependency in this repo, so `.xlsx` files are NOT accepted —
save/export the sheet as CSV from Excel or Google Sheets first.

## Endpoints (all under `/api/v1/cms`, admin Bearer JWT)

| Endpoint                   | Method | Purpose                                              |
| -------------------------- | ------ | ---------------------------------------------------- |
| `/units/import/template`   | GET    | Download the header-only CSV template (file download, not the `{ data, meta }` envelope) |
| `/units/import`            | POST   | Import rows: `{ "csv": "<csv text>" }` → per-row report |

The CMS admin **Units** view has an **⭳ Import** button (file picker, `.csv`
only) wired to the same endpoints; the result summary toasts as
`created · skipped · errors`, per-row errors list in the units banner (first 8)
with the full list in the devtools console.

## Template columns

```
code,branch,level,size,sqft,rate,status,hasAC,hasPillar,name
```

| Column    | Required | Format / notes                                                                 |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `code`    | No       | 4-digit code (e.g. `1001`). Blank = mint the next free code.                   |
| `branch`  | Yes      | Branch **code** (e.g. `BM`) or branch id.                                      |
| `level`   | No       | Floor level integer (e.g. `1`). Blank = branch's lowest floor.                 |
| `size`    | Yes      | UnitSize **code** (e.g. `SMALL`) or size id.                                   |
| `sqft`    | Yes      | Positive integer.                                                              |
| `rate`    | Yes      | Monthly rate SGD, 0 or greater.                                                |
| `status`  | No       | `AVAILABLE` (default) / `RESERVED` / `MAINTENANCE` / `INACTIVE` / `BLOCKED`. `OCCUPIED` and `OVERDUE` are rejected — occupancy requires a tenant assignment, never an import. |
| `hasAC`   | No       | `yes`/`no` (also `y`/`n`, `true`/`false`, `1`/`0`). Blank = No.                |
| `hasPillar` | No     | Same yes/no format. Blank = No.                                                |
| `name`    | No       | Optional display label (max 80 chars). Blank = display falls back to the code. |

## Example

```csv
code,branch,level,size,sqft,rate,status,hasAC,hasPillar,name
1001,BM,1,SMALL,24,95,AVAILABLE,yes,no,
,BM,1,LOCKER,9,38,AVAILABLE,no,no,
,WD,2,MEDIUM,60,210,RESERVED,yes,yes,Corner unit
```

- Row 1 pins code `1001`; row 2 mints the next free code; row 3 mints + sets a name.
- `curl` round-trip (template then import):
  ```bash
  TOKEN=... # POST /api/v1/cms/login token
  curl -s -H "Authorization: Bearer $TOKEN" \
    http://localhost:4000/api/v1/cms/units/import/template
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d @- http://localhost:4000/api/v1/cms/units/import <<'EOF'
  {"csv":"code,branch,level,size,sqft,rate,status,hasAC,hasPillar,name\n1001,BM,1,SMALL,24,95,AVAILABLE,yes,no,\n"}
  EOF
  ```

## Policy

- **Create-new by default.** A row with an explicit `code` that already exists
  is **skipped** (reported as `skipped`), never overwritten — this is what
  keeps `OCCUPIED`/`RESERVED` units safe from import writes.
- **Per-row report**: every data row returns
  `{ row, status: created | skipped | error, code, message }` with
  `{ total, created, skipped, errors }` meta. One bad row never aborts the rest.
- **Batch size**: the global `express.json()` body limit applies (~100kb ≈
  ~1500 rows per POST) — split bigger files into multiple imports.
- New codes come from the canonical 4-digit codegen (`src/core/units.ts`):
  next free code above the global MAX, starting at 1001, soft-deleted codes
  never reused.
