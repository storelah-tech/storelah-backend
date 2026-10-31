// StoreLah CMS admin UI — site builder: forms generated from the page JSON
// Schema (GET /cms/site/schema, emitted from src/core/sitePageSchema.ts).
// Handles exactly the shapes that schema produces: objects, strings, enums,
// booleans, numbers, const unions (heading level 2|3), discriminated unions
// (`kind` / `type` const), arrays and fixed tuples (`prefixItems`).
//
// The form never owns state: every edit calls ctx.set(path, value, structural)
// and the view re-renders the panel only for structural edits (add / remove /
// reorder / kind switch), so typing keeps focus. Field wrappers carry
// data-path="sections.2.props.heading" so server / preview validation issues
// land on the right field (applyIssues).

const LABELS = {
  ctas: 'Buttons', cta: 'Button', href: 'Link', src: 'Image URL', alt: 'Alt text', bg: 'Background',
  show: 'Visibility', n: 'Number', q: 'Question', a: 'Answer', cat: 'Category', crumb: 'Breadcrumb label',
  aside: 'Side note', headLink: 'Heading link', seo: 'Search & sharing', noindex: 'Hide from search engines',
  nav: 'Navigation', current: 'Highlight menu item (path)', props: 'Content', style: 'Layout & style',
  anchor: 'Anchor id (for #links)', key: 'Slide id', paragraphs: 'Paragraphs', list: 'Checklist',
  blocks: 'Content blocks', items: 'Items', cells: 'Cells', parents: 'Parent breadcrumbs',
};

const RICH_HINT = 'Supports **bold**, *italic*, [link text](/page/) and line breaks.';

