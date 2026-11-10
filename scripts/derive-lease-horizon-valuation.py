#!/usr/bin/env python3
"""Independent derivation for the P3 lease-horizon valuation fixture.

Implements the handoff formulas (§§7.4-7.7, 8.2-8.5) and owner decisions
(D1B/D6B/D7A/D8A/D12A) from scratch in Python stdlib — no imports from the
TypeScript engine under test. Output:
  tests/e2e/fixtures/finance-lease-horizon-validation.json

Method: re-implement the v2 bucket projection (occupancy movement, pricing,
actual-days lease expense with anniversary + rent-free splits, opex, NOI) and
the valuation layer (running-sum periods, t=0 outflow, terminal placement,
dated NPV/IRR/paybacks/PI/DCF) in a second language, then triangulate the
Sembawang 60-month months 1-12 against the COMMITTED golden fixture
(finance-projection-golden.json, §28 of the spec) before writing anything.

Rounding mirrors the engine contract exactly:
  ts_round2(x) = floor(x*100 + 0.5) / 100  (== JS Math.round for all inputs)
  ts_round4(x) = floor(x*10000 + 0.5) / 10000
Money rows are cents-rounded; factors/rates/DFs stay unrounded internally.

Reviewer / Finance sign-off fields live in the emitted JSON (initially null).
"""

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # worktree root (storelah-backend lane)
GOLDEN = HERE / "tests/e2e/fixtures/finance-projection-golden.json"
OUT = HERE / "tests/e2e/fixtures/finance-lease-horizon-validation.json"


# ---------- JS-compatible rounding ----------

def ts_round2(x: float) -> float:
    return math.floor(x * 100 + 0.5) / 100


def ts_round4(x: float) -> float:
    return math.floor(x * 10000 + 0.5) / 10000


# ---------- pure UTC calendar arithmetic (D1B) ----------

def is_leap(y: int) -> bool:
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def dim(y: int, m: int) -> int:
    return [31, 29 if is_leap(y) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]


def parse_iso(s: str):
    y, m, d = int(s[0:4]), int(s[5:7]), int(s[8:10])
    assert 1 <= m <= 12 and 1 <= d <= dim(y, m), f"bad date {s}"
    return y, m, d


def to_iso(y: int, m: int, d: int) -> str:
    return f"{y:04d}-{m:02d}-{d:02d}"


def date_to_ordinal(s: str) -> int:
    y, m, d = parse_iso(s)
    # proleptic Gregorian ordinal (same differences as UTC day math)
    import datetime
    return datetime.date(y, m, d).toordinal()


def add_days(s: str, n: int) -> str:
    import datetime
    y, m, d = parse_iso(s)
    t = datetime.date(y, m, d) + datetime.timedelta(days=n)
    return to_iso(t.year, t.month, t.day)


def diff_days(a: str, b: str) -> int:
    return date_to_ordinal(b) - date_to_ordinal(a)


def add_months_clamp(start: str, months: int) -> str:
    y, m, d = parse_iso(start)
    total = y * 12 + (m - 1) + months
    ty, tm = divmod(total, 12)
    tm += 1
    return to_iso(ty, tm, min(d, dim(ty, tm)))


def committed_end(start: str, term: int) -> str:
    """D1B: day-before-anniversary when the nominal day exists, else EOM."""
    y, m, d = parse_iso(start)
    total = y * 12 + (m - 1) + term
    ty, tm = divmod(total, 12)
    tm += 1
    if d <= dim(ty, tm):
        return add_days(to_iso(ty, tm, d), -1)
    return to_iso(ty, tm, dim(ty, tm))


def month_label(y: int, m: int) -> str:
    return f"{y:04d}-{m:02d}"


def build_calendar_rows(start: str, end: str):
    sy, sm, _ = parse_iso(start)
    ey, em, _ = parse_iso(end)
    rows = []
    y, m = sy, sm
    while True:
        key = month_label(y, m)
        first = (y, m) == (sy, sm)
        last = (y, m) == (ey, em)
        rows.append({
            "calendarMonth": key,
            "daysInMonth": dim(y, m),
            "periodStart": start if first else to_iso(y, m, 1),
            "periodEnd": end if last else to_iso(y, m, dim(y, m)),
        })
        if last:
            break
        m += 1
        if m > 12:
            m, y = 1, y + 1
        assert len(rows) <= 121, "engine row limit"
    return rows


