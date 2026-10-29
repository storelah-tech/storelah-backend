// StoreLah CMS admin UI — Site builder (docs/SITE_BUILDER_PLAN.md Phase 3).
// Self-mounting into Content › Site builder (#site-builder). Two screens:
//   list   — pages with status / unpublished changes; new, duplicate,
//            archive; publish everything that changed
//   editor — section outline (add / reorder / duplicate / hide / delete) |
//            live preview iframe (landing /site-preview/, desktop / tablet /
//            mobile) | properties panel generated from the page JSON Schema
//   global settings — same editor in `settings` mode (S.mode): no outline,
//            the form edits the settings doc, the preview shows the live
//            homepage with the draft settings
// Drafts autosave (PUT /site/pages/:id/draft { doc, rev }); a 409 means
// someone else saved first. Undo / redo are in memory. Publish and rollback
// need `site-builder:approve`; the server re-checks every permission.
//
// Preview protocol (landing src/site-builder/PreviewClient.tsx):
//   → { type: 'storelah:preview:doc', slug, doc } / { type: '…:select', id }
//   ← ready / rendered / invalid { issues } / clicked { id }

import { $, escapeHtml, showBanner } from './dom.js';
import { get, post, put, patch, del, can, describeError, ApiError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { h, buildField, applyIssues, defaultFor, labelFor, short, summary, friendlyMessage } from './siteBuilderForm.js';
import { openMediaLibrary } from './siteBuilderMedia.js';

const TYPE_INFO = {
  heroCarousel: ['Hero carousel', 'Rotating full-width banners (homepage).'],
  pageHero: ['Page hero', 'Page title with breadcrumb, intro and optional image.'],
  split: ['Two columns', 'Text, image, card, blocks or a form side by side.'],
  featureCards: ['Feature cards', 'Numbered cards, info boxes or supply tiles.'],
  cardGrid: ['Image cards', 'Grid of image cards linking elsewhere.'],
  article: ['Article', 'Long-form copy: headings, paragraphs, lists.'],
  comparisonTable: ['Comparison table', 'Rows compared across columns.'],
  gallery: ['Gallery', 'One large image beside two stacked.'],
  faqSearch: ['FAQ (searchable)', 'Full FAQ list with search.'],
  faqTeaser: ['FAQ teaser', 'A few FAQs beside a link.'],
  locationFeature: ['Location feature', 'Location copy beside a photo card.'],
  calculatorTeaser: ['Calculator teaser', 'Promo for the size calculator.'],
  bookingJourney: ['Booking journey', 'Numbered steps beside the booking illustration.'],
  bookingFinder: ['Size finder', 'Size picker and short facts (homepage).'],
  sizeShowcase: ['Size cards', 'Unit size cards with buttons.'],
  sizeCalculator: ['Size calculator', 'The interactive size estimator.'],
  widget: ['Widget', 'Code-owned component (size filter, …).'],
  ctaBand: ['Call-to-action band', 'Terra band with booking buttons.'],
};
const typeLabel = (t) => (TYPE_INFO[t] ? TYPE_INFO[t][0] : labelFor(t));

// Rendered at true device width, then scaled to fit the preview column.
const DEVICES = { desktop: 1280, tablet: 768, mobile: 390 };
const AUTOSAVE_MS = 1500;

const S = {
  bound: false,
  mode: 'page', // 'page' | 'settings'
  settings: null, // GET /site/settings (draft + schema); null until imported
  homeDoc: null, // live homepage doc (settings preview)
  schema: null, // page JSON Schema
  sectionSchemas: {}, // type → schema node
  config: { previewUrl: null, rebuildConfigured: false },
  examples: {}, // type → a live section of that type (Add section templates)
  pages: [],
  page: null, // editor: page row (with draftRev)
  doc: null, // editor: working document
  selected: null, // section id, null = page settings
  undo: [],
  redo: [],
  lastChangeKey: '',
  lastChangeAt: 0,
  dirty: false,
  saving: false,
  saveTimer: 0,
  previewTimer: 0,
  previewReady: false,
  device: 'desktop',
  issues: [],
  issuesFrom: '', // 'preview' (instant) | 'server' (last save)
};

const canEdit = () => can('site-builder:update');
const canCreate = () => can('site-builder:create');
const canDelete = () => can('site-builder:delete');
const canPublish = () => can('site-builder:approve');

// ---------- styles (scoped to .sb-*) ----------

function ensureStyles() {
  if ($('#sbStyles')) return;
  const st = document.createElement('style');
  st.id = 'sbStyles';
  st.textContent = `
.sb-chip{display:inline-block;border-radius:99px;padding:2px 8px;font-size:10.5px;font-weight:700}
.sb-chip.live{background:var(--sage);color:#39503f}.sb-chip.draft{background:var(--amber-light);color:#8b6324}
.sb-chip.changed{background:var(--terra-light);color:var(--terra2)}.sb-chip.archived{background:#ece9e4;color:var(--muted)}
.sb-editor{display:grid;grid-template-columns:250px minmax(0,1fr) 360px;gap:12px;height:calc(100vh - 230px);min-height:520px}
.sb-editor.sb-settings{grid-template-columns:minmax(0,1fr) 420px}
.sb-pane{background:var(--paper);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:0}
.sb-pane-hdr{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line);font-weight:800;font-size:12px}
.sb-pane-body{overflow:auto;padding:10px 12px;flex:1;min-height:0}
.sb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.sb-toolbar .sb-title{font-weight:800;font-size:16px;margin-right:4px}
.sb-save{font-size:11px;color:var(--muted);font-weight:700}.sb-save.bad{color:var(--red)}
.sb-sec{display:flex;align-items:center;gap:6px;padding:7px 8px;border:1px solid var(--line);border-radius:9px;margin-bottom:6px;background:var(--white);cursor:pointer}
.sb-sec.sel{border-color:var(--terra);box-shadow:0 0 0 2px var(--terra-light)}
.sb-sec.hidden-sec{opacity:.55}.sb-sec.bad{border-color:var(--red)}
.sb-sec .sb-sec-txt{flex:1;min-width:0}.sb-sec .sb-sec-type{font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.sb-sec .sb-sec-sum{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-sec.drag-over{border-top:3px solid var(--terra)}
.sb-mini{border:1px solid var(--line);background:var(--white);border-radius:6px;font-size:11px;padding:2px 6px;cursor:pointer;line-height:1.3}
.sb-mini:hover{background:var(--cream)}.sb-mini.sel{background:var(--olive);border-color:var(--olive);color:#fff}.sb-mini.danger{color:var(--red)}.sb-mini[disabled]{opacity:.35;cursor:default}
.sb-preview-wrap{flex:1;overflow:hidden;background:#ebe6de;border-radius:0 0 12px 12px;position:relative}
.sb-preview-wrap iframe{border:0;background:#fff;position:absolute;top:0;transform-origin:0 0;box-shadow:0 0 0 1px var(--line)}
.sb-empty{padding:30px;text-align:center;color:var(--muted);font-size:12px}
.sb-field{display:flex;flex-direction:column;gap:3px;margin-bottom:9px}
.sb-field>label,.sb-group-hdr>span{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.sb-field input[type=text],.sb-field input[type=number],.sb-field select,.sb-field textarea,.sb-group-hdr select{border:1.5px solid var(--line);border-radius:7px;padding:6px 8px;font:600 12.5px Manrope,system-ui,sans-serif;color:var(--ink);background:var(--white);width:100%;box-sizing:border-box}
.sb-field textarea{resize:vertical;line-height:1.45}
.sb-field input:focus,.sb-field textarea:focus,.sb-field select:focus{border-color:var(--terra);outline:none}
.sb-check>label{display:flex;align-items:center;gap:6px;text-transform:none;font-size:12px;color:var(--ink);letter-spacing:0}
.sb-hint{font-size:10.5px;color:var(--muted)}
.sb-err{font-size:10.5px;color:var(--red);font-weight:700}.sb-err:empty{display:none}
.sb-bad>input,.sb-bad>textarea,.sb-bad>select{border-color:var(--red)!important}
.sb-group{border-left:2px solid var(--line);padding-left:9px;margin:4px 0 10px}
.sb-group-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.sb-group-hdr select{width:auto}
.sb-item{border:1px solid var(--line);border-radius:8px;padding:4px 8px;margin-bottom:6px;background:var(--white)}
.sb-item>summary{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;font-weight:700;padding:3px 0}
.sb-item>summary .sb-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-row{flex-direction:row;flex-wrap:wrap;align-items:flex-start;gap:6px}.sb-row>input,.sb-row>textarea{flex:1 1 0;min-width:0;order:-1}
.sb-row>.sb-hint{display:none}.sb-row>.sb-err{flex-basis:100%}
.sb-tools{display:inline-flex;gap:3px;flex:none}
.sb-add,.sb-add-opt{border:1.5px dashed var(--line);background:transparent;border-radius:8px;padding:5px 9px;font:700 11px Manrope,system-ui,sans-serif;color:var(--olive);cursor:pointer;margin:2px 6px 8px 0}
.sb-add:hover,.sb-add-opt:hover{border-color:var(--terra);color:var(--terra2)}
.sb-gallery{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow:auto}
.sb-gallery button{text-align:left;border:1.5px solid var(--line);background:var(--white);border-radius:10px;padding:10px;cursor:pointer;font-family:Manrope,system-ui,sans-serif}
.sb-gallery button:hover{border-color:var(--terra)}
.sb-gallery b{display:block;font-size:12.5px}.sb-gallery span{font-size:11px;color:var(--muted)}
.sb-issues{background:var(--red-light);color:#9e3f38;border-radius:8px;padding:7px 9px;font-size:11.5px;margin-bottom:8px}
.sb-vers td{vertical-align:top}
.sb-image{display:grid;grid-template-columns:84px minmax(0,1fr);gap:9px;align-items:start}
.sb-thumb{width:84px;height:64px;object-fit:cover;border-radius:7px;border:1px solid var(--line);background:var(--cream)}
.sb-thumb-empty{display:grid;place-items:center;font-size:10px;color:var(--muted)}
.sb-media-upload{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px;border:1.5px dashed var(--line);border-radius:10px;margin-bottom:10px}
.sb-media-upload>input[type=file]{grid-column:1/-1}
.sb-media-upload input[type=text],.sb-media-search,.sb-media-tile input{border:1.5px solid var(--line);border-radius:7px;padding:6px 8px;font:600 12px Manrope,system-ui,sans-serif;width:100%;box-sizing:border-box}
.sb-media-search{margin-bottom:10px}
.sb-media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-height:52vh;overflow:auto}
.sb-media-tile{border:1px solid var(--line);border-radius:10px;padding:6px;background:var(--white);display:flex;flex-direction:column;gap:5px}
.sb-media-tile img{width:100%;height:100px;object-fit:cover;border-radius:7px;background:var(--cream)}
.sb-media-tile.pickable img{cursor:pointer}.sb-media-tile.pickable:hover{border-color:var(--terra)}
`;
  document.head.appendChild(st);
}

// ---------- mount ----------

function host() {
  return $('#site-builder');
}

export async function bindSiteBuilder() {
  ensureStyles();
  const el = host();
  if (!el) return;
  if (!S.bound) {
    S.bound = true;
    window.addEventListener('message', onPreviewMessage);
    window.addEventListener('beforeunload', (e) => {
      if (S.dirty) e.preventDefault();
    });
    document.addEventListener('keydown', onKey);
  }
  if (!S.schema) {
    const [schema, config] = await Promise.all([get('/site/schema'), get('/site/config')]);
    S.schema = schema;
    S.config = config;
    for (const node of schema.properties.sections.items.oneOf) S.sectionSchemas[node.properties.type.const] = node;
    loadExamples();
  }
  await loadSettings();
  if (S.page) renderEditor();
  else await showList();
}

/** Settings draft (page previews render with it). 404 = site not imported yet. */
async function loadSettings() {
  try {
    S.settings = await get('/site/settings');
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    S.settings = null;
  }
}

/** Templates for "Add section": the first live section of each type. */
async function loadExamples() {
  try {
    const res = await fetch('/api/v1/public/site/bundle');
    const body = await res.json();
    for (const p of body.data.pages) {
      if (p.slug === '/') S.homeDoc = p.doc;
      for (const s of p.doc.sections) if (!S.examples[s.type]) S.examples[s.type] = s;
    }
  } catch (e) {
    /* fall back to schema defaults */
  }
}

// ---------- list screen ----------

function statusChip(p) {
  if (p.status === 'ARCHIVED') return '<span class="sb-chip archived">Archived</span>';
  if (!p.live) return '<span class="sb-chip draft">Never published</span>';
  return '<span class="sb-chip live">Live v' + p.live.number + '</span>' + (p.hasUnpublishedChanges ? ' <span class="sb-chip changed">Unpublished changes</span>' : '');
}

const pagePath = (slug) => (slug === '/' ? '/' : '/' + slug + '/');

async function showList() {
  S.page = null;
  S.doc = null;
  const el = host();
  el.innerHTML = '<div class="tbl-card"><div class="sb-empty">Loading pages…</div></div>';
  S.mode = 'page';
  [S.pages] = await Promise.all([get('/site/pages'), loadSettings()]);
  const settingsChanged = !!(S.settings && S.settings.hasUnpublishedChanges);
  const changed = S.pages.filter((p) => p.hasUnpublishedChanges);
  const changeCount = changed.length + (settingsChanged ? 1 : 0);
  el.innerHTML =
    '<div class="tbl-card">' +
    '<div class="sec-hdr"><div><div class="sec-title">Site pages</div>' +
    '<div class="sec-sub">storelah.sg pages. Edit a draft, preview it, then publish to rebuild the site' +
    (S.config.rebuildConfigured ? '' : ' (rebuild trigger not configured yet: publishing makes versions live in the API only)') +
    '.</div></div>' +
    '<div style="display:flex;gap:7px;">' +
    (canPublish() ? `<button class="tb-btn" id="sb-publish-all" data-perm="site-builder:approve" ${changeCount ? '' : 'disabled'}>Publish all changes (${changeCount})</button>` : '') +
    (S.settings ? `<button class="tb-btn" id="sb-settings">Global settings${settingsChanged ? ' •' : ''}</button>` : '') +
    '<button class="tb-btn" id="sb-history">Publish history</button>' +
    '<button class="tb-btn" id="sb-media">Media library</button>' +
    (canCreate() ? '<button class="tb-btn primary" id="sb-new" data-perm="site-builder:create">+ New page</button>' : '') +
    '</div></div>' +
    (S.pages.length
      ? '<table class="data-tbl"><thead><tr><th>Page</th><th>URL</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>' +
        S.pages
          .map(
            (p) =>
              `<tr data-id="${p.id}"><td><b>${escapeHtml(p.title)}</b>${p.system ? ' <span class="t-type">core</span>' : ''}</td>` +
              `<td><code>${escapeHtml(pagePath(p.slug))}</code></td><td>${statusChip(p)}</td>` +
              `<td class="t-type">${new Date(p.updatedAt).toLocaleString()}</td>` +
              '<td style="text-align:right;white-space:nowrap;">' +
              `<button class="act-btn" data-act="edit">${canEdit() ? 'Edit' : 'View'}</button> ` +
              (canCreate() ? '<button class="act-btn" data-act="dup" data-perm="site-builder:create">Duplicate</button> ' : '') +
              (canDelete() && !p.system ? '<button class="act-btn" data-act="archive" data-perm="site-builder:delete">Archive</button>' : '') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table>'
      : '<div class="sb-empty">No pages yet. An operator with backend access imports the current site with <code>pnpm db:site-import</code>.</div>') +
    '</div>';
  el.querySelector('#sb-new')?.addEventListener('click', () => openNewPage(null));
  el.querySelector('#sb-history')?.addEventListener('click', () => openHistory().catch(fail));
  el.querySelector('#sb-media')?.addEventListener('click', () => openMediaLibrary());
  el.querySelector('#sb-settings')?.addEventListener('click', () => openSettingsEditor().catch(fail));
  el.querySelector('#sb-publish-all')?.addEventListener('click', () => publish(null).catch(fail));
  el.querySelectorAll('tr[data-id] [data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = S.pages.find((x) => x.id === b.closest('tr').dataset.id);
      if (b.dataset.act === 'edit') openEditor(p.id).catch(fail);
      if (b.dataset.act === 'dup') openNewPage(p);
      if (b.dataset.act === 'archive') archive(p).catch(fail);
    }),
  );
}

