// StoreLah CMS admin UI — Finance overview — period/facility/basis KPIs, collection performance, cash & control snapshot, priority actions and health checks.
//
// Rendered by the shared prototype-parity workspace (financeWorkspace.js),
// which owns the planning state, the server sync and the shared toolbar /
// journey navigation. This module keeps the per-panel mount + permission gate.

import { getFinMount, canViewFin, renderDenied } from './financeShared.js';
import { initFinanceWorkspace } from './financeWorkspace.js';

const PANEL = 'bill-overview';

export async function bindFinanceOverviewView() {
  const host = getFinMount(PANEL);
  if (!host) return;
  if (!canViewFin(PANEL)) {
    renderDenied(host, PANEL);
    return;
  }
  const ws = initFinanceWorkspace();
  if (ws) await ws.render(PANEL);
}