def build_lease_years(start: str, term: int):
    end = committed_end(start, term)
    years = []
    for k in range(1, math.ceil(term / 12) + 1):
        years.append({
            "leaseYear": k,
            "periodStart": add_months_clamp(start, (k - 1) * 12),
            "periodEnd": end if k * 12 >= term else committed_end(start, k * 12),
        })
    return years


def lease_year_at(row_start: str, lease_start: str, term: int) -> int:
    if row_start < lease_start:
        return 0
    year = 1
    for k in range(1, math.ceil(term / 12) + 1):
        if add_months_clamp(lease_start, (k - 1) * 12) <= row_start:
            year = k
    return year


# ---------- v2 bucket projection replica ----------

SIZE_MIX = [
    {"name": "XS", "nlaSqft": 455, "units": 31, "psf": 6.8},
    {"name": "S", "nlaSqft": 500, "units": 20, "psf": 6.2},
    {"name": "M", "nlaSqft": 650, "units": 16, "psf": 5.5},
    {"name": "L", "nlaSqft": 405, "units": 7, "psf": 4.8},
    {"name": "XL", "nlaSqft": 264, "units": 2, "psf": 4.2},
]

BASE_ECON = {
    "nlaSqft": 2274,
    "sizeMix": SIZE_MIX,
    "occupancy": {"rampFirst6": 180, "rampFrom7": 125, "moveOutRatePct": 2.5,
                  "churnStartMonth": 7, "targetPct": 92},
    "pricing": {"annualIncreasePct": 3},
    "opex": {"baseMonthly": 1200, "annualGrowthPct": 0},
    "capitalTotal": 108000,
}


def weighted_psf(size_mix) -> float:
    total = sum(c["nlaSqft"] for c in size_mix)
    return sum(c["nlaSqft"] * c["psf"] for c in size_mix) / total


def lease_expense_actual_days(row, lease_years, rents_by_year, rent_free) -> float:
    """Split the row by lease-year anniversaries; subtract rent-free overlap."""
    s, e = row["periodStart"], row["periodEnd"]
    total = 0.0
    for ly in lease_years:
        seg_s = max(s, ly["periodStart"])
        seg_e = min(e, ly["periodEnd"])
        if seg_e < seg_s:
            continue
        days = diff_days(seg_s, seg_e) + 1
        rf_days = 0
        if rent_free is not None:
            f_s = max(seg_s, rent_free[0])
            f_e = min(seg_e, rent_free[1])
            if f_e >= f_s:
                rf_days = diff_days(f_s, f_e) + 1
        chargeable = days - rf_days
        total += rents_by_year[ly["leaseYear"]] * chargeable / row["daysInMonth"]
    return ts_round2(total)