function fail(err) {
  showBanner('Site builder: ' + describeError(err));
}

// ---------- modals ----------

function modal(title, body, actions) {
  // Below confirmDialog (z-index 200), which may open on top of this modal.
  const ov = h('div', { class: 'modal-overlay', style: 'z-index:190' });
  const close = () => ov.remove();
  ov.append(
    h('div', { class: 'modal-win', style: 'width:620px' },
      h('div', { class: 'modal-hdr' }, h('div', { class: 'modal-title', text: title }), h('button', { class: 'modal-x', type: 'button', text: '✕', onclick: close })),
      body,
      actions ? h('div', { class: 'modal-foot' }, actions(close)) : null),
  );
  ov.addEventListener('click', (e) => e.target === ov && close());
  document.body.append(ov);
  ov.hidden = false;
  ov.classList.add('open');
  return close;
}

function openNewPage(source) {
  const alert = h('div', { class: 'modal-alert', hidden: true });
  const title = h('input', { maxlength: 120, value: source ? source.title + ' (copy)' : '' });
  const slug = h('input', { maxlength: 120, placeholder: 'summer-offer  or  guides/storing-books', value: source ? source.slug.replace(/^\/$/, 'home') + '-copy' : '' });
  title.addEventListener('input', () => {
    if (!slug.dataset.touched) slug.value = title.value.toLowerCase().trim().replace(/[^a-z0-9/]+/g, '-').replace(/^-+|-+$/g, '');
  });
  slug.addEventListener('input', () => (slug.dataset.touched = '1'));
  const body = h('div', {}, alert,
    h('div', { class: 'form-grid' },
      h('div', { class: 'field full' }, h('label', { text: 'Page name' }), title),
      h('div', { class: 'field full' }, h('label', { text: 'URL (storelah.sg/…/)' }), slug)),
    h('div', { class: 'modal-hint', text: source ? 'Copies the current draft. The copy starts unpublished.' : 'Starts empty (unpublished). Add sections in the editor.' }));
  modal(source ? 'Duplicate page' : 'New page', body, (close) => [
    h('button', { class: 'tb-btn ghost', type: 'button', text: 'Cancel', onclick: close }),
    h('button', {
      class: 'tb-btn primary', type: 'button', text: source ? 'Duplicate' : 'Create',
      onclick: async () => {
        try {
          const input = { title: title.value.trim(), slug: slug.value.trim() };
          const p = source ? await post(`/site/pages/${source.id}/duplicate`, input) : await post('/site/pages', input);
          close();
          await openEditor(p.id);
        } catch (err) {
          alert.hidden = false;
          alert.textContent = describeError(err);
        }
      },
    }),
  ]);
  title.focus();
}

