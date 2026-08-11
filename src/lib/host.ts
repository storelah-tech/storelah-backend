import type { Request } from 'express';

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
 * Classifies a request host as:
 *  - `cms`: cms.storelah.sg exactly, plus a localhost/loopback dev override so
 *    the CMS root path is exercisable locally.
 *  - `api`: everything else — api.storelah.sg, the API Gateway invoke hostname
 *    (azzp4x84e6.execute-api.ap-southeast-1.amazonaws.com), or any unknown host.
 */
export function resolveHostKind(req: Request): HostKind {
  const host = normalizeHost(requestDomain(req));
  if (host === CMS_DOMAIN) return 'cms';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'cms.localhost') {
    return 'cms';
  }
  return 'api';
}