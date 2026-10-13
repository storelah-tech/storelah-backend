// Floor-plan tracing underlay (precision Phase 5): CMS-only image stored in
// Postgres, served behind requireAuth, never in the public read.
import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { signToken } from '../../src/middleware/auth';
import { publishFloorPlan } from '../../src/core/floorPlans';
import { UNDERLAY_MAX_BYTES, setUnderlay } from '../../src/core/floorPlanUnderlay';
import { calibrateUnderlay, underlayFtToPx, underlayPxToFt } from '../../src/core/planGeometry';

// 1×1 PNG.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const auth = () => `Bearer ${signToken({ id: 'e2e-admin', email: 'e2e@test.local', name: 'E2E' })}`;

// A syntactically-PNG buffer of `size` bytes (header + padding) — enough for the sniff + size rules.
function pngOfSize(size: number): Buffer {
  const b = Buffer.alloc(size);
  PNG_1PX.copy(b, 0, 0, 8);
  return b;
}

describe('underlay calibration math (pure)', () => {
  it('round-trips px ↔ ft at any rotation', () => {
    const t = { ftPerPx: 0.0213, offsetX: 4.5, offsetY: -2, rotation: 33 };
    const back = underlayFtToPx(t, underlayPxToFt(t, [1234, 567]));
    expect(back[0]).toBeCloseTo(1234, 6);
    expect(back[1]).toBeCloseTo(567, 6);
  });

  it('two-point calibration hits the real distance and keeps point A fixed (within 0.1%)', () => {
    const t0 = { ftPerPx: 0.035, offsetX: 1, offsetY: 2, rotation: 90 };
    // The drawing has a 75 ft wall from image px (200,300) to (1700,300).
    const a = underlayPxToFt(t0, [200, 300]);
    const b = underlayPxToFt(t0, [1700, 300]);
    const t1 = calibrateUnderlay(t0, a, b, 75);
    expect(t1.ftPerPx).toBeCloseTo(0.05, 10);
    const a1 = underlayPxToFt(t1, [200, 300]);
    expect(a1[0]).toBeCloseTo(a[0], 9);
    expect(a1[1]).toBeCloseTo(a[1], 9);
    // A second, independent dimension on the same drawing: 600 px → 30 ft.
    const p = underlayPxToFt(t1, [200, 900]);
    const d = Math.hypot(p[0] - a1[0], p[1] - a1[1]);
    expect(Math.abs(d - 30) / 30).toBeLessThan(0.001);
  });
});

describe('floor-plan underlay', () => {
  let world: MoveInWorld;
  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('uploads over HTTP (≈600 KB body), reads back meta + image, and stays out of the public read', async () => {
    const big = pngOfSize(450_000); // base64 ≈ 600 KB — above express.json()'s 100 KB default
    const up = await api
      .post(`/api/v1/cms/floor-plans/${world.floorId}/underlay`)
      .set('Authorization', auth())
      .send({ name: 'Architect L1', contentType: 'image/png', dataBase64: big.toString('base64'), widthPx: 3500, heightPx: 4000 });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ name: 'Architect L1', widthPx: 3500, heightPx: 4000, widthFt: 70, offsetX: 0, opacity: 0.5 });

    const img = await api.get(`/api/v1/cms/floor-plans/${world.floorId}/underlay/image`).set('Authorization', auth());
    expect(img.status).toBe(200);
    expect(Buffer.from(img.body.data.dataBase64, 'base64').equals(big)).toBe(true);

    const cms = await api.get(`/api/v1/cms/floor-plans/${world.floorId}`).set('Authorization', auth());
    expect(cms.body.data.underlay).toMatchObject({ name: 'Architect L1' });

    await publishFloorPlan(world.floorId);
    const pub = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('underlay');
    expect(JSON.stringify(pub.body)).not.toContain('Architect');

    const anon = await api.get(`/api/v1/cms/floor-plans/${world.floorId}/underlay/image`);
    expect(anon.status).toBe(401);
  });

  it('calibrates, validates and deletes', async () => {
    await setUnderlay(world.floorId, { contentType: 'image/png', bytes: PNG_1PX, widthPx: 1000, heightPx: 800 });
    const put = await api
      .put(`/api/v1/cms/floor-plans/${world.floorId}/underlay`)
      .set('Authorization', auth())
      .send({ ftPerPx: 0.05, offsetX: 2.5, offsetY: -1, rotation: -90, opacity: 0.3, locked: true });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ ftPerPx: 0.05, widthFt: 50, heightFt: 40, rotation: 270, opacity: 0.3, locked: true });

    await expect(setUnderlay(world.floorId, { contentType: 'image/jpeg', bytes: PNG_1PX, widthPx: 1, heightPx: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(setUnderlay(world.floorId, { contentType: 'application/pdf', bytes: PNG_1PX, widthPx: 1, heightPx: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(setUnderlay(world.floorId, { contentType: 'image/png', bytes: pngOfSize(UNDERLAY_MAX_BYTES + 1), widthPx: 1, heightPx: 1 })).rejects.toMatchObject({ status: 400 });

    const del = await api.delete(`/api/v1/cms/floor-plans/${world.floorId}/underlay`).set('Authorization', auth());
    expect(del.status).toBe(200);
    expect(await prisma.floorPlanUnderlay.count()).toBe(0);
  });

});