async function archive(p) {
  const ok = await confirmDialog({
    title: `Archive “${p.title}”?`,
    message: 'It disappears from storelah.sg at the next publish. Its version history is kept.',
    confirmLabel: 'Archive', danger: true,
  });
  if (!ok) return;
  await del(`/site/pages/${p.id}`);
  showBanner(`Archived ${p.title}.`, true);
  await showList();
}

async function openHistory() {
  const rows = await get('/site/publishes');
  const STATUS = { DISPATCHED: 'Site rebuild started', NOT_CONFIGURED: 'Live in API (no rebuild trigger)', SKIPPED: 'Imported (no rebuild)', FAILED: 'Rebuild trigger failed' };
  const body = h('div', { style: 'max-height:60vh;overflow:auto' });
  body.innerHTML = rows.length
    ? '<table class="data-tbl sb-vers"><thead><tr><th>When</th><th>Pages</th><th>Result</th></tr></thead><tbody>' +
      rows.map((r) => `<tr><td class="t-type">${new Date(r.createdAt).toLocaleString()}</td><td>${r.scope.map((s) => escapeHtml(pagePath(s.slug)) + ' v' + s.number).join(', ')}${r.note ? '<div class="t-type">' + escapeHtml(r.note) + '</div>' : ''}</td><td>${escapeHtml(STATUS[r.status] || r.status)}${r.error ? '<div class="t-type">' + escapeHtml(r.error) + '</div>' : ''}</td></tr>`).join('') +
      '</tbody></table>'
    : '<div class="sb-empty">Nothing published yet.</div>';
  modal('Publish history', body);
}