export function labelFor(key) {
  if (LABELS[key]) return LABELS[key];
  const s = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** The discriminator of a union of objects (`kind` or `type` const), if any. */
function unionKey(options) {
  for (const k of ['kind', 'type']) {
    if (options.every((o) => o && o.properties && o.properties[k] && o.properties[k].const !== undefined)) return k;
  }
  return null;
}

function constUnion(node) {
  const opts = node.anyOf || node.oneOf;
  return opts && opts.every((o) => o.const !== undefined) ? opts.map((o) => o.const) : null;
}

/** Minimal value for a schema node (new list items, added optionals, kind switches). */
export function defaultFor(node) {
  if (!node) return undefined;
  if (node.default !== undefined) return JSON.parse(JSON.stringify(node.default));
  if (node.const !== undefined) return node.const;
  const consts = constUnion(node);
  if (consts) return consts[0];
  const opts = node.oneOf || node.anyOf;
  if (opts) return defaultFor(opts[0]);
  if (node.enum) return node.enum[0];
  switch (node.type) {
    case 'object': {
      const out = {};
      for (const k of node.required || []) out[k] = defaultFor(node.properties[k]);
      return out;
    }
    case 'array':
      if (node.prefixItems) return node.prefixItems.map(defaultFor);
      return Array.from({ length: node.minItems || 0 }, () => defaultFor(node.items));
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return node.minimum ?? 0;
    default:
      return '';
  }
}

/** Pick the union branch for a value. */
function branchFor(options, key, value) {
  return options.find((o) => value && o.properties[key].const === value[key]) || options[0];
}

// ---------- tiny DOM helper ----------

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function fieldWrap(path, label, control, hint) {
  return h(
    'div',
    { class: 'sb-field', dataset: { path: path.join('.') } },
    label ? h('label', { text: label }) : null,
    control,
    hint ? h('div', { class: 'sb-hint', text: hint }) : null,
    h('div', { class: 'sb-err' }),
  );
}

function summary(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  for (const k of ['title', 'heading', 'q', 'label', 'text', 'eyebrow', 'alt']) {
    if (typeof value[k] === 'string' && value[k]) return value[k];
  }
  if (value.kind) return labelFor(value.kind);
  return '';
}

const short = (s, n = 48) => {
  const t = String(s).replace(/\s+/g, ' ').replace(/\*\*|\*/g, '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ---------- field builders ----------

/**
 * Render `value` (at `path`) against `node`. `label` null = no label row.
 * ctx = { set(path, value, structural), skip?: Set<string> (top-level keys to hide) }
 */
export function buildField(node, value, path, label, ctx, opts = {}) {
  const consts = constUnion(node);
  if (consts) {
    const sel = h('select', { onchange: (e) => ctx.set(path, consts[e.target.selectedIndex], false) },
      consts.map((c) => h('option', { text: String(c) })));
    sel.selectedIndex = Math.max(0, consts.indexOf(value ?? node.default));
    return fieldWrap(path, label, sel);
  }

  const options = node.oneOf || node.anyOf;
  if (options) {
    const key = unionKey(options);
    if (!key) return fieldWrap(path, label, h('div', { class: 'sb-hint', text: 'Not editable here.' }));
    const branch = branchFor(options, key, value);
    const sel = h('select', {
      class: 'sb-kind',
      onchange: (e) => ctx.set(path, defaultFor(options[e.target.selectedIndex]), true),
    }, options.map((o) => h('option', { text: labelFor(o.properties[key].const) })));
    sel.selectedIndex = options.indexOf(branch);
    const body = buildObject(branch, value || {}, path, ctx, new Set([key]));
    return h('div', { class: 'sb-group', dataset: { path: path.join('.') } },
      h('div', { class: 'sb-group-hdr' }, h('span', { text: label || 'Type' }), sel),
      h('div', { class: 'sb-err' }), body);
  }

  if (node.enum) {
    const sel = h('select', { onchange: (e) => ctx.set(path, e.target.value, false) },
      node.enum.map((v) => h('option', { value: v, text: labelFor(v) })));
    sel.value = value ?? node.default ?? node.enum[0];
    return fieldWrap(path, label, sel);
  }

  switch (node.type) {
    case 'object': {
      if (isImageNode(node)) return buildImage(node, value || {}, path, label, ctx, opts);
      const body = buildObject(node, value || {}, path, ctx, opts.skip);
      if (!label) return body;
      return h('div', { class: 'sb-group', dataset: { path: path.join('.') } },
        h('div', { class: 'sb-group-hdr' }, h('span', { text: label }),
          opts.removable ? h('button', { class: 'sb-mini', type: 'button', title: 'Remove', text: 'Remove', onclick: () => ctx.set(path, undefined, true) }) : null),
        h('div', { class: 'sb-err' }), body);
    }
    case 'array':
      return node.prefixItems ? buildTuple(node, value || [], path, label, ctx) : buildArray(node, value || [], path, label, ctx);
    case 'boolean': {
      const cb = h('input', { type: 'checkbox', onchange: (e) => ctx.set(path, e.target.checked, false) });
      cb.checked = !!(value ?? node.default);
      return h('div', { class: 'sb-field sb-check', dataset: { path: path.join('.') } },
        h('label', {}, cb, ' ', label || ''), h('div', { class: 'sb-err' }));
    }
    case 'number':
    case 'integer': {
      const inp = h('input', { type: 'number', value: value ?? '', oninput: (e) => ctx.set(path, e.target.value === '' ? undefined : Number(e.target.value), false) });
      return fieldWrap(path, label, inp);
    }
    default: {
      // string
      const lastKey = String(path[path.length - 1]);
      const plain = /^(src|href|alt|current|anchor|code|key|label|crumb|eyebrow|cat|n|placeholder|searchLabel)$/.test(lastKey);
      // Rich text keeps "\n" line breaks, which an <input> would silently drop.
      const multi = (typeof value === 'string' && value.includes('\n')) || (!plain && (node.maxLength || 0) >= 150);
      const long = (node.maxLength || 0) >= 300;
      const isHref = /(^|\.)href$/.test(path.join('.')) || path[path.length - 1] === 'current';
      const optional = opts.optional;
      const onInput = (e) => {
        const v = e.target.value;
        ctx.set(path, optional && v === '' ? undefined : v, false);
      };
      const lines = (value || '').split('\n').length;
      const ctl = multi
        ? h('textarea', { rows: String(Math.min(8, Math.max(long ? 3 : 2, lines, Math.ceil((value || '').length / 60)))), maxlength: node.maxLength, oninput: onInput })
        : h('input', { type: 'text', maxlength: node.maxLength, placeholder: isHref ? '/page/  ·  https://…  ·  mailto:…' : null, oninput: onInput });
      ctl.value = value ?? '';
      return fieldWrap(path, label, ctl, multi ? RICH_HINT : null);
    }
  }
}

/** An image object ({ src, alt, frame? }) gets a thumbnail + library picker. */
function isImageNode(node) {
  const p = node.properties || {};
  return !!(p.src && p.alt && p.src.type === 'string');
}

function buildImage(node, value, path, label, ctx, opts) {
  // "/assets/x.webp" is a landing-site path: resolve it against the landing
  // origin (ctx.siteOrigin), never the CMS host.
  const isSitePath = typeof value.src === 'string' && value.src.startsWith('/');
  const src = isSitePath ? (ctx.siteOrigin ? ctx.siteOrigin + value.src : null) : value.src;
  const thumb = src
    ? h('img', { class: 'sb-thumb', src, alt: value.alt || '' })
    : h('div', { class: 'sb-thumb sb-thumb-empty', text: value.src ? 'Site image' : 'No image' });
  const pick = ctx.pickImage
    ? h('button', { class: 'sb-mini', type: 'button', text: value.src ? 'Replace…' : 'Choose…', onclick: async () => {
        const asset = await ctx.pickImage();
        if (asset) ctx.set(path, { ...value, src: asset.url, alt: asset.alt }, true);
      } })
    : null;
  return h('div', { class: 'sb-group', dataset: { path: path.join('.') } },
    h('div', { class: 'sb-group-hdr' }, h('span', { text: label || 'Image' }),
      h('span', { class: 'sb-tools' }, pick,
        opts.removable ? h('button', { class: 'sb-mini', type: 'button', text: 'Remove', onclick: () => ctx.set(path, undefined, true) }) : null)),
    h('div', { class: 'sb-err' }),
    h('div', { class: 'sb-image' }, thumb, buildObject(node, value, path, ctx)));
}

function buildObject(node, value, path, ctx, skip) {
  const box = h('div', { class: 'sb-obj' });
  const required = new Set(node.required || []);
  for (const [k, child] of Object.entries(node.properties || {})) {
    if (skip && skip.has(k)) continue;
    const p = [...path, k];
    const v = value[k];
    const isOptional = !required.has(k) && child.default === undefined;
    const isObj = child.type === 'object' || (child.oneOf && unionKey(child.oneOf));
    if (isOptional && isObj && v === undefined) {
      box.append(h('button', { class: 'sb-add-opt', type: 'button', text: '+ ' + labelFor(k), onclick: () => ctx.set(p, defaultFor(child), true) }));
      continue;
    }
    box.append(buildField(child, v, p, labelFor(k), ctx, { optional: isOptional, removable: isOptional && isObj }));
  }
  return box;
}

function buildArray(node, value, path, label, ctx) {
  const max = node.maxItems ?? Infinity;
  const min = node.minItems ?? 0;
  const list = h('div', { class: 'sb-list' });
  const replace = (arr) => ctx.set(path, arr, true);
  value.forEach((item, i) => {
    const p = [...path, i];
    const tools = h('span', { class: 'sb-tools' },
      h('button', { class: 'sb-mini', type: 'button', title: 'Move up', text: '↑', disabled: i === 0 || null,
        onclick: () => { const a = value.slice(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; replace(a); } }),
      h('button', { class: 'sb-mini', type: 'button', title: 'Move down', text: '↓', disabled: i === value.length - 1 || null,
        onclick: () => { const a = value.slice(); [a[i + 1], a[i]] = [a[i], a[i + 1]]; replace(a); } }),
      h('button', { class: 'sb-mini', type: 'button', title: 'Duplicate', text: '⧉', disabled: value.length >= max || null,
        onclick: () => { const a = value.slice(); a.splice(i + 1, 0, JSON.parse(JSON.stringify(item))); replace(a); } }),
      h('button', { class: 'sb-mini danger', type: 'button', title: 'Remove', text: '✕', disabled: value.length <= min || null,
        onclick: () => { const a = value.slice(); a.splice(i, 1); replace(a); } }));
    const simple = node.items.type === 'string';
    if (simple) {
      const f = buildField(node.items, item, p, null, ctx);
      f.classList.add('sb-row');
      f.prepend(tools);
      list.append(f);
    } else {
      const det = h('details', { class: 'sb-item', open: value.length <= 3 || null },
        h('summary', {}, h('span', { class: 'sb-item-title', text: `${i + 1}. ${short(summary(item)) || 'Item'}` }), tools),
        buildField(node.items, item, p, null, ctx));
      list.append(det);
    }
  });
  const add = h('button', { class: 'sb-add', type: 'button', text: '+ Add', disabled: value.length >= max || null,
    onclick: () => replace([...value, value.length ? JSON.parse(JSON.stringify(value[value.length - 1])) : defaultFor(node.items)]) });
  return h('div', { class: 'sb-group', dataset: { path: path.join('.') } },
    h('div', { class: 'sb-group-hdr' }, h('span', { text: `${label || 'Items'} (${value.length})` })),
    h('div', { class: 'sb-err' }), list, add);
}

function buildTuple(node, value, path, label, ctx) {
  const box = h('div', { class: 'sb-obj' });
  node.prefixItems.forEach((child, i) => {
    box.append(buildField(child, value[i], [...path, i], `${labelFor(path[path.length - 1]).replace(/s$/, '')} ${i + 1}`, ctx));
  });
  return h('div', { class: 'sb-group', dataset: { path: path.join('.') } },
    h('div', { class: 'sb-group-hdr' }, h('span', { text: label || '' })), h('div', { class: 'sb-err' }), box);
}

/** Validator wording → operator wording (custom schema messages pass through). */
export function friendlyMessage(m) {
  const msg = String(m || '');
  let x;
  if (/expected string to have >=1 characters|expected (object|string|array), received undefined/.test(msg)) return 'Required';
  if ((x = msg.match(/expected string to have <=(\d+) characters/))) return `Keep it under ${x[1]} characters`;
  if ((x = msg.match(/expected array to have >=(\d+) items/))) return `Add at least ${x[1]}`;
  if ((x = msg.match(/expected array to have <=(\d+) items/))) return `At most ${x[1]} allowed`;
  if (/must match pattern/.test(msg)) return 'Invalid format';
  if (/^Invalid option/.test(msg)) return 'Pick one of the listed options';
  return msg;
}

/** Show validation issues ({ path, message }) on the closest rendered field. */
export function applyIssues(root, issues, prefix = '') {
  root.querySelectorAll('.sb-err').forEach((e) => (e.textContent = ''));
  root.querySelectorAll('.sb-bad').forEach((e) => e.classList.remove('sb-bad'));
  const unplaced = [];
  for (const is of issues || []) {
    if (prefix && !is.path.startsWith(prefix)) continue;
    let p = is.path;
    let el = null;
    while (p && !(el = root.querySelector(`[data-path="${CSS.escape(p)}"]`))) p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
    if (!el) { unplaced.push(is); continue; }
    el.classList.add('sb-bad');
    const err = el.querySelector(':scope > .sb-err');
    if (err) err.textContent = (err.textContent ? err.textContent + ' · ' : '') + friendlyMessage(is.message);
  }
  return unplaced;
}

export { short, summary };
