// StoreLah CMS admin UI — Finance tab dispatch (Phase 1).
//
// Keeps admin.js thin: one import, one call per billing tab click. The legacy
// overview/invoice/arrears tables keep their existing binding (bindBilling in
// admin.js); the new Overview read model and the eleven submodule shells live
// in finance*View.js.

import { bindFinanceOverviewView } from './financeOverviewView.js';
import { bindFinanceTransactionsView } from './financeTransactionsView.js';
import { bindFinanceModelsView } from './financeModelsView.js';
import { bindFinancePerformanceView } from './financePerformanceView.js';
import { bindFinanceBudgetsView } from './financeBudgetsView.js';
import { bindFinancePricingView } from './financePricingView.js';
import { bindFinanceReturnsView } from './financeReturnsView.js';
import { bindFinanceLibraryView } from './financeLibraryView.js';
import { bindFinanceInvoicesView } from './financeInvoicesView.js';
import { bindFinanceArrearsView } from './financeArrearsView.js';
import { bindFinanceCreditsView } from './financeCreditsView.js';
import { bindFinanceReconciliationView } from './financeReconciliationView.js';
import { bindFinanceInvestorView } from './financeInvestorView.js';
import { initFinanceWorkspace } from './financeWorkspace.js';

const BINDERS = {
  'bill-overview': bindFinanceOverviewView,
  'bill-transactions': bindFinanceTransactionsView,
  'bill-models': bindFinanceModelsView,
  'bill-performance': bindFinancePerformanceView,
  'bill-budgets': bindFinanceBudgetsView,
  'bill-pricing': bindFinancePricingView,
  'bill-returns': bindFinanceReturnsView,
  'bill-library': bindFinanceLibraryView,
  'bill-invoices': bindFinanceInvoicesView,
  'bill-arrears': bindFinanceArrearsView,
  'bill-credits': bindFinanceCreditsView,
  'bill-reconciliation': bindFinanceReconciliationView,
  'bill-investor': bindFinanceInvestorView,
};

/** All twelve finance submodule ids (sidebar order, spec §3). */
export const FINANCE_TABS = Object.keys(BINDERS);

/** Runs the view binder for a billing sub-tab (errors surface to the caller). */
export function bindFinanceTab(tab) {
  const fn = BINDERS[tab];
  if (!fn) return Promise.resolve();
  // Prototype-parity page header (title, purpose, actions) follows the panel.
  if (!['bill-overview', 'bill-transactions', 'bill-models', 'bill-performance', 'bill-budgets', 'bill-pricing', 'bill-returns', 'bill-library'].includes(tab)) {
    initFinanceWorkspace()?.render(tab);
  }
  return Promise.resolve(fn()).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[finance] binder failed for ${tab}:`, err);
    throw err;
  });
}

/**
 * Top journey navigation (spec §3, prototype-identical): seven journey items
 * mapping onto finance submodules. Item names per the spec table; TO-CONFIRM
 * against the prototype during Phase 1 UI review.
 */
export const FINANCE_JOURNEY = [
  ['Overview', 'bill-overview'],
  ['Forecast', 'bill-models'],
  ['Performance', 'bill-performance'],
  ['Costs', 'bill-budgets'],
  ['Assumptions', 'bill-pricing'],
  ['Returns', 'bill-returns'],
  ['Governance', 'bill-library'],
];