def project_v2(start_ops: str, term: int, lease_start: str, monthly_by_year,
               rent_free=None, occupancy_override=None) -> list:
    """Returns monthly rows: month, periodStart/End, factor, revenue, opex
    lines, noi (+ occupancy internals for debugging)."""
    econ = BASE_ECON
    nla = sum(c["nlaSqft"] for c in econ["sizeMix"])
    cap = nla * econ["occupancy"]["targetPct"] / 100
    base_psf = weighted_psf(econ["sizeMix"])
    occ = dict(econ["occupancy"])
    if occupancy_override:
        occ.update(occupancy_override)
    churn = occ["moveOutRatePct"] / 100
    rent_growth = 1 + econ["pricing"]["annualIncreasePct"] / 100
    opex_growth = 1 + econ["opex"]["annualGrowthPct"] / 100
    timeline_start = min(lease_start, start_ops)
    end = committed_end(lease_start, term)
    rows = build_calendar_rows(timeline_start, end)
    years = build_lease_years(lease_start, term)
    rents = {k + 1: monthly_by_year[min(k, len(monthly_by_year) - 1)]
             for k in range(math.ceil(term / 12))}
    out = []
    opening = 0.0
    cash = ts_round2(-econ["capitalTotal"])
    for i, row in enumerate(rows):
        t = i + 1
        active = diff_days(row["periodStart"], row["periodEnd"]) + 1
        factor = active / row["daysInMonth"]
        ly = lease_year_at(row["periodStart"], lease_start, term)
        model_year = max(0, ly - 1)
        pre = row["periodStart"] >= timeline_start and row["periodStart"] < start_ops
        gated = pre or row["periodStart"] < lease_start
        if not gated:
            planned = (occ["rampFirst6"] if t <= 6 else occ["rampFrom7"]) * factor
            move_out_raw = opening * churn if t >= occ["churnStartMonth"] else 0.0
            available = max(0.0, cap - opening + move_out_raw)
            move_in = ts_round2(min(planned, available))
            move_out = ts_round2(move_out_raw * factor)
        else:
            move_in, move_out = 0.0, 0.0
        net = ts_round2(move_in - move_out)
        if gated:
            closing = ts_round2(opening)
        else:
            closing = min(max(ts_round2(opening + net), 0.0), ts_round2(cap))
        psf = ts_round4(base_psf * rent_growth ** model_year)
        revenue = 0.0 if gated else ts_round2(closing * psf * factor)
        paid_lease = lease_expense_actual_days(row, years, rents, rent_free)
        opex_non = ts_round2(econ["opex"]["baseMonthly"] * opex_growth ** model_year * factor)
        op_cost = ts_round2(paid_lease + opex_non)
        noi = ts_round2(revenue - op_cost)
        cash = ts_round2(cash + noi)
        out.append({
            "t": t, "month": row["calendarMonth"],
            "periodStart": row["periodStart"], "periodEnd": row["periodEnd"],
            "periodFactor": ts_round4(factor),
            "openingSqft": ts_round2(opening), "moveInSqft": move_in,
            "moveOutSqft": move_out, "closingSqft": closing,
            "psf": psf, "revenue": revenue, "opexLease": paid_lease,
            "opexNonLease": opex_non, "operatingCost": op_cost,
            "noi": noi, "cash": cash,
        })
        opening = closing
    return out


# ---------- valuation replica ----------

def valuation_series(proj_rows, capital, deposit=0.0, reinstatement=0.0,
                     other=0.0, terminal_on=False):
    points = []
    t0 = ts_round2(-(capital + deposit))
    points.append({"index": 0, "period": 0.0, "cashFlow": t0,
                   "revenue": 0.0, "operatingCashFlow": 0.0,
                   "capex": ts_round2(-capital),
                   "otherCashFlow": ts_round2(-deposit)})
    term_net = ts_round2(deposit - reinstatement + other) if terminal_on else 0.0
    running = 0.0
    for i, r in enumerate(proj_rows):
        active = diff_days(r["periodStart"], r["periodEnd"]) + 1
        factor = active / month_dim(r["month"])
        running += factor
        last = i == len(proj_rows) - 1
        oth = term_net if last else 0.0
        points.append({"index": i + 1, "period": running,
                       "cashFlow": ts_round2(r["noi"] + oth),
                       "revenue": r["revenue"],
                       "operatingCashFlow": r["noi"], "capex": 0.0,
                       "otherCashFlow": oth})
    return points, term_net


def month_dim(month_label: str) -> int:
    return dim(int(month_label[0:4]), int(month_label[5:7]))


def npv_annual(annual: float, points) -> float:
    s = 0.0
    for p in points:
        s += p["cashFlow"] * (1 + annual) ** (-p["period"] / 12)
    return s


def npv_monthly(m: float, points) -> float:
    s = 0.0
    base = 1 + m
    for p in points:
        s += p["cashFlow"] * base ** (-p["period"])
    return s


