// StoreLah CMS admin UI — Budgets & expenses — monthly operating budget with the model-linked lease row, scoped Update and the expenditure ledger.
//
// Rendered by the shared prototype-parity workspace (financeWorkspace.js),
// which owns the planning state, the server sync and the shared toolbar /
// journey navigation. This module keeps the per-panel mount + permission gate.

import { getFinMount, canViewFin, renderDenied } from './financeShared.js';
import { initFinanceWorkspace } from './financeWorkspace.js';

const PANEL = 'bill-budgets';

export async function bindFinanceBudgetsView() {
  const host = getFinMount(PANEL);
  if (!host) return;
  if (!canViewFin(PANEL)) {
    renderDenied(host, PANEL);
    return;
  }
  const ws = initFinanceWorkspace();
  if (ws) await ws.render(PANEL);
}