// ---------- editor ----------

async function openEditor(id) {
  const page = await get(`/site/pages/${id}`);
  S.mode = 'page';
  S.page = page;
  S.doc = JSON.parse(JSON.stringify(page.draft));
  S.selected = null;
  S.undo = [];
  S.redo = [];
  S.dirty = false;
  S.issues = [];
  S.previewReady = false;
  renderEditor();
}

async function openSettingsEditor() {
  const st = await get('/site/settings');
  S.settings = st;
  S.mode = 'settings';
  S.page = settingsPageRow(st);
  S.doc = JSON.parse(JSON.stringify(st.draft));
  S.selected = null;
  S.undo = [];
  S.redo = [];
  S.dirty = false;
  S.issues = [];
  S.previewReady = false;
  renderEditor();
}

/** Settings shown through the editor's page-shaped toolbar / status. */
function settingsPageRow(st) {
  return {
    id: 'settings', title: 'Global settings', slug: '/', system: true,
    status: st.live ? 'PUBLISHED' : 'DRAFT', draftRev: st.draftRev,
    live: st.live ? { number: st.live.version } : null, hasUnpublishedChanges: st.hasUnpublishedChanges,
  };
}

async function leaveEditor() {
  if (S.dirty) await saveNow();
  if (S.dirty) {
    const ok = await confirmDialog({ title: 'Leave with unsaved changes?', message: 'The last changes could not be saved.', confirmLabel: 'Leave anyway', danger: true });
    if (!ok) return;
  }
  S.dirty = false;
  await showList();
}