def solve_irr(points):
    has_neg = any(p["cashFlow"] < 0 for p in points)
    has_pos = any(p["cashFlow"] > 0 for p in points)
    if not (has_neg and has_pos):
        return {"status": "none", "annualRate": None}
    hi = 1.0
    f_hi = npv_monthly(hi, points)
    guard = 0
    while f_hi > 0 and guard < 60 and hi < 1024:
        hi *= 2
        f_hi = npv_monthly(hi, points)
        guard += 1
    lo, n = -0.99, 2000
    brackets, exact = [], []
    prev_m, prev_f = lo, npv_monthly(lo, points)
    for i in range(1, n + 1):
        m = lo + (hi - lo) * i / n
        f = npv_monthly(m, points)
        if not (math.isfinite(f) and math.isfinite(prev_f)):
            prev_m, prev_f = m, f
            continue
        if prev_f == 0:
            exact.append(prev_m)
        if f == 0:
            exact.append(m)
        elif (prev_f < 0) != (f < 0):
            brackets.append((prev_m, m))
        prev_m, prev_f = m, f

    def bisect(a, b):
        lo_b, hi_b = a, b
        f_lo = npv_monthly(lo_b, points)
        for _ in range(200):
            mid = (lo_b + hi_b) / 2
            if mid in (lo_b, hi_b):
                break
            f_mid = npv_monthly(mid, points)
            if f_mid == 0:
                return mid
            if (f_lo < 0) != (f_mid < 0):
                hi_b = mid
            else:
                lo_b, f_lo = mid, f_mid
        return (lo_b + hi_b) / 2

    found = list(exact) + [bisect(a, b) for a, b in brackets]
    found.sort()
    roots = []
    for r in found:
        if not roots or abs(r - roots[-1]) > 1e-6:
            roots.append(r)
    if len(roots) == 0:
        return {"status": "none", "annualRate": None}
    if len(roots) == 1:
        return {"status": "valid", "annualRate": (1 + roots[0]) ** 12 - 1,
                "monthlyRate": roots[0]}
    return {"status": "multiple", "annualRate": None,
            "roots": [(1 + r) ** 12 - 1 for r in roots]}


def payback(cum, dims):
    if cum[0] >= 0:
        return {"month": 0, "fractionalMonths": None, "label": "Month 0"}
    for n in range(1, len(cum)):
        if cum[n] >= 0:
            # Interpolate on this series' own increment: undiscounted flow for
            # simple payback, discounted flow for discounted payback (prototype
            # npv-engine paybackPeriod). Round 2 fix, 2026-11-10.
            flow = cum[n] - cum[n - 1]
            frac = (0 - cum[n - 1]) / flow if flow != 0 else 1.0
            frac = min(max(frac, 0.0), 1.0)
            # P1 prototype rule (mirrors valuation.ts interpolatePayback):
            # whole months elapsed + round(fraction x 30) days, days omitted
            # when 0. `month` (series index incl. t=0) is unchanged.
            days = round(frac * 30)
            label = f"Month {n - 1}" if days == 0 else f"Month {n - 1} + {days} days"
            return {"month": n, "fractionalMonths": (n - 1) + frac,
                    "label": label}
    return {"month": None, "fractionalMonths": None, "label": "Beyond horizon"}


pts_cash = []  # set per analysis for payback interpolation (module-level for brevity)


def analyse(points, annual, dims):
    global pts_cash
    pts_cash = [p["cashFlow"] for p in points]
    dfs = [(1 + annual) ** (-p["period"] / 12) for p in points]
    dcfs = [p["cashFlow"] * d for p, d in zip(points, dfs)]
    npv = sum(dcfs)
    cum, run = [], 0.0
    for c in pts_cash:
        run += c
        cum.append(run)
    dcum, drun = [], 0.0
    for d in dcfs:
        drun += d
        dcum.append(drun)
    simple = payback(cum, dims)
    disc = payback(dcum, dims)
    t0 = pts_cash[0]
    pi = (npv - t0) / abs(t0) if t0 < 0 else None
    return {
        "annualRate": annual,
        "monthlyRate": (1 + annual) ** (1 / 12) - 1,
        "npv": npv,
        "cumulativeFreeCashFlow": run,
        "profitabilityIndex": pi,
        "simplePayback": simple,
        "discountedPayback": disc,
        "paybackMonth": simple["month"],
        "discountedPaybackMonth": disc["month"],
        "dcf": [{"index": p["index"], "discountFactor": d,
                 "discountedCashFlow": v, "cumulativeDiscountedCashFlow": c}
                for p, d, v, c in zip(points, dfs, dcfs, dcum)],
    }


# ---------- cases ----------

