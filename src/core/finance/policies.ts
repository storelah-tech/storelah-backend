// Finance policy config (IMPLEMENTATION_PLAN §6 policy-config rule).
//
// Every finance policy lives under `finance.*` in Setting (scalar) or
// BusinessRule. Rule: UNDECIDED = dependent action BLOCKED with a message
// naming the missing decision — never guess.
//
// DECIDED values encoded in Phase 1 (SettingDefs in src/core/settings.ts):
//   finance.gstEnabled      false (OFF default; GST UI hidden while OFF)
//   finance.gstRate         5 (%, editable, NOT hardcoded — owner GST final)
//   finance.expenseBasis    'accrual' (Q6: recognised when incurred;
//                           cash-basis view is derived/display-only)
//   finance.depositMode     'segregated' (Q7: separately-controlled funds,
//                           never auto-applied; no Phase 1 behavior)
//   finance.graceDays       0 (Q5 timing, editable; NO enforcement in Phase 1)
//   finance.lateFeeAfterDays 7 (Q5 timing, editable; NO enforcement in Phase 1)
//   finance.accessRestrictAfterDays 14 (Q5, editable; NO enforcement in Phase 1)
//   finance.refundTwoStep  'REQUIRED_EXCEPT_SUPERADMIN' (Q4 v1.2 FINAL — every
//                           refund two-step, Owner-only single-step; visible in
//                           Global Settings per the decision)
//
// NOT encoded (still open → BLOCKED until decided + landed in code):
//   late-fee amount/formula + termination steps (Q5 remainder)
//   manual price-override authority (Q9 sub-question)

import { AppError } from '../../lib/http';
import { getSettings } from '../settings';

export const FINANCE_KEYS = {
  gstEnabled: 'finance.gstEnabled',
  gstRate: 'finance.gstRate',
  expenseBasis: 'finance.expenseBasis',
  depositMode: 'finance.depositMode',
  graceDays: 'finance.graceDays',
  lateFeeAfterDays: 'finance.lateFeeAfterDays',
  accessRestrictAfterDays: 'finance.accessRestrictAfterDays',
  // Decided in words (Q4 v1.2: every-refund two-step + super-admin bypass) but
  // with no SettingDef until Phase 4 code lands — reads as UNDECIDED.
  refundTwoStep: 'finance.refundTwoStep',
} as const;

export interface FinancePolicies {
  gstEnabled: boolean;
  gstRate: number;
  expenseBasis: 'accrual' | 'cash';
  depositMode: string;
  graceDays: number;
  lateFeeAfterDays: number;
  accessRestrictAfterDays: number;
  refundTwoStep: string;
}

export async function getFinancePolicies(): Promise<FinancePolicies> {
  const s = await getSettings();
  const basis = s[FINANCE_KEYS.expenseBasis];
  const twoStep = s[FINANCE_KEYS.refundTwoStep];
  return {
    gstEnabled: s[FINANCE_KEYS.gstEnabled] === true,
    gstRate: typeof s[FINANCE_KEYS.gstRate] === 'number' ? (s[FINANCE_KEYS.gstRate] as number) : 5,
    expenseBasis: basis === 'cash' ? 'cash' : 'accrual',
    depositMode: typeof s[FINANCE_KEYS.depositMode] === 'string' ? (s[FINANCE_KEYS.depositMode] as string) : 'segregated',
    graceDays: typeof s[FINANCE_KEYS.graceDays] === 'number' ? (s[FINANCE_KEYS.graceDays] as number) : 0,
    lateFeeAfterDays: typeof s[FINANCE_KEYS.lateFeeAfterDays] === 'number' ? (s[FINANCE_KEYS.lateFeeAfterDays] as number) : 7,
    accessRestrictAfterDays:
      typeof s[FINANCE_KEYS.accessRestrictAfterDays] === 'number' ? (s[FINANCE_KEYS.accessRestrictAfterDays] as number) : 14,
    // Phase 4 decided value (SettingDef default); anything else (including a
    // stored UNDECIDED) keeps refund actions BLOCKED via requireDecided.
    refundTwoStep: typeof twoStep === 'string' && twoStep ? (twoStep as string) : 'UNDECIDED',
  };
}

/**
 * Throws 409 BLOCKED naming the missing decision when a policy key has no
 * decided value. Use at the top of every Phase 4+ action gated on an open
 * question (refunds, late fees, termination).
 */
export function requireDecided(value: unknown, key: string, decidedHint: string): asserts value {
  if (value === undefined || value === null || value === 'UNDECIDED') {
    throw new AppError(409, 'BLOCKED', `This action is blocked: finance policy "${key}" is undecided. ${decidedHint}`, {
      policy: key,
    });
  }
}
