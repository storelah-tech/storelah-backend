// Finance size-mix ↔ size catalogue (2026-11-11, owner "please update
// everything"). The CMS catalogue is, in order:
//   Locker 8–15 · XS 10–19 · S 20–39 · M 40–69 · L 70–99 · XL 100–150 sq ft
// (UnitSize codes LOCKER / XS / SMALL / MEDIUM / LARGE / XLBIZ; see migration
// 20261111000000_unit_size_ranges). Locker and XS are SEPARATE planning rows.
//
// upgradeSizeMix() rewrites a pre-catalogue size mix (5-row template
// XS/S/M/L/XL, or a synced mix labelled with the old live names
// Locker/Small/Medium/Large/Extra large) onto the catalogue WITHOUT changing
// any number: every existing row keeps its NLA, units and PSF; rows that meant
// the old LOCKER/XS bucket become "XS"; labels/ranges follow the catalogue; an
// empty "Locker" row (0 NLA, 0 units) is added so totals, weighted PSF and
// every projection figure stay identical. Idempotent: a mix that already has
// both a Locker and an XS row is returned unchanged.

import type { SizeCategoryInput } from './projection';

export const SIZE_MIX_CATALOGUE = [
  { label: 'Locker', range: '8–15 sq ft' },
  { label: 'XS', range: '10–19 sq ft' },
  { label: 'S', range: '20–39 sq ft' },
  { label: 'M', range: '40–69 sq ft' },
  { label: 'L', range: '70–99 sq ft' },
  { label: 'XL', range: '100–150 sq ft' },
] as const;

/** Pre-catalogue label (case-insensitive) → catalogue label. "Locker" is the
 * OLD live LOCKER size (today's XS), so it maps to XS here. */
const LEGACY_TO_CATALOGUE: Record<string, string> = {
  LOCKER: 'XS', XS: 'XS', 'EXTRA SMALL': 'XS',
  S: 'S', SMALL: 'S',
  M: 'M', MEDIUM: 'M',
  L: 'L', LARGE: 'L',
  XL: 'XL', XLBIZ: 'XL', 'EXTRA LARGE': 'XL',
};

const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

export function isCatalogueSizeMix(mix: readonly SizeCategoryInput[]): boolean {
  const names = new Set(mix.map((c) => norm(c.name)));
  return names.has('LOCKER') && names.has('XS');
}

export function upgradeSizeMix(mix: readonly SizeCategoryInput[] | null | undefined): SizeCategoryInput[] {
  const rows = Array.isArray(mix) ? mix : [];
  if (!rows.length || isCatalogueSizeMix(rows)) return rows.map((c) => ({ ...c }));
  const rangeOf = new Map<string, string>(SIZE_MIX_CATALOGUE.map((c) => [c.label, c.range]));
  const out = rows.map((c) => {
    const label = LEGACY_TO_CATALOGUE[norm(c.name)];
    return label ? { ...c, name: label, range: rangeOf.get(label) } : { ...c };
  });
  const xs = out.find((c) => c.name === 'XS');
  // Empty Locker row first (catalogue order). PSF copies XS so the owner
  // starts from the XS rate; with 0 NLA it never weighs into any figure.
  out.unshift({ name: 'Locker', range: '8–15 sq ft', nlaSqft: 0, units: 0, psf: xs ? xs.psf : 0 });
  return out;
}