def proj_case(name, start_ops, term, lease_start, rents, rent_free=None,
             occupancy_override=None):
    rows = project_v2(start_ops, term, lease_start, rents, rent_free,
                      occupancy_override)
    occ = dict(BASE_ECON["occupancy"])
    if occupancy_override:
        occ.update(occupancy_override)
    return {
        "input": {
            "startDate": start_ops, "horizonMonths": term,
            "nlaSqft": BASE_ECON["nlaSqft"], "sizeMix": BASE_ECON["sizeMix"],
            "occupancy": occ,
            "pricing": BASE_ECON["pricing"],
            "lease": {"startDate": lease_start, "committedTermMonths": term,
                      "committedEndDate": committed_end(lease_start, term),
                      "monthlyByYear": rents, "rentFreeMonths": 0,
                      "rentFreeStartDate": rent_free[0] if rent_free else None,
                      "rentFreeEndDate": rent_free[1] if rent_free else None,
                      "prorationMethod": "actual_days", "currency": "SGD"},
            "opex": BASE_ECON["opex"], "capitalTotal": BASE_ECON["capitalTotal"],
        },
        "rows": rows,
    }


def main() -> int:
    cases = {}
    cases["sembawang60"] = proj_case("sembawang60", "2026-12-01", 60, "2026-12-01", [5000] * 5)
    cases["midMonth12"] = proj_case("midMonth12", "2026-12-15", 12, "2026-12-15", [5000])
    cases["short36"] = proj_case("short36", "2026-12-01", 36, "2026-12-01", [5000] * 3)
    cases["leapDay"] = proj_case("leapDay", "2028-02-29", 12, "2028-02-29", [5000])
    cases["monthEnd"] = proj_case("monthEnd", "2027-01-31", 1, "2027-01-31", [5000],
                                 # R6: churnStartMonth lives on the row index, so a
                                 # 2-row term cannot carry churnStartMonth 7.
                                 None, {"churnStartMonth": 1})
    cases["partialRentFree"] = proj_case("partialRentFree", "2026-12-15", 12, "2026-12-15",
                                         [5000], ("2026-12-15", "2027-01-15"))
    cases["escalation24"] = proj_case("escalation24", "2026-12-15", 24, "2026-12-15",
                                      [5000, 5500])
    cases["term120"] = proj_case("term120", "2026-12-01", 120, "2026-12-01", [5000] * 10)
    cases["preOpening"] = proj_case("preOpening", "2026-12-01", 12, "2026-11-15", [5000])

    # Triangulate months 1-12 against the COMMITTED golden fixture (§28).
    with open(GOLDEN, encoding="utf-8") as f:
        golden = json.load(f)
    g_rows = {r["t"]: r for r in golden["expectedMonths"]}
    s_rows = cases["sembawang60"]["rows"]
    worst = 0.0
    for r in s_rows[:12]:
        g = g_rows[r["t"]]
        for key in ("revenue", "opexLease", "opexNonLease", "operatingCost", "noi", "cash"):
            d = abs(r[key] - g[key])
            worst = max(worst, d)
            if d > 0.005:
                print(f"TRIANGULATION FAIL t={r['t']} {key}: script={r[key]} golden={g[key]}")
                return 1
    print(f"triangulation vs golden months 1-12: worst diff {worst:.6f} (cents OK)")

    valuations = {
        "plain": {"capitalTotal": 108000, "refundableDeposit": 0, "reinstatementCost": 0,
                  "otherTerminalCashFlow": 0, "includeTerminalCashFlows": False},
        "terminal": {"capitalTotal": 108000, "refundableDeposit": 15000,
                     "reinstatementCost": 5000, "otherTerminalCashFlow": 0,
                     "includeTerminalCashFlows": True},
        "depositSunk": {"capitalTotal": 108000, "refundableDeposit": 15000,
                        "reinstatementCost": 5000, "otherTerminalCashFlow": 0,
                        "includeTerminalCashFlows": False},
    }
    rates = [0.0, 0.08, 0.15]

    def value_case(case_rows, val):
        points, term_net = valuation_series(
            case_rows, val["capitalTotal"], val["refundableDeposit"],
            val["reinstatementCost"], val["otherTerminalCashFlow"],
            val["includeTerminalCashFlows"])
        dims = [0] + [month_dim(r["month"]) for r in case_rows]
        analyses = {str(a): analyse(points, a, dims) for a in rates}
        irr = solve_irr(points)
        return {"valuation": val, "points": [
            {"index": p["index"], "period": p["period"],
             "month": (case_rows[p["index"] - 1]["month"] if p["index"] > 0
                       else case_rows[0]["periodStart"]),
             "dateRange": ((case_rows[p["index"] - 1]["periodStart"] + "→" +
                            case_rows[p["index"] - 1]["periodEnd"])
                           if p["index"] > 0 else case_rows[0]["periodStart"]),
             "revenue": p["revenue"], "operatingCashFlow": p["operatingCashFlow"],
             "capex": p["capex"], "otherCashFlow": p["otherCashFlow"],
             "cashFlow": p["cashFlow"]} for p in points],
            "analyses": analyses, "irr": irr, "terminalNet": term_net}

    valued = {
        "sembawang60": value_case(cases["sembawang60"]["rows"], valuations["plain"]),
        "midMonth12": value_case(cases["midMonth12"]["rows"], valuations["plain"]),
        "short36": value_case(cases["short36"]["rows"], valuations["plain"]),
        "terminalShort36": value_case(cases["short36"]["rows"], valuations["terminal"]),
        "terminalFull60": value_case(cases["sembawang60"]["rows"], valuations["terminal"]),
        "depositSunkShort36": value_case(cases["short36"]["rows"], valuations["depositSunk"]),
        "leapDay": value_case(cases["leapDay"]["rows"], valuations["plain"]),
        "monthEnd": value_case(cases["monthEnd"]["rows"], valuations["plain"]),
        "partialRentFree": value_case(cases["partialRentFree"]["rows"], valuations["plain"]),
        "escalation24": value_case(cases["escalation24"]["rows"], valuations["plain"]),
        "term120": value_case(cases["term120"]["rows"], valuations["plain"]),
        "preOpening": value_case(cases["preOpening"]["rows"], valuations["plain"]),
    }

    # Synthetic solver/edge series (hand-verifiable; see DERIVATION note).
    def synth(points_cf, dims_s, rates_s=(0.15,)):
        pts = [{"index": i, "period": float(p), "cashFlow": float(c),
                "revenue": 0.0, "operatingCashFlow": 0.0, "capex": 0.0,
                "otherCashFlow": 0.0} for i, (p, c) in enumerate(points_cf)]
        return {"points": points_cf,
                "analyses": {str(a): analyse(pts, a, dims_s) for a in rates_s},
                "irr": solve_irr(pts)}

    synthetic = {
        # §7.7 worked example: 108k outflow, month-1 FCF -5185, 15%.
        "s77": synth([(0, -108000), (1, -5185)], [0, 31]),
        # One valid IRR, payback inside the horizon.
        "validIrr": synth([(0, -1000), (1, 300), (2, 300), (3, 300), (4, 300)],
                          [0, 30, 30, 30, 30]),
        # No sign change -> none (all-negative / all-non-negative).
        "noIrrNegative": synth([(0, -1000), (1, -100), (2, -100)], [0, 30, 30]),
        "noIrrPositive": synth([(0, 500), (1, 100), (2, 100)], [0, 30, 30]),
        # Two exact roots in monthly space (m=0 and m=0.5) -> multiple.
        "multipleIrr": synth([(0, -100), (1, 250), (2, -150)], [0, 30, 30]),
        # Small inflows: payback beyond any 12-mo horizon.
        "beyondHorizon": synth([(0, -10000)] + [(i, 100) for i in range(1, 13)],
                               [0] + [30] * 12),
    }

    fixture = {
        "name": "finance-lease-horizon-validation",
        "specRef": ("docs/finance/LEASE_HORIZON_HANDOFF.md §§7.4–7.7/8.2–8.5; "
                    "docs/finance/LEASE_HORIZON_OWNER_DECISIONS.md D7A/D8A/D11A/D12A/D13B"),
        "derivation": {
            "method": ("Standalone Python replica implementing the handoff formulas from scratch "
                       "(no imports from the TypeScript engine); Sembawang months 1-12 triangulated "
                       "against the committed golden fixture finance-projection-golden.json; "
                       "synthetic solver cases hand-verified (see DERIVATION note)."),
            "script": "scripts/derive-lease-horizon-valuation.py",
            "language": "python3 (stdlib only)",
            "reviewer": None,
            "reviewerSignOff": None,
            "signOffDate": None,
        },
        "tolerances": {
            "moneyRows": 0.01,
            "periods": 1e-9,
            "npv": 0.01,
            "irrAnnualised": 1e-6,
            "paybackFractionalMonths": 1e-9,
            "profitabilityIndex": 1e-6,
        },
        "inputs": {k: v["input"] for k, v in cases.items()},
        "valued": valued,
        "synthetic": synthetic,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
        f.write("\n")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