function renderEditor() {
  const el = host();
  const p = S.page;
  el.innerHTML = '';
  const readOnly = !canEdit() || p.status === 'ARCHIVED';
  el.append(
    h('div', { class: 'sb-toolbar' },
      h('button', { class: 'tb-btn', type: 'button', text: '← Pages', onclick: () => leaveEditor().catch(fail) }),
      h('span', { class: 'sb-title', text: p.title }),
      S.mode === 'settings' ? h('span', { class: 'sb-hint', text: 'Header, footer and shared copy on every page' }) : h('code', { text: pagePath(p.slug) }),
      h('span', { id: 'sb-status' }),
      h('span', { class: 'sb-save', id: 'sb-save' }),
      h('span', { style: 'flex:1' }),
      readOnly ? h('span', { class: 'sb-chip archived', text: 'Read only' }) : null,
      h('button', { class: 'tb-btn', type: 'button', id: 'sb-undo', text: '↶ Undo', title: 'Undo (Ctrl/Cmd+Z)', onclick: undo }),
      h('button', { class: 'tb-btn', type: 'button', id: 'sb-redo', text: '↷ Redo', title: 'Redo (Ctrl/Cmd+Shift+Z)', onclick: redo }),
      S.mode === 'page' ? h('button', { class: 'tb-btn', type: 'button', text: 'Versions', onclick: () => openVersions().catch(fail) }) : null,
      canPublish() && !readOnly ? h('button', { class: 'tb-btn primary', type: 'button', id: 'sb-publish', 'data-perm': 'site-builder:approve', text: 'Publish', onclick: () => publish(S.mode === 'settings' ? 'settings' : [p.id]).catch(fail) }) : null),
    h('div', { class: 'sb-editor' + (S.mode === 'settings' ? ' sb-settings' : '') },
      S.mode === 'settings' ? null : h('div', { class: 'sb-pane' },
        h('div', { class: 'sb-pane-hdr' }, h('span', { text: 'Sections', style: 'flex:1' }),
          readOnly ? null : h('button', { class: 'sb-mini', type: 'button', 'data-perm': 'site-builder:update', text: '+ Add', onclick: openAddSection })),
        h('div', { class: 'sb-pane-body', id: 'sb-outline' })),
      h('div', { class: 'sb-pane' },
        h('div', { class: 'sb-pane-hdr' }, h('span', { text: 'Preview', style: 'flex:1' }),
          ...Object.keys(DEVICES).map((d) => h('button', { class: 'sb-mini' + (S.device === d ? ' sel' : ''), type: 'button', text: labelFor(d), dataset: { device: d },
            onclick: () => { S.device = d; renderDevice(); } }))),
        h('div', { class: 'sb-preview-wrap', id: 'sb-preview' })),
      h('div', { class: 'sb-pane' },
        h('div', { class: 'sb-pane-hdr', id: 'sb-props-hdr' }),
        h('div', { class: 'sb-pane-body', id: 'sb-props' }))),
  );
  renderStatus();
  renderOutline();
  renderProps();
  renderPreviewFrame();
}

function renderStatus() {
  const st = $('#sb-status');
  if (st) st.innerHTML = statusChip({ ...S.page, hasUnpublishedChanges: S.page.live && (S.dirty || S.page.hasUnpublishedChanges) });
  const sv = $('#sb-save');
  if (sv) {
    sv.classList.toggle('bad', S.issues.length > 0);
    sv.textContent = S.saving ? 'Saving…' : S.issues.length ? `${S.issues.length} problem(s) — not saved` : S.dirty ? 'Unsaved changes' : 'All changes saved';
  }
  const u = $('#sb-undo');
  if (u) u.disabled = !S.undo.length;
  const r = $('#sb-redo');
  if (r) r.disabled = !S.redo.length;
}

// ----- outline -----

function sectionIssues(i) {
  return S.issues.filter((x) => x.path === `sections.${i}` || x.path.startsWith(`sections.${i}.`));
}

function renderOutline() {
  const box = $('#sb-outline');
  if (!box || S.mode !== 'page') return;
  box.innerHTML = '';
  const readOnly = !canEdit() || S.page.status === 'ARCHIVED';
  box.append(h('div', { class: 'sb-sec' + (S.selected === null ? ' sel' : ''), onclick: () => select(null) },
    h('div', { class: 'sb-sec-txt' }, h('div', { class: 'sb-sec-type', text: 'Page' }), h('div', { class: 'sb-sec-sum', text: 'Settings & SEO' }))));
  if (!S.doc.sections.length) box.append(h('div', { class: 'sb-empty', text: 'No sections yet. Use “+ Add”.' }));
  S.doc.sections.forEach((s, i) => {
    const hidden = s.style && s.style.show === 'hidden';
    const sum = short(summary(s.props) || summary(s.props && (s.props.slides || s.props.items || s.props.columns || [])[0]) || '', 34);
    const row = h('div', {
      class: 'sb-sec' + (S.selected === s.id ? ' sel' : '') + (hidden ? ' hidden-sec' : '') + (sectionIssues(i).length ? ' bad' : ''),
      draggable: readOnly ? null : 'true', dataset: { idx: String(i) },
      onclick: (e) => { if (!e.target.closest('button')) select(s.id); },
    },
      h('div', { class: 'sb-sec-txt' }, h('div', { class: 'sb-sec-type', text: typeLabel(s.type) + (hidden ? ' · hidden' : '') }), h('div', { class: 'sb-sec-sum', text: sum || s.id })),
      readOnly ? null : h('span', { class: 'sb-tools' },
        h('button', { class: 'sb-mini', type: 'button', title: 'Move up', text: '↑', disabled: i === 0 || null, onclick: () => moveSection(i, i - 1) }),
        h('button', { class: 'sb-mini', type: 'button', title: 'Move down', text: '↓', disabled: i === S.doc.sections.length - 1 || null, onclick: () => moveSection(i, i + 1) }),
        h('button', { class: 'sb-mini', type: 'button', title: hidden ? 'Show' : 'Hide', text: hidden ? '◌' : '●', onclick: () => toggleHidden(i) }),
        h('button', { class: 'sb-mini', type: 'button', title: 'Duplicate', text: '⧉', onclick: () => duplicateSection(i) }),
        h('button', { class: 'sb-mini danger', type: 'button', title: 'Delete', text: '✕', onclick: () => deleteSection(i).catch(fail) })),
    );
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isInteger(from) && from !== i) moveSection(from, from < i ? i - 1 : i);
    });
    box.append(row);
  });
}

function select(id) {
  S.selected = id;
  renderOutline();
  renderProps();
  if (id) postPreview({ type: 'storelah:preview:select', id });
}

