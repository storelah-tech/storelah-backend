// Landing content image storage — S3 with graceful local fallback.
//
// Mode is env-driven (see docs/CONTENT_MANAGEMENT.md):
//   CONTENT_S3_BUCKET          — when set (non-empty), images go to S3.
//   CONTENT_S3_REGION          — default "ap-southeast-1".
//   CONTENT_S3_PUBLIC_BASE_URL — default "https://<bucket>.s3.<region>.amazonaws.com".
//   CONTENT_S3_PREFIX          — optional key prefix, default "content".
//   CONTENT_LOCAL_DIR          — local-fallback dir, default "<cwd>/uploads/content".
//   CONTENT_IMAGE_MAX_BYTES    — default 8 MiB.
//
// When CONTENT_S3_BUCKET is absent the module NEVER throws a "not
// configured" error — it stores the file locally and serves it from
// /uploads (mounted in src/app.ts). Auth always uses the default AWS
// credential chain (Lambda execution role in prod, explicit env keys for
// local dev); no credentials are ever hardcoded or read from custom vars.
//
// S3 deletes are best-effort (a missing object or a bucket-policy denial
// must never fail the content DELETE/replace); failures are logged and
// swallowed. The single upload path is a direct server-side PutObject via
// @aws-sdk/client-s3 (no presigned round-trip, no extra upload dep).
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { AppError } from './http';

export const CONTENT_IMAGE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const DEFAULT_REGION = 'ap-southeast-1';

function envName(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

export function contentStorageStatus():
  | { mode: 's3'; bucket: string; region: string; publicBaseUrl: string; prefix: string }
  | { mode: 'local'; localDir: string } {
  const bucket = envName('CONTENT_S3_BUCKET');
  if (bucket) {
    const region = envName('CONTENT_S3_REGION') ?? DEFAULT_REGION;
    const publicBaseUrl = envName('CONTENT_S3_PUBLIC_BASE_URL') ?? `https://${bucket}.s3.${region}.amazonaws.com`;
    const prefix = envName('CONTENT_S3_PREFIX') ?? 'content';
    return { mode: 's3', bucket, region, publicBaseUrl, prefix };
  }
  const localDir = envName('CONTENT_LOCAL_DIR') ?? path.join(process.cwd(), 'uploads', 'content');
  return { mode: 'local', localDir };
}

let s3Client: S3Client | null = null;

function getS3Client(region: string): S3Client {
  if (!s3Client) s3Client = new S3Client({ region });
  return s3Client;
}

export function maxImageBytes(): number {
  const raw = Number(envName('CONTENT_IMAGE_MAX_BYTES') ?? 8 * 1024 * 1024);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8 * 1024 * 1024;
}

/** Assert a decoded upload is an allowed image; returns the normalised extension. */
export function assertImageUpload(contentType: string | undefined, size: number): string {
  const ct = (contentType ?? '').toLowerCase();
  if (!(CONTENT_IMAGE_MIME_ALLOWLIST as readonly string[]).includes(ct)) {
    throw new AppError(
      400,
      'VALIDATION',
      `Unsupported image type "${contentType}". Allowed: ${CONTENT_IMAGE_MIME_ALLOWLIST.join(', ')}.`,
    );
  }
  if (size > maxImageBytes()) {
    throw new AppError(400, 'VALIDATION', `Image too large (${size} bytes). Maximum is ${maxImageBytes()} bytes.`);
  }
  return ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : ct === 'image/gif' ? 'gif' : 'jpg';
}

function sanitizeFilename(name: string, ext: string): string {
  const base = (name || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return `${Date.now()}-${base}.${ext}`;
}

export interface StoredImage {
  imageKey: string;
  imageUrl: string;
  storage: 's3' | 'local';
}

/** Direct server-side PUT of an image buffer (S3 when configured, else local disk). */
export async function putContentImage(
  slug: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<StoredImage> {
  const ext = assertImageUpload(contentType, bytes.length);
  const status = contentStorageStatus();
  if (status.mode === 's3') {
    const objectKey = `${status.prefix}/${slug}/${sanitizeFilename(filename.replace(/\.[a-z0-9]+$/i, ''), ext)}`;
    await getS3Client(status.region).send(
      new PutObjectCommand({
        Bucket: status.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType.toLowerCase(),
      }),
    );
    return {
      imageKey: objectKey,
      imageUrl: `${status.publicBaseUrl.replace(/\/+$/, '')}/${objectKey}`,
      storage: 's3',
    };
  }
  await fs.mkdir(status.localDir, { recursive: true });
  const file = `${slug}-${sanitizeFilename(filename.replace(/\.[a-z0-9]+$/i, ''), ext)}`;
  await fs.writeFile(path.join(status.localDir, file), bytes);
  return { imageKey: `local/${file}`, imageUrl: `/uploads/content/${file}`, storage: 'local' };
}

/** Best-effort delete of a stored image (S3 object or local file). Never throws. */
export async function deleteContentImage(imageKey: string | null | undefined): Promise<void> {
  if (!imageKey) return;
  try {
    if (imageKey.startsWith('local/')) {
      const status = contentStorageStatus();
      if (status.mode !== 'local') return;
      const file = path.basename(imageKey.slice('local/'.length));
      await fs.unlink(path.join(status.localDir, file)).catch(() => undefined);
      return;
    }
    const status = contentStorageStatus();
    if (status.mode !== 's3') return;
    await getS3Client(status.region).send(
      new DeleteObjectCommand({ Bucket: status.bucket, Key: imageKey }),
    );
  } catch (err) {
    console.warn('[storelah] content image delete skipped:', err instanceof Error ? err.message : err);
  }
}

/** Read a local-fallback image for streaming (null when not a local key / missing). */
export async function readLocalImage(imageKey: string | null | undefined): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!imageKey || !imageKey.startsWith('local/')) return null;
  const status = contentStorageStatus();
  if (status.mode !== 'local') return null;
  const file = path.basename(imageKey.slice('local/'.length));
  try {
    const bytes = await fs.readFile(path.join(status.localDir, file));
    const ext = path.extname(file).toLowerCase();
    const contentType =
      ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { bytes, contentType };
  } catch {
    return null;
  }
}
