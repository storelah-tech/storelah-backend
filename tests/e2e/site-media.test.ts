// Site-builder media library: byte sniffing (type + real size), variant
// rules, local storage with absolute URLs, search, alt edits, delete guarded
// by page usage, permissions.
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, type Operator } from './fixtures';
import { sniffImage } from '../../src/core/siteMedia';
import { pageDocSchema } from '../../src/core/sitePageSchema';

const CMS = '/api/v1/cms';

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real, decodable w×h grey PNG. */
function png(w: number, h: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = (b: Buffer) => b.toString('base64');

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-media-'));
  process.env.CONTENT_LOCAL_DIR = dir;
});
afterAll(() => {
  delete process.env.CONTENT_LOCAL_DIR;
});

describe('sniffImage', () => {
  it('reads PNG, JPEG and WebP sizes from the bytes', () => {
    expect(sniffImage(png(30, 20))).toEqual({ mime: 'image/png', width: 30, height: 20 });
    // JPEG: SOI, APP0 (len 16), SOF0 with height 480 / width 640.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 640, height: 480 });
    // WebP VP8X: canvas 1200×800 stored as (w-1, h-1) 24-bit little endian.
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(1199, 24, 3);
    webp.writeUIntLE(799, 27, 3);
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', width: 1200, height: 800 });
    expect(sniffImage(Buffer.from('GIF89a not accepted'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('media library API', () => {
  let owner: Operator;
  beforeEach(async () => {
    await resetDb();
    owner = await createOperator('OWNER');
  });

  const upload = (body: object, who = owner) => api.post(`${CMS}/site/media`).set('Authorization', who.auth).send(body);

  it('stores ascending variants with absolute URLs and real sizes, and lists / searches them', async () => {
    const res = await upload({ filename: 'Unit Door', alt: 'Sage storage doors', tags: ['Doors', 'doors'], variants: [{ dataBase64: b64(png(60, 40)) }, { dataBase64: b64(png(120, 80)) }] });
    expect(res.status).toBe(201);
    const a = res.body.data;
    expect(a).toMatchObject({ width: 120, height: 80, alt: 'Sage storage doors', tags: ['doors'] });
    expect(a.variants.map((v: { width: number }) => v.width)).toEqual([60, 120]);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/uploads\/content\//);
    expect(a.url).toBe(a.variants[1].url); // largest ≤ 1200
    expect(JSON.stringify(a)).not.toContain('"key"'); // storage keys stay server-side
    expect(readdirSync(dir)).toHaveLength(2);
    // The URL is valid in a page document.
    expect(pageDocSchema.safeParse({ seo: { title: 'T' }, sections: [{ id: 'g', type: 'gallery', props: { images: [1, 2, 3].map(() => ({ src: a.url, alt: 'x' })) } }] }).success).toBe(true);

    await upload({ filename: 'other', alt: 'Moving boxes', variants: [{ dataBase64: b64(png(10, 10)) }] });
    const all = await api.get(`${CMS}/site/media`).set('Authorization', owner.auth);
    expect(all.body.data.map((x: { alt: string }) => x.alt)).toEqual(['Moving boxes', 'Sage storage doors']);
    const found = await api.get(`${CMS}/site/media?q=door`).set('Authorization', owner.auth);
    expect(found.body.data).toHaveLength(1);
    const byTag = await api.get(`${CMS}/site/media?tag=doors`).set('Authorization', owner.auth);
    expect(byTag.body.data).toHaveLength(1);
  });

  it('rejects non-images, missing alt, unordered widths and mixed aspect ratios', async () => {
    const two = (a: Buffer, b: Buffer) => [{ dataBase64: b64(a) }, { dataBase64: b64(b) }];
    expect((await upload({ filename: 'x', alt: 'x', variants: [{ dataBase64: b64(Buffer.from('<svg/>')) }] })).status).toBe(400);
    expect((await upload({ filename: 'x', alt: '', variants: [{ dataBase64: b64(png(4, 4)) }] })).status).toBe(400);
    expect((await upload({ filename: 'x', alt: 'x', variants: two(png(40, 40), png(20, 20)) })).body.error.message).toMatch(/smallest first/);
    expect((await upload({ filename: 'x', alt: 'x', variants: two(png(20, 20), png(40, 10)) })).body.error.message).toMatch(/aspect ratio/);
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('edits alt text, and refuses to delete an image a page still uses', async () => {
    const a = (await upload({ filename: 'hero', alt: 'Hero', variants: [{ dataBase64: b64(png(20, 10)) }] })).body.data;
    const edited = await api.patch(`${CMS}/site/media/${a.id}`).set('Authorization', owner.auth).send({ alt: 'Hero photo' });
    expect(edited.body.data.alt).toBe('Hero photo');

    const doc = { seo: { title: 'T' }, sections: [{ id: 'h', type: 'pageHero', props: { crumb: 'A', heading: 'H', image: { src: a.url, alt: 'Hero photo' } } }] };
    const page = await api.post(`${CMS}/site/pages`).set('Authorization', owner.auth).send({ slug: 'with-image', title: 'With image', doc });
    expect(page.status).toBe(201);
    const blocked = await api.delete(`${CMS}/site/media/${a.id}`).set('Authorization', owner.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.pages).toEqual([{ slug: 'with-image', title: 'With image' }]);

    await api.put(`${CMS}/site/pages/${page.body.data.id}/draft`).set('Authorization', owner.auth)
      .send({ doc: { ...doc, sections: [{ ...doc.sections[0], props: { crumb: 'A', heading: 'H' } }] }, rev: 0 });
    const gone = await api.delete(`${CMS}/site/media/${a.id}`).set('Authorization', owner.auth);
    expect(gone.status).toBe(200);
    expect(readdirSync(dir).some((f) => a.variants[0].url.endsWith(f))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('Viewer browses but cannot upload, edit or delete', async () => {
    const viewer = await createOperator('VIEWER');
    const a = (await upload({ filename: 'v', alt: 'V', variants: [{ dataBase64: b64(png(8, 8)) }] })).body.data;
    expect((await api.get(`${CMS}/site/media`).set('Authorization', viewer.auth)).status).toBe(200);
    expect((await upload({ filename: 'v', alt: 'V', variants: [{ dataBase64: b64(png(8, 8)) }] }, viewer)).status).toBe(403);
    expect((await api.patch(`${CMS}/site/media/${a.id}`).set('Authorization', viewer.auth).send({ alt: 'x' })).status).toBe(403);
    expect((await api.delete(`${CMS}/site/media/${a.id}`).set('Authorization', viewer.auth)).status).toBe(403);
  });
});