function uniqueId(base) {
  const taken = new Set(S.doc.sections.map((s) => s.id));
  const stem = String(base).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 's';
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

function moveSection(from, to) {
  if (to < 0 || to >= S.doc.sections.length) return;
  change(() => {
    const [s] = S.doc.sections.splice(from, 1);
    S.doc.sections.splice(to, 0, s);
  }, true);
}

function toggleHidden(i) {
  change(() => {
    const s = S.doc.sections[i];
    s.style = { ...(s.style || {}), show: s.style && s.style.show === 'hidden' ? 'all' : 'hidden' };
  }, true);
}

function duplicateSection(i) {
  const copy = JSON.parse(JSON.stringify(S.doc.sections[i]));
  copy.id = uniqueId(copy.id);
  if (copy.style) delete copy.style.anchor; // anchors must stay unique on the page
  change(() => S.doc.sections.splice(i + 1, 0, copy), true);
  select(copy.id);
}

async function deleteSection(i) {
  const s = S.doc.sections[i];
  const ok = await confirmDialog({ title: `Delete “${typeLabel(s.type)}”?`, message: 'You can undo this until you leave the editor.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  change(() => S.doc.sections.splice(i, 1), true);
  if (S.selected === s.id) select(null);
}

function openAddSection() {
  const at = S.selected ? S.doc.sections.findIndex((s) => s.id === S.selected) + 1 : S.doc.sections.length;
  const grid = h('div', { class: 'sb-gallery' });
  let close = () => {};
  for (const type of Object.keys(S.sectionSchemas)) {
    const [label, desc] = TYPE_INFO[type] || [labelFor(type), ''];
    grid.append(h('button', { type: 'button', onclick: () => { close(); addSection(type, at); } },
      h('b', { text: label }), h('span', { text: desc + (S.examples[type] ? '' : ' (starts blank)') })));
  }
  close = modal('Add a section', h('div', {}, h('div', { class: 'modal-hint', text: 'New sections start with sample copy from the live site; edit it on the right.' }), grid));
}

function addSection(type, at) {
  const ex = S.examples[type];
  const s = ex ? JSON.parse(JSON.stringify(ex)) : defaultFor(S.sectionSchemas[type]);
  s.type = type;
  s.id = uniqueId(ex ? ex.id : type);
  if (s.style) delete s.style.anchor;
  change(() => S.doc.sections.splice(at, 0, s), true);
  select(s.id);
}

// ----- properties -----

function renderProps() {
  const hdr = $('#sb-props-hdr');
  const box = $('#sb-props');
  if (!hdr || !box) return;
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const readOnly = !canEdit() || S.page.status === 'ARCHIVED';
  const ctx = { set: setAt, siteOrigin: previewOrigin(), pickImage: readOnly ? null : () => openMediaLibrary({ pick: true }) };
  if (S.mode === 'settings') {
    hdr.textContent = 'Global settings';
    box.append(buildField(S.settings.schema, S.doc, [], null, ctx));
  } else if (S.selected === null) {
    hdr.textContent = 'Page settings';
    box.append(pageMetaFields(readOnly));
    const node = S.schema;
    box.append(buildField(node.properties.seo, S.doc.seo, ['seo'], labelFor('seo'), ctx));
    box.append(buildField(node.properties.nav, S.doc.nav, ['nav'], labelFor('nav'), ctx));
  } else {
    const i = S.doc.sections.findIndex((s) => s.id === S.selected);
    if (i < 0) return select(null);
    const s = S.doc.sections[i];
    const raw = S.sectionSchemas[s.type];
    // Content first, layout & style last (schema order is id, style, type, variant, props).
    const { style, variant, props } = raw.properties;
    const node = { ...raw, properties: { ...(variant ? { variant } : {}), props, style } };
    hdr.textContent = typeLabel(s.type);
    box.append(h('div', { class: 'sb-hint', style: 'margin-bottom:8px', text: (TYPE_INFO[s.type] || [, ''])[1] + ' · id: ' + s.id }));
    box.append(buildField(node, s, ['sections', i], null, ctx, { skip: new Set(['id', 'type']) }));
  }
  if (readOnly) box.querySelectorAll('input,textarea,select,button').forEach((x) => (x.disabled = true));
  // Adding/removing list items edits the draft: tag them so access.js never
  // hides them by label ("+ Add" / "Remove") for a role with update only.
  box.querySelectorAll('button').forEach((b) => b.setAttribute('data-perm', 'site-builder:update'));
  const unplaced = applyIssues(box, S.issues);
  const here = S.mode === 'settings' ? unplaced : S.selected === null ? unplaced.filter((x) => !x.path.startsWith('sections.')) : [];
  if (here.length) box.prepend(h('div', { class: 'sb-issues', text: here.map((x) => `${x.path}: ${friendlyMessage(x.message)}`).join(' · ') }));
  box.scrollTop = scroll;
}

function pageMetaFields(readOnly) {
  const p = S.page;
  const title = h('input', { type: 'text', maxlength: 120, value: p.title });
  const slug = h('input', { type: 'text', maxlength: 120, value: p.slug, disabled: p.system || readOnly || null });
  const save = async () => {
    const body = {};
    if (title.value.trim() && title.value.trim() !== p.title) body.title = title.value.trim();
    if (!p.system && slug.value.trim() && slug.value.trim() !== p.slug) body.slug = slug.value.trim();
    if (!Object.keys(body).length) return;
    try {
      const next = await patch(`/site/pages/${p.id}`, body);
      Object.assign(S.page, { title: next.title, slug: next.slug });
      renderEditor();
    } catch (err) {
      fail(err);
      title.value = p.title;
      slug.value = p.slug;
    }
  };
  title.addEventListener('change', save);
  slug.addEventListener('change', save);
  return h('div', { class: 'sb-group' },
    h('div', { class: 'sb-group-hdr' }, h('span', { text: 'Page' })),
    h('div', { class: 'sb-field' }, h('label', { text: 'Name in the CMS' }), title),
    h('div', { class: 'sb-field' }, h('label', { text: 'URL slug' }), slug,
      h('div', { class: 'sb-hint', text: p.system ? 'Core page: the URL is fixed.' : 'Changing the URL breaks old links to this page.' })));
}

// ---------- changes, undo / redo ----------

function getAt(path) {
  return path.reduce((o, k) => (o == null ? o : o[k]), S.doc);
}

function setAt(path, value, structural) {
  const key = path.join('.');
  change(() => {
    const parent = getAt(path.slice(0, -1));
    const last = path[path.length - 1];
    if (value === undefined) {
      if (Array.isArray(parent)) parent.splice(last, 1);
      else delete parent[last];
    } else parent[last] = value;
  }, structural, structural ? '' : key);
}

/**
 * Apply one edit. Typing in the same field within 1s is one undo step.
 * Structural edits re-render outline + properties; text edits don't.
 */
function change(fn, structural, coalesceKey = '') {
  const now = Date.now();
  const snapshot = JSON.stringify(S.doc);
  if (!(coalesceKey && coalesceKey === S.lastChangeKey && now - S.lastChangeAt < 1000)) {
    S.undo.push(snapshot);
    if (S.undo.length > 100) S.undo.shift();
  }
  S.lastChangeKey = coalesceKey;
  S.lastChangeAt = now;
  S.redo = [];
  fn();
  afterChange(structural);
}

function afterChange(structural) {
  S.dirty = true;
  if (structural) {
    renderOutline();
    renderProps();
  } else if (S.selected === null || /heading|title|q$|label/.test(S.lastChangeKey)) {
    renderOutline(); // keeps outline summaries current while typing
  }
  renderStatus();
  schedulePreview();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => saveNow().catch(fail), AUTOSAVE_MS);
}

function undo() {
  if (!S.undo.length) return;
  S.redo.push(JSON.stringify(S.doc));
  S.doc = JSON.parse(S.undo.pop());
  S.lastChangeKey = '';
  if (S.selected && !S.doc.sections.some((s) => s.id === S.selected)) S.selected = null;
  afterChange(true);
}

function redo() {
  if (!S.redo.length) return;
  S.undo.push(JSON.stringify(S.doc));
  S.doc = JSON.parse(S.redo.pop());
  S.lastChangeKey = '';
  afterChange(true);
}

function onKey(e) {
  if (!S.page || !host() || !host().offsetParent) return; // editor not visible
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // native field undo
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
}

// ---------- save ----------

async function saveNow() {
  clearTimeout(S.saveTimer);
  if (!S.dirty || S.saving || !S.page) return;
  S.saving = true;
  renderStatus();
  const sentDoc = JSON.stringify(S.doc);
  try {
    if (S.mode === 'settings') {
      const next = await put('/site/settings/draft', { doc: S.doc, rev: S.page.draftRev });
      S.settings = { ...S.settings, ...next };
      S.page = settingsPageRow(S.settings);
    } else {
      const next = await put(`/site/pages/${S.page.id}/draft`, { doc: S.doc, rev: S.page.draftRev });
      S.page = { ...S.page, ...next, draft: undefined };
    }
    S.issues = [];
    S.dirty = JSON.stringify(S.doc) !== sentDoc; // edits made while saving
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && Array.isArray(err.details)) {
      S.issues = err.details;
      S.issuesFrom = 'server';
    } else if (err instanceof ApiError && err.status === 409) {
      S.saving = false;
      const reload = await confirmDialog({
        title: S.mode === 'settings' ? 'Someone else changed the settings' : 'Someone else changed this page',
        message: 'Another session saved this draft after you opened it. Reload to see their version (your unsaved edits here are discarded), or cancel to keep editing without saving.',
        confirmLabel: 'Reload page', danger: true,
      });
      if (reload) return S.mode === 'settings' ? openSettingsEditor() : openEditor(S.page.id);
      return;
    } else {
      throw err;
    }
  } finally {
    S.saving = false;
  }
  renderStatus();
  renderOutline();
  if (S.issues.length) renderProps();
  else applyIssues($('#sb-props'), []);
  // Edits made while saving go out next; an invalid draft waits for the next edit.
  if (S.dirty && !S.issues.length) S.saveTimer = setTimeout(() => saveNow().catch(fail), AUTOSAVE_MS);
}

// ---------- preview ----------

function previewOrigin() {
  try {
    return new URL(S.config.previewUrl).origin;
  } catch (e) {
    return null;
  }
}

function renderPreviewFrame() {
  const wrap = $('#sb-preview');
  if (!wrap) return;
  if (!S.config.previewUrl) {
    wrap.innerHTML = '<div class="sb-empty">Live preview is not configured (backend env <code>LANDING_PREVIEW_ORIGIN</code>). Editing and publishing still work.</div>';
    return;
  }
  S.previewReady = false;
  const frame = h('iframe', { id: 'sb-frame', src: S.config.previewUrl, title: 'Page preview', referrerpolicy: 'no-referrer' });
  wrap.innerHTML = '';
  wrap.append(frame);
  renderDevice();
  if (!S.resizeObs && window.ResizeObserver) S.resizeObs = new ResizeObserver(() => renderDevice());
  S.resizeObs?.disconnect();
  S.resizeObs?.observe(wrap);
}

function renderDevice() {
  const f = $('#sb-frame');
  const wrap = $('#sb-preview');
  if (f && wrap) {
    const w = DEVICES[S.device];
    const scale = Math.min(1, wrap.clientWidth / w);
    f.style.width = w + 'px';
    f.style.height = Math.ceil(wrap.clientHeight / scale) + 'px';
    f.style.transform = `scale(${scale})`;
    f.style.left = Math.max(0, (wrap.clientWidth - w * scale) / 2) + 'px';
  }
  document.querySelectorAll('[data-device]').forEach((b) => b.classList.toggle('sel', b.dataset.device === S.device));
}

function postPreview(msg) {
  const f = $('#sb-frame');
  const origin = previewOrigin();
  if (f && f.contentWindow && origin && S.previewReady) f.contentWindow.postMessage(msg, origin);
}

/** Settings mode previews the live homepage with the draft settings. */
function previewMessage() {
  if (S.mode === 'settings') {
    return S.homeDoc ? { type: 'storelah:preview:doc', slug: '/', doc: S.homeDoc, settings: S.doc } : null;
  }
  const msg = { type: 'storelah:preview:doc', slug: S.page.slug, doc: S.doc };
  if (S.settings) msg.settings = S.settings.draft;
  return msg;
}

function schedulePreview() {
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(() => {
    const msg = previewMessage();
    if (msg) postPreview(msg);
  }, 250);
}

function onPreviewMessage(e) {
  const f = $('#sb-frame');
  if (!f || e.source !== f.contentWindow || e.origin !== previewOrigin()) return;
  const msg = e.data || {};
  if (msg.type === 'storelah:preview:ready') {
    S.previewReady = true;
    const first = previewMessage();
    if (first) postPreview(first);
  } else if (msg.type === 'storelah:preview:clicked' && typeof msg.id === 'string') {
    if (S.mode === 'page' && S.doc.sections.some((s) => s.id === msg.id)) select(msg.id);
  } else if (msg.type === 'storelah:preview:invalid' && Array.isArray(msg.issues)) {
    // Instant feedback before the autosave round trip (settings paths arrive as "settings.…").
    S.issues = S.mode === 'settings'
      ? msg.issues.filter((x) => x.path.startsWith('settings.')).map((x) => ({ ...x, path: x.path.slice('settings.'.length) }))
      : msg.issues.filter((x) => !x.path.startsWith('settings.'));
    S.issuesFrom = 'preview';
    renderStatus();
    renderOutline();
    applyIssues($('#sb-props'), S.issues);
  } else if (msg.type === 'storelah:preview:rendered') {
    if (S.issuesFrom !== 'preview' || !S.issues.length) return; // server issues clear on the next good save
    S.issues = [];
    renderStatus();
    renderOutline();
    applyIssues($('#sb-props'), []);
  }
}

// ---------- publish / versions ----------

/** scope: [pageId] (one page), 'settings' (global settings only) or null (everything changed). */
async function publish(scope) {
  if (S.page) {
    await saveNow();
    if (S.dirty || S.issues.length) {
      showBanner('Fix the highlighted problems before publishing.');
      return;
    }
  }
  let title;
  let list = '';
  if (scope === 'settings') title = 'Publish global settings?';
  else if (scope) title = `Publish “${S.page.title}”?`;
  else {
    const names = S.pages.filter((p) => p.hasUnpublishedChanges).map((p) => p.title);
    if (S.settings && S.settings.hasUnpublishedChanges) names.push('Global settings');
    title = `Publish ${names.length} change(s)?`;
    list = names.join(', ') + '. ';
  }
  const ok = await confirmDialog({
    title,
    message: list + (scope === 'settings' ? 'Header, footer and shared copy change on every page. ' : '') +
      (S.config.rebuildConfigured ? 'storelah.sg rebuilds in a few minutes.' : 'The rebuild trigger is not configured yet, so storelah.sg updates at its next deploy.'),
    confirmLabel: 'Publish',
  });
  if (!ok) return;
  const body = scope === 'settings' ? { pageIds: [], settings: true } : scope ? { pageIds: scope } : {};
  try {
    const res = await post('/site/publish', body);
    const msg = res.status === 'DISPATCHED' ? 'Published. storelah.sg is rebuilding.' : res.status === 'FAILED' ? 'Published, but the site rebuild did not start (' + (res.error || 'error') + ').' : 'Published.';
    showBanner(msg, res.status !== 'FAILED');
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && /Nothing to publish/.test(err.message)) {
      showBanner('Nothing to publish: already live.', true);
    } else throw err;
  }
  if (S.page && S.mode === 'settings') {
    await loadSettings();
    S.page = settingsPageRow(S.settings);
    renderStatus();
  } else if (S.page) {
    const fresh = await get(`/site/pages/${S.page.id}`);
    S.page = { ...fresh, draft: undefined };
    renderStatus();
  } else await showList();
}

