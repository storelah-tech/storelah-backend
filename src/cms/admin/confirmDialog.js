// StoreLah CMS admin UI — reusable themed confirm dialog.
// Replaces every native blocking confirm() with a promise-based modal that
// reuses the existing .modal-overlay/.modal-win v8 olive/cream/terra styles:
//
//   confirmDialog({ title, message, confirmLabel, cancelLabel, danger }) => Promise<boolean>
//
// `requireCheck: 'label…'` (additive, optional) adds an explicit acknowledgement
// checkbox to the dialog for destructive-but-allowed actions (e.g. publishing
// a floor plan with 0 units live): the confirm button stays disabled until
// the box is ticked, and Enter confirms only while it is ticked. The checkbox
// row is created at runtime (no dashboard.html change) and removed on close,
// so plain confirms render byte-identical to before.
//
// A single #confirmModal shell lives in dashboard.html and is re-populated
// per invocation. `danger: true` renders the confirm button with the
// existing destructive .act-btn.danger style (otherwise .act-btn.primary).
//
// Behaviour contract:
// - Overlay-click and the ✕ button cancel (resolve false) — the same
//   overlay-click-to-close convention the CRUD modals use in admin.js.
// - Escape cancels, Enter confirms. Both are handled on document in the
//   capture phase with stopImmediatePropagation so the entry's global Escape
//   handler does not also close the CRUD modal underneath.
// - Focus moves to the confirm button on open (keeps Enter-to-confirm
//   predictable) and returns to the invoker on close.
// - #confirmModal sits at z-index 300, above the CRUD modals (z-200), so a
//   confirm opened from inside another modal stays visible and interactive;
//   toasts stay below at z-100. The underlying modal is left open untouched.
// - A second call while one is pending resolves the earlier one false first
//   (confirms never stack).
// - If the shell is missing for any reason, resolve false (safe default:
//   the gated action is cancelled) rather than falling back to native UI.

let bound = false;
let pending = null;
let invoker = null;

function shell() {
  return {
    modal: document.getElementById('confirmModal'),
    title: document.getElementById('confirmTitle'),
    message: document.getElementById('confirmMessage'),
    ok: document.getElementById('confirmOk'),
    cancel: document.getElementById('confirmCancel'),
    close: document.getElementById('confirmClose'),
  };
}

function finish(value) {
  const { modal } = shell();
  if (modal) modal.hidden = true;
  removeCheckRow();
  const resolve = pending && pending.resolve;
  pending = null;
  if (resolve) resolve(value);
  if (invoker && document.contains(invoker)) {
    try {
      invoker.focus({ preventScroll: true });
    } catch (e) { /* noop */ }
  }
  invoker = null;
}

function halt(e) {
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
}

// Runtime acknowledgement-checkbox row for `requireCheck` (see confirmDialog).
// Created on open, removed on close (finish + supersede paths) — plain
// confirms never see it.
function checkRow() {
  return document.getElementById('confirmCheckRow');
}

function removeCheckRow() {
  const row = checkRow();
  if (row && row.parentNode) row.parentNode.removeChild(row);
}

function mountCheckRow(label) {
  removeCheckRow();
  const { modal, ok } = shell();
  if (!modal || !ok) return null;
  const row = document.createElement('label');
  row.id = 'confirmCheckRow';
  row.className = 'confirm-check-row';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'confirmCheckBox';
  const text = document.createElement('span');
  text.textContent = label;
  row.appendChild(box);
  row.appendChild(text);
  ok.parentNode.insertBefore(row, ok);
  box.addEventListener('change', () => {
    ok.disabled = !box.checked;
  });
  ok.disabled = true;
  return box;
}

function checkSatisfied() {
  const box = document.getElementById('confirmCheckBox');
  return !box || box.checked === true;
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const { modal, ok, cancel, close } = shell();
  if (!modal || !ok || !cancel) return;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) finish(false);
  });
  ok.addEventListener('click', () => {
    if (!checkSatisfied()) return;
    finish(true);
  });
  cancel.addEventListener('click', () => finish(false));
  if (close) close.addEventListener('click', () => finish(false));
  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('confirmModal');
    if (!m || m.hidden || !pending) return;
    if (e.key === 'Escape') {
      halt(e);
      finish(false);
    } else if (e.key === 'Enter') {
      if (!checkSatisfied()) {
        halt(e);
        return;
      }
      halt(e);
      finish(true);
    }
  }, true);
}

export function confirmDialog(opts) {
  const o = opts || {};
  const title = o.title != null ? String(o.title) : 'Are you sure?';
  const message = o.message != null ? String(o.message) : '';
  const confirmLabel = o.confirmLabel != null ? String(o.confirmLabel) : 'Confirm';
  const cancelLabel = o.cancelLabel != null ? String(o.cancelLabel) : 'Cancel';
  const danger = !!o.danger;
  const requireCheck = o.requireCheck != null && String(o.requireCheck).trim() ? String(o.requireCheck) : null;
  bindOnce();
  const { modal, title: t, message: m, ok, cancel } = shell();
  if (!modal || !t || !m || !ok || !cancel) return Promise.resolve(false);
  // Never stack: supersede any still-pending confirm (resolves it false).
  if (pending) {
    try {
      pending.resolve(false);
    } catch (e) { /* noop */ }
    pending = null;
  }
  removeCheckRow();
  ok.disabled = false;
  invoker = document.activeElement;
  // textContent (not innerHTML) so operator/tenant-supplied strings in
  // titles/messages can never inject markup.
  t.textContent = title;
  m.textContent = message;
  m.hidden = !message;
  ok.textContent = confirmLabel;
  cancel.textContent = cancelLabel;
  ok.classList.toggle('danger', danger);
  ok.classList.toggle('primary', !danger);
  modal.hidden = false;
  // With requireCheck the focus starts on the checkbox (never on Publish), so
  // a stray Enter can't confirm an empty plan unacknowledged.
  const focusEl = requireCheck ? mountCheckRow(requireCheck) || ok : ok;
  try {
    focusEl.focus({ preventScroll: true });
  } catch (e) {
    try {
      focusEl.focus();
    } catch (e2) { /* noop */ }
  }
  return new Promise((resolve) => {
    pending = { resolve };
  });
}
