// StoreLah CMS admin UI — site-builder media library (images for pages).
// GET/POST /site/media, PATCH/DELETE /site/media/:id. The browser resizes:
// each upload becomes ≤ 3 webp variants (600 / 1200 / 2400 px wide, never
// upscaled) sent smallest first; the server re-checks type and real size.
// openMediaLibrary({ pick: true }) resolves with the chosen asset (or null);
// without `pick` it is the manage view (alt text, tags, delete).

import { get, post, patch, del, can, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { h } from './siteBuilderForm.js';

const TARGET_WIDTHS = [600, 1200, 2400];
const WEBP_QUALITY = 0.82;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** File → [{ width, height, blob }] ascending (webp; the original size caps the largest). */
export async function makeVariants(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const widths = [...new Set(TARGET_WIDTHS.map((w) => Math.min(w, bitmap.width)))];
    const out = [];
    for (const width of widths) {
      const height = Math.round((bitmap.height * width) / bitmap.width);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', WEBP_QUALITY));
      if (!blob) throw new Error('This browser cannot encode WebP images');
      out.push({ width, height, blob });
    }
    return out;
  } finally {
    bitmap.close();
  }
}

/** Opens the library. Resolves with an asset when `pick` and one is chosen, else null. */
export function openMediaLibrary({ pick = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      ov.remove();
      resolve(v);
    };
    const alert = h('div', { class: 'modal-alert', hidden: true });
    const showErr = (msg) => {
      alert.hidden = !msg;
      alert.textContent = msg || '';
    };
    const search = h('input', { type: 'search', placeholder: 'Search alt text or file name', class: 'sb-media-search' });
    const grid = h('div', { class: 'sb-media-grid' });

    // --- upload row ---
    const file = h('input', { type: 'file', accept: ACCEPT });
    const alt = h('input', { type: 'text', maxlength: 200, placeholder: 'Alt text (describe the image) — required' });
    const tags = h('input', { type: 'text', maxlength: 200, placeholder: 'Tags, comma separated (optional)' });
    const status = h('span', { class: 'sb-hint' });
    const uploadBtn = h('button', { class: 'tb-btn primary', type: 'button', text: 'Upload', 'data-perm': 'site-builder:create' });
    uploadBtn.addEventListener('click', async () => {
      showErr('');
      const f = file.files && file.files[0];
      if (!f) return showErr('Choose an image file first.');
      if (!alt.value.trim()) return showErr('Alt text is required: say what the image shows.');
      uploadBtn.disabled = true;
      try {
        status.textContent = 'Resizing…';
        const variants = await makeVariants(f);
        status.textContent = `Uploading ${variants.map((v) => v.width + 'px').join(' / ')} (${kb(variants.reduce((n, v) => n + v.blob.size, 0))})…`;
        const asset = await post('/site/media', {
          filename: f.name.replace(/\.[a-z0-9]+$/i, ''),
          alt: alt.value.trim(),
          tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
          variants: await Promise.all(variants.map(async (v) => ({ dataBase64: await blobToBase64(v.blob) }))),
        });
        file.value = '';
        alt.value = '';
        tags.value = '';
        status.textContent = 'Uploaded.';
        if (pick) return finish(asset);
        await load();
      } catch (err) {
        status.textContent = '';
        showErr(describeError(err));
      } finally {
        uploadBtn.disabled = false;
      }
    });
    const upload = can('site-builder:create')
      ? h('div', { class: 'sb-media-upload' }, file, alt, tags, h('div', { style: 'display:flex;gap:8px;align-items:center' }, uploadBtn, status))
      : null;

    // --- grid ---
    async function load() {
      grid.innerHTML = '<div class="sb-empty">Loading…</div>';
      let rows;
      try {
        rows = await get('/site/media' + (search.value.trim() ? '?q=' + encodeURIComponent(search.value.trim()) : ''));
      } catch (err) {
        grid.innerHTML = '';
        return showErr(describeError(err));
      }
      grid.innerHTML = '';
      if (!rows.length) grid.append(h('div', { class: 'sb-empty', text: search.value ? 'No images match.' : 'No images yet. Upload the first one above.' }));
      for (const a of rows) grid.append(tile(a));
    }

    function tile(a) {
      const thumb = a.variants[0];
      const altInput = h('input', { type: 'text', maxlength: 200, value: a.alt, title: 'Alt text', disabled: !can('site-builder:update') || null });
      altInput.addEventListener('change', async () => {
        try {
          await patch(`/site/media/${a.id}`, { alt: altInput.value.trim() });
          a.alt = altInput.value.trim();
        } catch (err) {
          altInput.value = a.alt;
          showErr(describeError(err));
        }
      });
      const remove = can('site-builder:delete')
        ? h('button', { class: 'sb-mini danger', type: 'button', text: 'Delete', 'data-perm': 'site-builder:delete', onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog({ title: 'Delete this image?', message: a.alt, confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            try {
              await del(`/site/media/${a.id}`);
              await load();
            } catch (err) {
              showErr(describeError(err));
            }
          } })
        : null;
      const card = h('div', { class: 'sb-media-tile' + (pick ? ' pickable' : '') },
        h('img', { src: thumb.url, alt: a.alt, loading: 'lazy' }),
        h('div', { class: 'sb-hint', text: `${a.width}×${a.height} · ${a.variants.length} size${a.variants.length > 1 ? 's' : ''}` }),
        altInput,
        h('div', { style: 'display:flex;gap:4px;justify-content:flex-end' },
          pick ? h('button', { class: 'sb-mini', type: 'button', text: 'Use', onclick: () => finish(a) }) : null, remove));
      if (pick) card.querySelector('img').addEventListener('click', () => finish(a));
      return card;
    }

    let t = 0;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(load, 250);
    });

    // Below confirmDialog (z-index 200), which opens on top for deletes.
    const ov = h('div', { class: 'modal-overlay', style: 'z-index:195' },
      h('div', { class: 'modal-win', style: 'width:900px' },
        h('div', { class: 'modal-hdr' }, h('div', { class: 'modal-title', text: pick ? 'Choose an image' : 'Media library' }),
          h('button', { class: 'modal-x', type: 'button', text: '✕', onclick: () => finish(null) })),
        alert, upload, search, grid));
    ov.addEventListener('click', (e) => e.target === ov && finish(null));
    document.body.append(ov);
    load();
  });
}
