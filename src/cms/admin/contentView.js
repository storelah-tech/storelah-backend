// StoreLah CMS admin UI — Content Management (landing images + texts).
// Mini-WordPress for the landing site: GET/POST/PUT/DELETE /content,
// POST/DELETE /content/:key/image (JSON { filename, contentType, dataBase64 }).
// Self-mounting: one card inside the Content page (#content-list), reusing
// the frozen v8 theme classes (.tbl-card, .data-tbl, .tb-btn, .act-btn, .sw,
// .modal-overlay/.modal-win) plus the shared confirmDialog — same pattern
// as extrasView.js.
//
// Row actions mirror the contract: Edit (modal), Publish/Unpublish (PUT
// published toggle — drafts stay hidden from the public API), Delete (hard
// delete w/ confirm; the stored S3/local image is removed best-effort
// server-side). Image upload shows a preview and supports replace + remove.

import { $, escapeHtml, showBanner } from './dom.js';
import { get, post, put, del, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';

const TYPES = ['HERO_IMAGE', 'TESTIMONIAL', 'TEXT', 'IMAGE'];

const TYPE_LABEL = {
  HERO_IMAGE: 'Hero image',
  TESTIMONIAL: 'Testimonial',
  TEXT: 'Text',
  IMAGE: 'Image',
};

let lastRows = [];
let filterType = '';
let filterPublished = '';

// ---------- section mount (new DOM only — never touches existing markup) ----------

function ensureSection() {
  const host = $('#content-list');
  if (!host) return null;
  let el = $('#contentCard');
  if (!el || el.parentElement !== host) {
    if (el) el.remove();
    el = document.createElement('div');
    el.className = 'tbl-card';
    el.id = 'contentCard';
    el.innerHTML =
      '<div class="sec-hdr"><div><div class="sec-title">Content items</div>' +
      '<div class="sec-sub">Drafts stay hidden from the landing site until published · type is immutable (delete + recreate to retype)</div></div>' +
      '<div style="display:flex;gap:7px;"><button class="tb-btn primary" id="ct-add">+ Add content</button></div></div>' +
      '<div class="tbl-toolbar" style="margin-bottom:10px;">' +
      '<select id="ct-filter-type" class="tbl-select"><option value="">All types</option>' +
      TYPES.map((t) => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('') +
      '</select>' +
      '<select id="ct-filter-pub" class="tbl-select"><option value="">Published + drafts</option>' +
      '<option value="1">Published only</option><option value="0">Drafts only</option></select>' +
      '</div>' +
      '<table class="data-tbl"><thead><tr><th>Item</th><th>Type</th><th>Copy / image</th><th>Order</th><th>Published</th><th></th></tr></thead>' +
      '<tbody id="ctBody"></tbody></table>';
    host.appendChild(el);
    const typeSel = $('#ct-filter-type');
    const pubSel = $('#ct-filter-pub');
    if (typeSel) {
      typeSel.value = filterType;
      typeSel.addEventListener('change', () => {
        filterType = typeSel.value;
        bindContentSection().catch(() => {});
      });
    }
    if (pubSel) {
      pubSel.value = filterPublished;
      pubSel.addEventListener('change', () => {
        filterPublished = pubSel.value;
        bindContentSection().catch(() => {});
      });
    }
  }
  return el;
}

// ---------- list ----------

function thumb(url, alt) {
  return url
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}" loading="lazy" style="width:56px;height:38px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px;" onerror="this.remove()">`
    : '';
}

function summaryCell(r) {
  if (r.type === 'TESTIMONIAL') {
    const quote = r.body ? `“${escapeHtml(r.body)}”` : '<span class="t-type">— no quote —</span>';
    const byline = r.author ? `<div class="t-type">${escapeHtml(r.author)}${r.role ? ' · ' + escapeHtml(r.role) : ''}</div>` : '';
    return `<div>${quote}</div>${byline}`;
  }
  const title = r.title ? `<b>${escapeHtml(r.title)}</b>` : '';
  const body = r.body ? `<div class="t-type">${escapeHtml(r.body.length > 140 ? r.body.slice(0, 140) + '…' : r.body)}</div>` : '';
  const img = r.imageUrl ? `<div style="margin-top:4px;">${thumb(r.imageUrl, r.alt)}<span class="t-type">${escapeHtml(r.alt || 'image')}</span></div>` : '';
  if (!title && !body && !img) return '<span class="t-type">—</span>';
  return `${title}${body}${img}`;
}

function contentRow(r) {
  return (
    `<tr><td><b>${escapeHtml(r.title || r.key)}</b><div class="t-type">${escapeHtml(r.key)}</div></td>` +
    `<td><span class="pill">${escapeHtml(TYPE_LABEL[r.type] || r.type)}</span></td>` +
    `<td>${summaryCell(r)}</td>` +
    `<td>${escapeHtml(String(r.sortOrder))}</td>` +
    `<td><span class="sw${r.published ? ' on' : ''}" data-ct-toggle="${escapeHtml(r.key)}" role="switch" tabindex="0"><i></i></span></td>` +
    `<td class="unit-actions"><button class="act-btn" data-ct-edit="${escapeHtml(r.key)}">Edit</button> ` +
    `<button class="act-btn" data-ct-toggle="${escapeHtml(r.key)}">${r.published ? 'Unpublish' : 'Publish'}</button> ` +
    `<button class="act-btn danger" data-ct-del="${escapeHtml(r.key)}">Delete</button></td></tr>`
  );
}

export async function bindContentSection() {
  if (!ensureSection()) return;
  const body = $('#ctBody');
  try {
    const qs = [];
    if (filterType) qs.push('type=' + encodeURIComponent(filterType));
    if (filterPublished !== '') qs.push('published=' + encodeURIComponent(filterPublished));
    const rows = (await get('/content' + (qs.length ? '?' + qs.join('&') : ''))) || [];
    lastRows = rows;
    if (body) {
      body.innerHTML = rows.length
        ? rows.map(contentRow).join('')
        : '<tr><td colspan="6"><div class="section-empty">No content items. Add the first hero banner, testimonial or text block.</div></td></tr>';
    }
  } catch (e) {
    lastRows = [];
    if (body) body.innerHTML = '<tr><td colspan="6"><div class="section-empty">Content failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

// ---------- create/edit modal (dynamic overlay, themed) ----------

function closeContentModal() {
  const ov = $('#ctModal');
  if (ov) ov.hidden = true;
}

function syncModalFields() {
  const type = $('#ct-type')?.value || 'TEXT';
  const isTestimonial = type === 'TESTIMONIAL';
  const isImage = type === 'HERO_IMAGE' || type === 'IMAGE';
  const authorWrap = $('#ct-author-wrap');
  const roleWrap = $('#ct-role-wrap');
  const imageWrap = $('#ct-image-wrap');
  const bodyLabel = $('#ct-body-label');
  if (authorWrap) authorWrap.style.display = isTestimonial ? '' : 'none';
  if (roleWrap) roleWrap.style.display = isTestimonial ? '' : 'none';
  if (imageWrap) imageWrap.style.display = isImage ? '' : 'none';
  if (bodyLabel) bodyLabel.textContent = isTestimonial ? 'Quote (required)' : 'Body / copy';
  const hint = $('#ctModalHint');
  if (hint) {
    hint.textContent = isTestimonial
      ? 'Testimonials need a quote + author. Role is the context line (e.g. “Stored with Woodlands · 12 months”).'
      : isImage
        ? 'Upload an image below (png / jpeg / webp / gif, max 8 MB). Replacing removes the previous file automatically.'
        : 'Landing copy block. Publish to make it visible to the landing build.';
  }
}

function setPreview(url) {
  const img = $('#ct-preview');
  const empty = $('#ct-preview-empty');
  if (img) {
    if (url) {
      img.src = url;
      img.hidden = false;
      if (empty) empty.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      if (empty) empty.hidden = false;
    }
  }
  const rm = $('#ct-image-remove');
  if (rm) rm.hidden = !url;
}

function openContentModal(row) {
  const editing = !!row;
  let ov = $('#ctModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = 'ctModal';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="modal-win"><div class="modal-hdr"><div class="modal-title" id="ctModalTitle"></div>' +
      '<button class="modal-x" id="ctModalClose" type="button">✕</button></div>' +
      '<div class="modal-alert" id="ctModalAlert" hidden></div>' +
      '<div class="modal-hint" id="ctModalHint"></div>' +
      '<form id="ctForm" novalidate><div class="form-grid">' +
      '<div class="field"><label for="ct-key">Key (slug, immutable)</label><input id="ct-key" maxlength="80" placeholder="hero-banner-1"><div class="field-err" id="ct-e-key"></div></div>' +
      '<div class="field"><label for="ct-type">Type (immutable)</label><select id="ct-type">' +
      TYPES.map((t) => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('') +
      '</select><div class="field-err" id="ct-e-type"></div></div>' +
      '<div class="field full"><label for="ct-title">Title</label><input id="ct-title" maxlength="200"><div class="field-err" id="ct-e-title"></div></div>' +
      '<div class="field full"><label for="ct-body" id="ct-body-label">Body / copy</label><textarea id="ct-body" rows="4" maxlength="5000" style="width:100%;"></textarea><div class="field-err" id="ct-e-body"></div></div>' +
      '<div class="field" id="ct-author-wrap"><label for="ct-author">Author (testimonial)</label><input id="ct-author" maxlength="120"><div class="field-err" id="ct-e-author"></div></div>' +
      '<div class="field" id="ct-role-wrap"><label for="ct-role">Role / context</label><input id="ct-role" maxlength="200" placeholder="Stored with Woodlands · 12 months"><div class="field-err" id="ct-e-role"></div></div>' +
      '<div class="field"><label for="ct-sort">Sort order</label><input id="ct-sort" type="number" min="0" step="1"><div class="field-err" id="ct-e-sort"></div></div>' +
      '<div class="field"><label for="ct-pub">Published (visible to landing)</label><select id="ct-pub"><option value="no">No — draft</option><option value="yes">Yes — published</option></select></div>' +
      '<div class="field full" id="ct-alt-wrap"><label for="ct-alt">Alt text (images)</label><input id="ct-alt" maxlength="200"><div class="field-err" id="ct-e-alt"></div></div>' +
      '<div class="field full" id="ct-image-wrap"><label>Image</label>' +
      '<div style="display:flex;gap:10px;align-items:flex-start;"><div>' +
      '<img id="ct-preview" alt="" hidden style="width:160px;height:100px;object-fit:cover;border-radius:8px;border:1px solid var(--line);">' +
      '<div id="ct-preview-empty" class="t-type">No image yet.</div></div>' +
      '<div style="display:flex;flex-direction:column;gap:7px;">' +
      '<input id="ct-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">' +
      '<div style="display:flex;gap:7px;"><button class="tb-btn primary" id="ct-upload" type="button">Upload image</button>' +
      '<button class="tb-btn ghost" id="ct-image-remove" type="button" hidden>Remove image</button></div>' +
      '<div class="t-type">png / jpeg / webp / gif · max 8 MB · replacing removes the previous file</div>' +
      '</div></div></div>' +
      '</div></form>' +
      '<div class="modal-foot"><button class="tb-btn ghost" id="ctModalCancel" type="button">Cancel</button>' +
      '<button class="tb-btn primary" id="ctModalSave" type="button">Save</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeContentModal();
    });
    $('#ctModalClose').addEventListener('click', closeContentModal);
    $('#ctModalCancel').addEventListener('click', closeContentModal);
    $('#ctModalSave').addEventListener('click', () => submitContentModal().catch(() => {}));
    $('#ct-type').addEventListener('change', syncModalFields);
    $('#ct-upload').addEventListener('click', () => uploadModalImage().catch(() => {}));
    $('#ct-image-remove').addEventListener('click', () => removeModalImage().catch(() => {}));
  }
  ov.dataset.editKey = editing ? row.key : '';
  $('#ctModalTitle').textContent = editing ? `Edit content · ${row.key}` : 'Add content';
  const keyInput = $('#ct-key');
  keyInput.value = editing ? row.key : '';
  keyInput.disabled = editing;
  const typeSel = $('#ct-type');
  typeSel.value = editing ? row.type : 'TEXT';
  typeSel.disabled = editing;
  $('#ct-title').value = editing ? (row.title || '') : '';
  $('#ct-body').value = editing ? (row.body || '') : '';
  $('#ct-author').value = editing ? (row.author || '') : '';
  $('#ct-role').value = editing ? (row.role || '') : '';
  $('#ct-alt').value = editing ? (row.alt || '') : '';
  $('#ct-sort').value = editing ? String(row.sortOrder ?? 0) : '0';
  $('#ct-pub').value = editing && row.published ? 'yes' : 'no';
  const fileInput = $('#ct-file');
  if (fileInput) fileInput.value = '';
  setPreview(editing ? row.imageUrl || '' : '');
  const alert = $('#ctModalAlert');
  alert.hidden = true;
  alert.textContent = '';
  syncModalFields();
  ov.hidden = false;
}

function modalFail(msg) {
  const alert = $('#ctModalAlert');
  if (alert) {
    alert.textContent = msg;
    alert.hidden = false;
  } else {
    showBanner(msg);
  }
}

async function submitContentModal() {
  const ov = $('#ctModal');
  if (!ov) return;
  const editKey = ov.dataset.editKey || '';
  const type = $('#ct-type')?.value || 'TEXT';
  const key = $('#ct-key')?.value.trim() || '';
  const title = $('#ct-title')?.value.trim() || '';
  const body = $('#ct-body')?.value.trim() || '';
  const author = $('#ct-author')?.value.trim() || '';
  const role = $('#ct-role')?.value.trim() || '';
  const alt = $('#ct-alt')?.value.trim() || '';
  const sortRaw = $('#ct-sort')?.value.trim() || '';
  const published = $('#ct-pub')?.value === 'yes';
  if (!editKey && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
    modalFail('Key must be a URL-safe slug (lowercase, numbers, hyphens — e.g. "hero-banner-1").');
    return;
  }
  if (type === 'TESTIMONIAL' && !body) {
    modalFail('Testimonials require a quote.');
    return;
  }
  if (type === 'TESTIMONIAL' && !author) {
    modalFail('Testimonials require an author.');
    return;
  }
  const payload = {
    title: title || null,
    body: body || null,
    author: author || null,
    role: role || null,
    alt: alt || null,
    published,
  };
  if (sortRaw !== '') {
    const n = Math.max(0, Math.floor(Number(sortRaw)));
    if (!Number.isFinite(n)) {
      modalFail('Sort order must be a number 0 or greater.');
      return;
    }
    payload.sortOrder = n;
  }
  try {
    if (editKey) {
      const updated = await put(`/content/${encodeURIComponent(editKey)}`, payload);
      const i = lastRows.findIndex((r) => r.key === editKey);
      if (i >= 0) lastRows[i] = updated;
      showBanner(`Content ${editKey} saved`, true);
    } else {
      await post('/content', { key, type, ...payload });
      showBanner(`Content ${key} created`, true);
    }
    closeContentModal();
    await bindContentSection();
  } catch (e) {
    modalFail(describeError(e));
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function uploadModalImage() {
  const ov = $('#ctModal');
  const editKey = ov?.dataset.editKey || '';
  if (!editKey) {
    modalFail('Save the item first — images upload onto an existing item.');
    return;
  }
  const input = $('#ct-file');
  const file = input && input.files && input.files[0];
  if (!file) {
    modalFail('Choose an image file first.');
    return;
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    modalFail('Unsupported image type. Allowed: png, jpeg, webp, gif.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    modalFail('Image too large (max 8 MB).');
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) throw new Error('Could not read the selected file.');
    const updated = await post(`/content/${encodeURIComponent(editKey)}/image`, {
      filename: file.name,
      contentType: file.type,
      dataBase64: base64,
    });
    const i = lastRows.findIndex((r) => r.key === editKey);
    if (i >= 0) lastRows[i] = updated;
    setPreview(updated.imageUrl || '');
    showBanner(`Image uploaded (${updated.storage === 's3' ? 'S3' : 'local storage'})`, true);
    await bindContentSection();
  } catch (e) {
    modalFail(describeError(e));
  }
}

async function removeModalImage() {
  const ov = $('#ctModal');
  const editKey = ov?.dataset.editKey || '';
  if (!editKey) return;
  const okConfirm = await confirmDialog({
    title: 'Remove image?',
    message: 'The stored file is deleted and the item keeps its text. This cannot be undone.',
    confirmLabel: 'Remove image',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    const updated = await del(`/content/${encodeURIComponent(editKey)}/image`);
    const i = lastRows.findIndex((r) => r.key === editKey);
    if (i >= 0) lastRows[i] = updated;
    setPreview('');
    showBanner('Image removed', true);
    await bindContentSection();
  } catch (e) {
    modalFail(describeError(e));
  }
}

// ---------- row actions ----------

async function togglePublished(key) {
  try {
    const rows = (await get('/content')) || [];
    const row = rows.find((r) => r.key === key);
    if (!row) {
      showBanner(`Content ${key} not found`);
      return;
    }
    await put(`/content/${encodeURIComponent(key)}`, { published: !row.published });
    showBanner(`${key} ${row.published ? 'unpublished (hidden from landing)' : 'published (visible to landing)'}`, true);
    await bindContentSection();
  } catch (e) {
    showBanner(describeError(e));
  }
}

async function deleteRow(key) {
  const okConfirm = await confirmDialog({
    title: `Delete content ${key}?`,
    message: 'Hard delete is permanent — the item and its stored image are removed. Unpublish instead to hide it from the landing site.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    await del(`/content/${encodeURIComponent(key)}`);
    showBanner(`Content ${key} deleted`, true);
    await bindContentSection();
  } catch (e) {
    showBanner(describeError(e));
  }
}

function editRow(key) {
  const row = lastRows.find((r) => r.key === key);
  if (!row) {
    showBanner(`Content ${key} not found — reload the list.`);
    return;
  }
  openContentModal(row);
}

let contentWired = false;
export function wireContent() {
  if (contentWired) return;
  contentWired = true;
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('#ct-add')) {
      if (!ensureSection()) return;
      openContentModal(null);
      return;
    }
    const edit = t.closest('[data-ct-edit]');
    if (edit) {
      editRow(edit.dataset.ctEdit);
      return;
    }
    const toggle = t.closest('[data-ct-toggle]');
    if (toggle) {
      togglePublished(toggle.dataset.ctToggle).catch(() => {});
      return;
    }
    const delBtn = t.closest('[data-ct-del]');
    if (delBtn) deleteRow(delBtn.dataset.ctDel).catch(() => {});
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ov = $('#ctModal');
    if (ov && !ov.hidden) closeContentModal();
  });
}
