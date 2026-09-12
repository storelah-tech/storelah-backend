// Reference market PSF by unit size (from the original dashboard prototype).
// NOTE: the old XLBIZ entry was dropped with the floor-plan P1 work — no such
// UnitSize exists in the DB/seed, so the key could never match (and the
// action-center lookup guards unknown codes anyway).
export const MARKET_PSF: Record<string, number> = {
  LOCKER: 5.2,
  SMALL: 4.8,
  MEDIUM: 4.4,
  LARGE: 3.8,
};