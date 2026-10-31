import type { Request } from 'express';
import { config } from './config';

/**
 * Host-kind routing for the cms.storelah.sg migration (2026-08).
 *
 * One HTTP API Lambda is exposed under two custom domains: api.storelah.sg and
 * cms.storelah.sg (same `$default` stage, empty basePath). Express routes are
 * host-agnostic, so we classify the incoming host and branch only the UI
 * routes; `/api/**` mounts identically on both hosts.
 *
 * serverless-http v4 attaches the raw API Gateway payload as
 * `req.apiGateway.event` (with `requestContext.domainName`), but its shipped
 * typings declare `event: Object` and `@types/aws-lambda` is not installed here
 * (and cannot be added without touching package.json). We therefore augment
 * `Express.Request` with the minimal structural shape we actually read, instead
 * of reaching for `any`.
 */
interface ApiGatewayEvent {
  requestContext?: { domainName?: string };
}

declare global {
  namespace Express {
    interface Request {
      /** Set by serverless-http v4 on AWS (undefined in local dev). */
      apiGateway?: { event?: ApiGatewayEvent };
      /** serverless-http also mirrors requestContext directly on the request. */
      requestContext?: { domainName?: string };
    }
  }
}

export type HostKind = 'cms' | 'api';

export const CMS_DOMAIN = 'cms.storelah.sg';
export const API_DOMAIN = 'api.storelah.sg';

/** Port-stripped, lower-cased hostname (handles `host:port` and `[::1]:port`). */
function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const withoutPort = trimmed.replace(/^\[([^\]]+)\].*$/, '$1').split(':')[0];
  return withoutPort || trimmed;
}

/** Prefer the API Gateway request context, then the Host header, then a default. */
export function requestDomain(req: Request): string {
  const fromContext = req.apiGateway?.event?.requestContext?.domainName ?? req.requestContext?.domainName;
  if (fromContext) return fromContext;
  const fromHeader = req.headers.host;
  if (fromHeader) return fromHeader;
  return API_DOMAIN;
}

/**
 * RFC 1918 private-network check for LAN dev access (e.g. phone on same Wi-Fi
 * hitting the Mac's LAN IP). Handles `::ffff:` IPv4-mapped forms, which
 * `normalizeHost` otherwise passes through unstripped.
 */
function isPrivateIPv4(host: string): boolean {
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  return false;
}

/**
 * Classifies a request host as:
 *  - `cms`: cms.storelah.sg exactly, plus a localhost/loopback dev override so
 *    the CMS root path is exercisable locally. Outside production, RFC 1918
 *    private-network hosts (LAN IPs) also classify as `cms` so the dashboard
 *    is reachable from other devices on the same Wi-Fi. In production the
 *    private-IP branch is disabled, so a private-IP Host header still
 *    classifies as `api` and the `/config` 404 gate on the api host holds.
 *  - `api`: everything else — api.storelah.sg, the API Gateway invoke hostname
 *    (azzp4x84e6.execute-api.ap-southeast-1.amazonaws.com), or any unknown host.
 */
export function resolveHostKind(req: Request): HostKind {
  const host = normalizeHost(requestDomain(req));
  if (host === CMS_DOMAIN) return 'cms';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'cms.localhost') {
    return 'cms';
  }
  if (!config.isProd && isPrivateIPv4(host)) {
    return 'cms';
  }
  return 'api';
}

/**
 * Public base URL of the operator CMS, for links in emails (invites, password
 * resets). CMS_PUBLIC_URL wins when set; otherwise the CMS host serving this
 * request (https://cms.storelah.sg in prod, http://<host:port> in local dev).
 * Requests arriving on the api host still link to the CMS host.
 */
export function cmsBaseUrl(req: Request): string {
  const fromEnv = process.env.CMS_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (resolveHostKind(req) === 'api') return `https://${CMS_DOMAIN}`;
  const host = normalizeHost(requestDomain(req));
  if (host === CMS_DOMAIN) return `https://${CMS_DOMAIN}`;
  return `http://${req.headers.host ?? host}`;
}
