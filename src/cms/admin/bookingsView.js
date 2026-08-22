// StoreLah CMS admin UI — bookings & move-ins views.
// Extracted from admin.js (phase-2 layering refactor; nodebestpractices #1).
// Rows come from GET /bookings and GET /move-ins (shared serializer in
// core/finance.ts): ref, tenant name/email/mobile/type, unit code/name/
// size/sqft/branch, moveInDate, duration, amount, amountDue, invoiceStatus,
// paidAmount, method, status. Payment figures are derived ONLY from recorded
// invoices — unpaid guests truthfully show DUE / $0 paid.

import { get, describeError } from './api.js';
import { $, escapeHtml, showBanner } from './dom.js';
import { BOOKING_TONE, INVOICE_TONE, fmtMoney, fmtDay } from './constants.js';
import { state, selectedFacilityName } from './state.js';

function syncNavBadge(id, count) {
  const badge = $(`#${id}`);
  if (!badge) return;
  badge.textContent = count;
  badge.hidden = count === 0;
}

function bookingRowHtml(r) {
  const invBadge = r.invoiceStatus
    ? `<span class="badge ${INVOICE_TONE[r.invoiceStatus] || 'res'}">${escapeHtml(r.invoiceStatus)}</span>`
    : '<span class="t-type">—</span>';
  const payLine = [
    `${fmtMoney(r.paidAmount || 0)} paid`,
    r.amountDue ? `${fmtMoney(r.amountDue)} due` : '',
    r.method ? escapeHtml(r.method) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const custSub = [r.tenantType, r.tenantEmail, r.tenantMobile].filter(Boolean).map(escapeHtml).join(' · ');
  const unitSub = [r.size || '', r.sqft ? `${r.sqft} sqft` : '', r.branch || ''].filter(Boolean).join(' · ');
  return `<tr>
    <td><strong>${escapeHtml(r.ref)}</strong></td>
    <td><div class="t-name">${escapeHtml(r.tenant)}</div>${custSub ? `<div class="t-type">${custSub}</div>` : ''}</td>
    <td><strong>${escapeHtml(r.unit)}</strong>${unitSub ? `<div class="t-type">${escapeHtml(unitSub)}</div>` : ''}</td>
    <td>${fmtDay(r.moveInDate)}</td>
    <td>${escapeHtml(r.duration)}</td>
    <td><strong>${fmtMoney(r.amount)}</strong></td>
    <td>${invBadge}${payLine ? `<div class="t-type">${payLine}</div>` : ''}</td>
    <td><span class="badge ${BOOKING_TONE[r.status] || 'res'}">${escapeHtml(String(r.status || '').replace('_', ' '))}</span></td>
  </tr>`;
}

function emptyRowHtml() {
  return '<tr><td colspan="8"><div class="t-type">— none</div></td></tr>';
}

export async function refreshBookingsView() {
  try {
    state.bookings = (await get('/bookings')) || [];
    syncNavBadge('navBookingsBadge', state.bookings.length);
    bindBookingsTable();
  } catch (err) {
    showBanner('Bookings: ' + describeError(err));
  }
}

export function bindBookingsTable() {
  const tbody = $('#bookingsViewBody');
  if (!tbody) return;
  const q = ($('#bookingSearch')?.value || '').trim().toLowerCase();
  const st = $('#bookingStatusFilter')?.value || '';
  const facility = selectedFacilityName(); // '' under All Facilities
  const rows = state.bookings.filter((r) => {
    if (facility && r.branch !== facility) return false;
    if (st && r.status !== st) return false;
    if (!q) return true;
    return [r.ref, r.tenant, r.tenantEmail, r.unit].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
  syncNavBadge('navBookingsBadge', rows.length);
  const sub = $('#bookingsViewSub');
  if (sub) {
    const scope = facility ? `${facility} · ` : '';
    const n = state.bookings.length;
    const shown = rows.length === n ? `${n} booking${n === 1 ? '' : 's'}` : `${rows.length} of ${n} bookings`;
    sub.textContent = `${scope}${shown} · live from checkout`;
  }
  tbody.innerHTML = rows.length ? rows.map(bookingRowHtml).join('') : emptyRowHtml();
}

export async function refreshMoveinsView() {
  try {
    const all = (await get('/move-ins')) || [];
    const facility = selectedFacilityName();
    const rows = facility ? all.filter((r) => r.branch === facility) : all;
    syncNavBadge('navMoveinsBadge', rows.length);
    const tbody = $('#moveinsViewBody');
    if (!tbody) return;
    const sub = $('#moveinsViewSub');
    if (sub) {
      const scope = facility ? `${facility} · ` : '';
      const n = rows.length;
      sub.textContent = `${scope}${n} move-in${n === 1 ? '' : 's'} scheduled today`;
    }
    tbody.innerHTML = rows.length ? rows.map(bookingRowHtml).join('') : emptyRowHtml();
  } catch (err) {
    showBanner('Move-ins: ' + describeError(err));
  }
}