async function openVersions() {
  const rows = await get(`/site/pages/${S.page.id}/versions`);
  const body = h('div', { style: 'max-height:60vh;overflow:auto' });
  if (!rows.length) {
    body.append(h('div', { class: 'sb-empty', text: 'Never published.' }));
  } else {
    const tbl = h('table', { class: 'data-tbl sb-vers' }, h('thead', {}, h('tr', {}, h('th', { text: 'Version' }), h('th', { text: 'Published' }), h('th', { text: 'Note' }), h('th', {}))));
    const tb = h('tbody');
    for (const v of rows) {
      const live = S.page.live && S.page.live.versionId === v.id;
      tb.append(h('tr', {},
        h('td', {}, h('b', { text: 'v' + v.number }), live ? h('span', { class: 'sb-chip live', style: 'margin-left:6px', text: 'Live' }) : null),
        h('td', { class: 't-type', text: new Date(v.createdAt).toLocaleString() }),
        h('td', { text: v.note || '' }),
        h('td', { style: 'text-align:right' },
          !live && canPublish() && S.page.status !== 'ARCHIVED'
            ? h('button', { class: 'act-btn', 'data-perm': 'site-builder:approve', type: 'button', text: 'Roll back', onclick: () => rollback(v).catch(fail) })
            : null)));
    }
    tbl.append(tb);
    body.append(tbl);
  }
  S.closeVersions = modal(`Versions · ${S.page.title}`, body);
}

async function rollback(v) {
  const ok = await confirmDialog({
    title: `Roll back to v${v.number}?`,
    message: 'Replaces the current draft with v' + v.number + ' and publishes it as a new version. Unpublished edits are lost.',
    confirmLabel: 'Roll back & publish', danger: true,
  });
  if (!ok) return;
  clearTimeout(S.saveTimer);
  const res = await post(`/site/pages/${S.page.id}/rollback/${v.id}`, {});
  if (S.closeVersions) S.closeVersions();
  showBanner(`Rolled back: v${res.scope[0].number} is live.`, true);
  await openEditor(S.page.id);
}
