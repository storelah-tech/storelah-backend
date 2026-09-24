// ---------------------------------------------------------------------------
// StoreLah Booking API — OpenAPI 3.0.3 spec (developer-facing docs).
//
// This spec is the single source of truth for clients of the customer-facing
// API served on api.storelah.sg. It documents ONLY the public + customer
// endpoints consumed by booking.storelah.sg and external integrators; the
// operator CMS API (/api/v1/cms) is out of scope EXCEPT the floor-plan "block"
// endpoints, which are documented under the "Operator CMS" tag as a reference
// for the dashboard editor (they are intentionally additive to this file).
//
// Contract notes (matches src/lib/http.ts and the route files exactly):
//  - Success:     200/201 → { data, meta? }   (meta is present only where the
//                 route passes it to ok(); created() has no meta).
//  - Error:       { error: { code, message, details? } }
//  - Auth:        `Authorization: Bearer <JWT>` issued by POST /customer/register
//                 or POST /customer/login. Required on every /customer route
//                 except register and login.
//  - Units:       unit.status is the full UnitStatus enum on public reads but the
//                 listing filter only ever returns AVAILABLE / RESERVED.
//  - Amounts:     Decimal columns are returned as JSON numbers (rounded 2dp); the
//                 booking promotion fields are equally JSON numbers.
// ---------------------------------------------------------------------------

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'StoreLah Booking API',
    version: '1.7.0',
    description: [
      'Customer-facing booking API for the StoreLah self-storage business.',
      '',
      'Public endpoints under `/public/branches`, `/public/units`, `/public/promotions`, `/public/promotion-plans` need no ' +
        'authentication. Customer endpoints under `/customer/*` require ',
      '`Authorization: Bearer <token>` with a JWT issued by `POST /customer/register` or ',
      '`POST /customer/login` (default lifetime 12h).',
      '',
      '**Envelope:** successful responses are `{ data, meta? }`; errors are ',
      '`{ error: { code, message, details? } }`. Codes seen below: `VALIDATION`, `UNAUTHORIZED`, ',
      '`NOT_FOUND`, `CONFLICT`, `INTERNAL`.',
      '',
      'v1.1.0 is ADDITIVE-ONLY over 1.0.0 (no removals/renames/retypes): move-out notices are now ' +
        'persisted and readable via `GET /customer/portal` (`data.notice`), the portal snapshot gains ' +
        'a `data.tenancy` object, and portal units gain `climateControl`, `sizeCode` and `branch` details.',
      '',
      'v1.2.0 is ADDITIVE-ONLY over 1.1.0: Stripe Checkout (TEST MODE) for booking payment — ' +
        '`POST /customer/checkout/sessions` creates a hosted session, ' +
        '`GET /customer/checkout/sessions/{sessionId}` verifies it against Stripe truth, and ' +
        '`POST /customer/stripe/webhook` applies `checkout.session.completed` (idempotent).',
      '',
      'v1.3.0 is ADDITIVE-ONLY over 1.2.0: operator CMS facility-operations endpoints ' +
        '(`Maintenance`, `Assets & vendors`, `Incidents`, `Access control`, `Inspections & compliance`) ' +
        'are documented under the "Operator CMS" tag for the dashboard. They are served on the CMS host ' +
        'under `/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login`.',
      '',
      'v1.4.0 is ADDITIVE-ONLY over 1.3.0: P1 facility extensions — `UnitStatus.BLOCKED` (held out ' +
        'of inventory), portfolio overview (`/cms/portfolio`), net PSF (`/cms/rates/net-psf`), quotes ' +
        '(`/cms/quotes`), move-outs queue (`/cms/move-outs`), fees & deposits (`/cms/fees`), business ' +
        'rules (`/cms/business-rules`) and users & roles (`/cms/users`). Same CMS host + Bearer JWT.',
      '',
      'v1.4.1 is ADDITIVE-ONLY over 1.4.0: stackable locker placements — two LOCKER units may share ' +
        'the exact same rect as an upper/lower pair distinguished by `stackTier` (0 = ground/sole, ' +
        '1 = upper). `PUT /cms/floor-plans/{floorId}/units/{unitId}` accepts an optional `stackTier` ' +
        '(0/1, omitted keeps the tier on update) and every placement shape gains `stackTier`; ' +
        'stacking is lockers-only and at most 2 high (third same-rect write is 409, non-locker ' +
        'stacking is 400).',
      '',
      'v1.5.0 is ADDITIVE-ONLY over 1.4.1: floor-plan area metrics (Phase 2) — live compute ' +
        '`GET /cms/floor-plans/{floorId}/metrics` over the current canvas geometry (centreline ' +
        'basis; occupancy triple, GPI/actual revenue, climate/size unit-mix, volumetric capacity, ' +
        'SHA-256 geometry_hash) plus append-only snapshot history ' +
        '`POST`/`GET /cms/floor-plans/{floorId}/metrics/snapshots` (`{effective_date}`; ' +
        'validation ERRORs block publish with 422; no update route by design). Same CMS host + ' +
        'Bearer JWT. Areas serialise as `{ q: string, sqft: number }` (exact decimal-string ' +
        'quarter-base-units^2 + display sqft); money as `{ cents: integer, sgd: number }`.',
      '',
      'v1.5.1 is ADDITIVE-ONLY over 1.5.0: floor-plan area metrics (Phase 3) — region-to-circulation ' +
        'connectivity (circulation-kind blocks — Corridor/aisle/lift/lobby/loading — are traversable, so ' +
        'a spanning Corridor joins derived circulation instead of splitting it; `UNREACHABLE_UNIT` now ' +
        'fires only for genuinely disconnected units) plus per-region door authoring: placement and block ' +
        'payloads accept an optional `doorEdges` compass subset (omitted keeps, null clears, array ' +
        'replaces; outside N/S/E/W is 400), every placement/block shape gains `doorEdges`, and metrics ' +
        'unit rows gain `doors` + `doorSource` (`authored` vs `auto` AUTO_ALL_EDGES fallback). ' +
        '`access_model` reports `MIXED_AUTHORED_AND_AUTO_SEEDED_ENTRANCE` once any unit has authored ' +
        'edges. All Phase-1 exact aggregates are unchanged.',
      '',
      'v1.5.2 is ADDITIVE-ONLY over 1.5.1: public promotion type/scope tokens for the live promo demo — ' +
        '`GET /public/promotions` rows and `POST /public/promotions/validate` results gain optional ' +
        '`type` (PERCENTAGE / DOLLAR / FLAT / CREDITS), `appliesTo` and `durationScope` (FIRST_MONTH / ' +
        'ONE_TIME / DUE_TODAY, anything else treated as recurring). All pre-existing fields, the ' +
        '`{ valid, discountAmt, monthlyAfterPromo }` discount math, the `{ valid: false }`-not-an-error ' +
        'contract, and the `Promotion.required` lists are unchanged.',
      '',
      'v1.5.3 is ADDITIVE-ONLY over 1.5.2: public discount-plan matrix for the booking Expected Stay ' +
        'tiles — new unauthenticated `GET /public/promotion-plans` returns ACTIVE plans only ' +
        '(`{ id, name, status, cells: [{ sizeCategory, commitmentMonths, discountPct, accessType? }] }`; ' +
        'DRAFT / SCHEDULED / ENDED excluded, honest empty array when none is ACTIVE). Legacy ' +
        '`GET /public/promotions` and `POST /public/promotions/validate` shapes are unchanged.',
      '',
      'v1.5.4 is ADDITIVE-ONLY over 1.5.3: floor-plan boundary line items — operator-drawn ' +
        'facility-boundary polylines (`FloorPlanBoundary`: label/kind/points/closed/sortOrder, ' +
        'grid-ft vertices) with CMS CRUD ' +
        '`GET|POST /cms/floor-plans/{floorId}/boundaries` + ' +
        '`PUT|DELETE /cms/floor-plans/{floorId}/boundaries/{boundaryId}` (Bearer JWT). Plan reads ' +
        '(CMS + `GET /public/floor-plans/{branchCode}/{level}`) gain `boundaries` plus derived ' +
        '`boundaryMetrics { gla, ufa, nla, unit, boundaryClosed }`: GLA = closed-loop area, ' +
        'UFA = GLA minus block + solid-structure footprints, NLA = placed-unit footprints inside ' +
        'the loops (clamped, 1dp); all-zero with `boundaryClosed: false` when no loop is closed. ' +
        'All pre-existing plan shapes, metrics endpoints, and promotion/booking/customer APIs are unchanged.',
      '',
      'v1.5.5 is ADDITIVE-ONLY over 1.5.4: operator-entered GFA per floor plan — ' +
        '`POST /cms/floor-plans/{floorId}` accepts an optional `gfaSqft` (positive sqft, null clears, ' +
        'omitted keeps) and every plan read gains `gfaSqft` (null when unset) + `gfaSource` ' +
        '(`USER` | `CANVAS`); the live metrics `geometry` gains `gfaSource` and uses the entered GFA ' +
        'for `gfa`, efficiency and the revenue chain when set (canvas-rect fallback flagged in ' +
        '`basis_notes` when unset). Marked-area rule for line-driven UFA/NLA: closed loops AND open ' +
        'polylines with 3+ vertices (chord-closed) feed `boundaryMetrics` (open 2-vertex segments ' +
        'persist and render SOLID but contribute 0 until extended/closed); `boundaryMetrics` gains ' +
        '`facilityAreaSqft` (= marked gross, same value as `gla`) plus mirrored `gfaSqft`/`gfaSource`, ' +
        'all-zero with `boundaryClosed: false` when no marked line contributes area — never fabricated. ' +
        'Persisted editor lines render solid (only the in-flight draft previews dashed). ' +
        'All pre-existing shapes are unchanged.',
      '',
      'v1.6.0 is ADDITIVE-ONLY over 1.5.5: CMS-editable booking-extras catalog — ' +
        'protection tiers (`ProtectionPlan`: id slug, name, price monthly recurring, coverage, ' +
        'sortOrder, active) and packing-supply addons (`Addon`: id slug, name, price one-off, ' +
        'unit, sortOrder, active) with unauthenticated `GET /public/protection-plans` + ' +
        '`GET /public/addons` (active only, sortOrder ascending, `{ data, meta: { count } }`) ' +
        'and operator CMS CRUD `GET|POST /cms/protection-plans`, ' +
        '`PATCH|DELETE /cms/protection-plans/{id}` (same 4 for `/cms/addons`; Bearer JWT; ' +
        'PATCH carries the active toggle — deactivation preferred over hard delete). ' +
        'All pre-existing shapes are unchanged.',
      '',
      'v1.6.1 is ADDITIVE-ONLY over 1.6.0: Stripe Checkout hardening (TEST MODE, no shape changes) — ' +
        '`POST /customer/bookings` now recomputes the invoiced amount server-side ' +
        '(unit rate minus validated promo plus catalog protection/addon prices); the client ' +
        '`totalDueToday` is a hint only and a hint below server pricing is `400 VALIDATION`. ' +
        '`POST /customer/checkout/sessions` reuses the booking\'s stored open session and dedupes ' +
        'concurrent creates (double-click safe), and `POST /customer/stripe/webhook` resolves the ' +
        'booking by stored session id (metadata ref as fallback) and flips only the invoiced ' +
        'session\'s DUE invoice to PAID. All pre-existing shapes are unchanged.',
      '',
      'v1.6.2 is ADDITIVE-ONLY over 1.6.1: line-only (marked-area) UFA/NLA in the live metrics ' +
        'report — `GET /cms/floor-plans/{floorId}/metrics` gains top-level `boundaryMetrics` ' +
        '(byte-identical to the plan-read shape) and `geometry.ufa/nlaEnclosed/nlaTotal/common` ' +
        'are now the marked-area figures (UFA = marked gross minus blocks/structure, NLA = ' +
        'placements clipped to loops capped at UFA, outdoor split 0, common = UFA − NLA; ' +
        'all-zero with `boundaryClosed: false` when no marked line contributes area — never the ' +
        'whole-canvas rect). Efficiency and the occupancy-sqft/revenue NLA denominators follow ' +
        'the same line-only NLA; canvas-tessellated whole-canvas figures survive only as ' +
        'diagnostic numbers inside `basis_notes` (exteriorWall/derivedCirculation/droppedSlivers/' +
        'balanced stay canvas diagnostics). GFA/occupancy-count/revenue-money/unit_mix/volumetric ' +
        'shapes are unchanged.',
      '',
      'v1.6.3 is ADDITIVE-ONLY over 1.6.2: unauthenticated lead capture for the booking ',
      '"Your details" step — `POST /public/leads` creates a Lead with stage `NEW_ENQUIRY` ',
      '(201; repeat `idempotencyKey` or same email+mobile+branch within 10 min returns the ',
      'existing row with 200). `branchCode` resolves server-side (`preferredBranchId` cuid ',
      'accepted as an alternative; unknown codes are 400), `purpose` maps to ',
      'PERSONAL|BUSINESS, and overflow fields with no dedicated column are packed into ',
      '`note` as stable `key: value` lines (no migration). Per-IP fixed-window rate limit ',
      '(429). All pre-existing shapes are unchanged.',
      '',
      'v1.7.0 is ADDITIVE-ONLY over 1.6.3: v2 booking-intent field-sync — every ',
      'booking-steps datum is stored as a first-class Lead column (`unitCode`, `moveInDate`, ',
      '`durationMonths`, `companyName`, `uen`, `consentPdpa`, `consentMarketing`, ',
      '`protectionTier`, `protectionCost`, `addons` (max 20 × { id?, name, qty, price }), ',
      '`promoCode`, `promoDiscountAmt`, `movingService`, `totalDueToday`; all optional, ',
      '`name` + ≥1 contact still required, `consentPdpa` must be true when supplied). ',
      'New rows write columns directly (`note` carries only the message head); pre-v2 ',
      'note-packed rows keep reading via the server-side legacy parser fallback. ',
      'All pre-existing shapes are unchanged.',
    ].join('\n'),
  },
  servers: [
    { url: 'https://api.storelah.sg/api/v1', description: 'Production' },
  ],
  tags: [
    {
      name: 'Public',
      description:
        'Unauthenticated discovery endpoints (branches, units, promotions).',
    },
    {
      name: 'Customer',
      description:
        'Authenticated customer endpoints (profile, bookings, portal, requests, notice).',
    },
    {
      name: 'Operator CMS',
      description:
        'Operator CMS floor-plan endpoints (documented for reference only — served on the CMS host under /api/v1/cms with a Bearer JWT).',
    },
  ],
  paths: {
    '/public/branches': {
      get: {
        tags: ['Public'],
        summary: 'List branches',
        description:
          'All branches with their floor levels and current count of AVAILABLE units. No tenant/internal counters.',
        operationId: 'listPublicBranches',
        security: [],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('PublicBranches') }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/units': {
      get: {
        tags: ['Public'],
        summary: 'List available units',
        description: [
          'Units that are currently browseable (status AVAILABLE or RESERVED; a deleted unit is never listed).',
          'Filters by branch code, floor level, and/or status. `level` and `status` are validated — an invalid ',
          'combination yields `400 VALIDATION` with zod-flattened details.',
          '',
          'Response `data` is the unit array and `meta` carries the result count plus the list of distinct branch ',
          'codes present in the returned units.',
        ].join('\n'),
        operationId: 'listPublicUnits',
        security: [],
        parameters: [
          {
            name: 'branch',
            in: 'query',
            required: false,
            description: 'Branch code to filter on (e.g. BM, WD, UB).',
            schema: { type: 'string', minLength: 1 },
          },
          {
            name: 'level',
            in: 'query',
            required: false,
            description: 'Floor level to filter on (coerced to integer).',
            schema: { type: 'integer' },
          },
          {
            name: 'status',
            in: 'query',
            required: false,
            description:
              'Unit status filter. When omitted both AVAILABLE and RESERVED are returned.',
            schema: { $ref: openapiSchemaRef('BrowseableUnitStatus') },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: {
                    data: {
                      type: 'array',
                      items: { $ref: openapiSchemaRef('PublicUnit') },
                    },
                    meta: {
                      type: 'object',
                      required: ['count', 'branches'],
                      properties: {
                        count: {
                          type: 'integer',
                          description: 'Number of units in `data`.',
                        },
                        branches: {
                          type: 'array',
                          items: { type: 'string' },
                          description:
                            'Distinct branch codes present in `data`.',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': openapiErrorResponse(
            'Invalid units query (bad branch/level/status).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/units/map': {
      get: {
        tags: ['Public'],
        summary: 'Get floor unit map',
        description: [
          'Visual-map view of a branch/floor: legend counts plus one entry per unit with a short code and price. ',
          'Tenant/PII is never included on this public surface. `branch` defaults to `BM` and `level` to `1` when ',
          'omitted; invalid `level` values fall back to `1` (no validation error).',
        ].join('\n'),
        operationId: 'getUnitMap',
        security: [],
        parameters: [
          {
            name: 'branch',
            in: 'query',
            required: false,
            description: 'Branch code (default `BM`).',
            schema: { type: 'string', minLength: 1 },
          },
          {
            name: 'level',
            in: 'query',
            required: false,
            description: 'Floor level (default `1`).',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('UnitMap') }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/promotions': {
      get: {
        tags: ['Public'],
        summary: 'List active promotions',
        description:
          'Promotions currently `active` and inside their start/end date window. `applicableSize` is not returned on the public surface.',
        operationId: 'listActivePromotions',
        security: [],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('Promotion') },
          }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/promotions/validate': {
      post: {
        tags: ['Public'],
        summary: 'Validate a promotion code',
        description: [
          'Validates `code` against an input monthly `rate` and lease `months`. PERCENTAGE promotions discount `rate`; ',
          'FLAT promotions discount up to `rate`. Unknown, inactive, out-of-window, or below-minMonths codes return ',
          '`valid: false` — never an error response. Invalid bodies (missing/malformed `code`, non-numeric `rate` or ',
          '`months`) also return the same 200 invalid shape with `monthlyAfterPromo` set to the parsed `rate` (or 0).',
        ].join('\n'),
        operationId: 'validatePromotion',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ValidatePromotionRequest') },
            },
          },
        },
        responses: {
          '200': openapiResponse({
            $ref: openapiSchemaRef('PromotionValidationResult'),
          }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/promotion-plans': {
      get: {
        tags: ['Public'],
        summary: 'List active promotion plans (discount matrix)',
        description: [
          'ACTIVE promotion plans with their discount-matrix cells, for the booking frontend Expected Stay ',
          'tiles (size × 1/3/6/12 months). DRAFT / SCHEDULED / ENDED plans are excluded; an honest empty ',
          'array is returned when no plan is ACTIVE. No authentication. This surface is additive — ',
          '`GET /public/promotions` and `POST /public/promotions/validate` are unchanged.',
        ].join('\n'),
        operationId: 'listActivePromotionPlans',
        security: [],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('PublicPromotionPlan') },
          }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/protection-plans': {
      get: {
        tags: ['Public'],
        summary: 'List active protection plans',
        description: [
          'CMS-editable protection tiers for the booking checkout (id slug, name, monthly recurring ',
          'price, coverage, sortOrder). Active rows only, sortOrder ascending. The id is the stable ',
          'frontend slug so the app can fall back to its baked-in copy when a row is missing. ',
          'No authentication. Envelope `{ data, meta: { count } }`.',
        ].join('\n'),
        operationId: 'listActiveProtectionPlans',
        security: [],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('ProtectionPlan') },
          }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/addons': {
      get: {
        tags: ['Public'],
        summary: 'List active packing-supply addons',
        description: [
          'CMS-editable packing supplies for the booking checkout (id slug, name, one-off price, ',
          'unit, sortOrder). Active rows only, sortOrder ascending. The id is the stable frontend ',
          'slug so the app can fall back to its baked-in copy when a row is missing. ',
          'No authentication. Envelope `{ data, meta: { count } }`.',
        ].join('\n'),
        operationId: 'listActiveAddons',
        security: [],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('Addon') },
          }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/leads': {
      post: {
        tags: ['Public'],
        summary: 'Submit a lead (booking "Your details")',
        description: [
          'Unauthenticated lead capture for the booking frontend: creates a Lead with stage ',
          '`NEW_ENQUIRY` (source as given, default `WEBSITE`). `name` plus at least one of ',
          '`email`/`mobile` is required; `branchCode` (BM/WD/UB, case-insensitive) resolves ',
          'server-side to the branch (`preferredBranchId` cuid accepted as an alternative; ',
          'unknown codes are `400 VALIDATION`). `purpose` (`personal`|`business`, default ',
          'personal) maps to `PERSONAL`|`BUSINESS` (`BUSINESS` wins when `companyName`/`uen` ',
          'are present). Every booking-steps datum is stored as a first-class Lead column ',
          '(`unitCode`, `moveInDate`, `durationMonths`, `protectionTier`/`protectionCost`, ',
          '`addons` up to 20 items, `promoCode`/`promoDiscountAmt`, `movingService`, ',
          '`totalDueToday`; `note` carries only the message head) — pre-v2 note-packed ',
          '`key: value` rows keep reading via the legacy parser fallback. `unitCode` is a ',
          'loose reference only (never an FK, never a 400). Dedupe: a repeat `idempotencyKey` ',
          '(24h) or the same email+mobile+branch within 10 minutes returns the existing row ',
          'with 200 instead of a duplicate. No authentication. Envelope `{ data }`.',
        ].join('\n'),
        operationId: 'createPublicLead',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('PublicLeadRequest') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('PublicLead') }),
          '200': openapiResponse({ $ref: openapiSchemaRef('PublicLead') }),
          '400': openapiErrorResponse(
            'Invalid lead payload (missing name/contact, bad email, unknown branchCode, consentPdpa false).',
          ),
          '429': openapiErrorResponse(
            'Too many requests: per-IP fixed-window rate limit (see PUBLIC_LEAD_RATE_LIMIT).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/public/floor-plans/{branchCode}/{level}': {
      get: {
        tags: ['Public'],
        summary: 'Get a floor\'s floor plan',
        description: [
          'The authored layout for one branch floor, for the booking app to render real unit positions: plan canvas ',
          '(width/height in LOGICAL GRID UNITS) + free-form `structure` decorations + `blocks` (name+rect ',
          'decoration labels like Lift/Stairs/Exit) + placements joined to unit `unitCode`/`name`/`size`/`status`.',
          '',
          'Soft-deleted units are filtered from `plan.placements`. No tenant, PII, rates, or internal counters are ever ',
          'returned. When no plan has been authored for the floor, `plan` is `null` and the renderer falls back to a ',
          'synthesized grid (existing `UnitFloorPlan` behaviour). This endpoint is additive — it does not change any ',
          'existing public response.',
        ].join('\n'),
        operationId: 'getPublicFloorPlan',
        security: [],
        parameters: [
          {
            name: 'branchCode',
            in: 'path',
            required: true,
            description: 'Branch code, case-insensitive (e.g. BM, WD, UB).',
            schema: { type: 'string' },
          },
          {
            name: 'level',
            in: 'path',
            required: true,
            description: 'Floor level (1..4).',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('PublicFloorPlan') }),
          '400': openapiErrorResponse('Invalid floor level.'),
          '404': openapiErrorResponse('Branch or floor not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/units/{unitId}': {
      put: {
        tags: ['Operator CMS'],
        summary: 'Place (upsert) a unit on a floor plan',
        description: [
          'Upserts one unit placement keyed by unit id: the unit must belong to the plan\'s floor and must not ',
          'be soft-deleted; the rect must fit inside the canvas and its area must be within ±15% of the unit\'s ',
          'sqft (400 otherwise). Overlapping another unit\'s rect is 409 `PLACEMENT_OVERLAP`.',
          '',
          'STACKING (lockers only): two LOCKER units may share the EXACT same rect as an upper/lower pair via ',
          '`stackTier` (0 = ground/sole, 1 = upper; omitted keeps the tier on update, 0 on create). Tier 1 ',
          'requires a tier-0 partner on the same rect (lone tier 1 is 400); a rect holding both tiers rejects ',
          'a third placement (409); non-LOCKER units sharing a rect are 400. Paired drag/resize persists the ',
          'ground tier first, then the upper tier onto the same rect. Moving/deleting a ground tier demotes a ',
          'leftover upper to a standalone ground single.',
          '',
          'DOORS (Phase 3): the payload accepts an optional `doorEdges` compass subset (["N","S","E","W"]; ',
          'omitted keeps the placement\'s edges, null clears back to unauthored, an array replaces; ',
          'anything outside N/S/E/W is 400). Authored edges drive metrics reachability for that unit; ',
          'unauthored units fall back to every edge as a door (AUTO_ALL_EDGES).',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'setUnitPlacement',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
          {
            name: 'unitId',
            in: 'path',
            required: true,
            description: 'Unit row id (a unit is placed at most once).',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('PlacementInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('PlanPlacement') }),
          '400': openapiErrorResponse(
            'Invalid geometry/tier, unit deleted or on another floor, area deviates >15% from sqft, lone tier 1, or non-locker stacking.',
          ),
          '404': openapiErrorResponse('Unit or floor not found.'),
          '409': openapiErrorResponse(
            'Rect overlaps another unit, or the rect already holds a stacked pair (max 2 high).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Remove a unit placement (unstack)',
        description: [
          'Removes a unit\'s placement (geometry only — the Unit row is untouched). Deleting the upper tier ',
          'restores the ground placement to a single; deleting a ground tier demotes a leftover upper tier on ',
          'the same rect to a standalone ground single.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'removeUnitPlacement',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
          {
            name: 'unitId',
            in: 'path',
            required: true,
            description: 'Unit row id.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['floorId', 'unitId', 'removed'],
            properties: {
              floorId: { type: 'string' },
              unitId: { type: 'string' },
              removed: { type: 'boolean', enum: [true] },
            },
          }),
          '404': openapiErrorResponse('No plan for this floor, or the unit has no placement on it.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/blocks': {
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a floor-plan decoration block',
        description: [
          'Creates a user-authored layout-decoration rectangle (e.g. Lift, Stairs, Exit, Walking area) on the ',
          'floor\'s plan. Blocks are plain name+rect primitives — the replacement for authoring the legacy ',
          '`structure` JSON markers. The plan is lazily created at the default canvas if the floor has none yet.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'createFloorPlanBlock',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('BlockInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('PlanBlock') }),
          '400': openapiErrorResponse(
            'Invalid block payload, or geometry exceeds the plan canvas.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/metrics': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Live floor-plan area metrics',
        description: [
          'Computes area metrics live from the floor\'s current canvas geometry (placements + blocks) ',
          'joined to Unit status/rates/sizes: centreline-basis geometry (GFA/UFA/NLA/GFA-dual-tagged GLA, ',
          'efficiency, load factor), the occupancy triple (physical count, sqft billable-occupied/NLA, ',
          'economic actual/GPI), revenue (GPI monthly/annual at 100% market occupancy, rate per sqft, ',
          'RevPAF/RevPOF with a walkable gross→efficiency→rentable→rent chain), unit-mix (climate-controlled ',
          'area share + size-band histogram by area share), volumetric capacity (clear area × ceiling, floor ',
          'sums), per-unit rows, circulation, reachability and validation records.',
          '',
          'UFA/NLA are LINE-ONLY (marked-area, never the whole canvas): `geometry.ufa` is the marked ',
          'gross minus blocks/solid-structure rects, `geometry.nlaEnclosed`/`nlaTotal` are placement ',
          'footprints clipped to the marked loops (capped at UFA), `nlaOutdoor` is 0 and `common` is ',
          'UFA − NLA — all-zero with `boundaryClosed: false` when no marked line contributes area. The ',
          'authoritative marked figures are also exposed as top-level `boundaryMetrics` (byte-identical ',
          'to the plan-read shape); canvas-tessellated whole-canvas figures survive only as diagnostic ',
          'numbers inside `basis_notes`.',
          '',
          'Every payload carries an `assumptions` block (measurement_basis CENTERLINE, pricing_basis, ',
          'gla_convention, wall_thickness_ft, residual_tolerance_sqft 0.25, min_aisle_width_ft 3.0, ',
          'access_model, ceiling_height_ft, market_rate_source, basis_notes) plus facility + floor + coverage, ',
          '`schema_version` and the SHA-256 `geometry_hash` over the canonicalised sorted region set.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'getFloorPlanMetrics',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('FloorMetricsReport') }),
          '400': openapiErrorResponse(
            'Non-rectangular geometry at the boundary, or the plan canvas is not initialized.',
          ),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Floor or floor plan not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/facility/{branchRef}/metrics': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Facility-level floor-plan metrics rollup (live)',
        description: [
          'Sums the per-floor LIVE metrics reports (`GET /cms/floor-plans/{floorId}/metrics`) into one ',
          'facility aggregate: geometry GFA/UFA/NLA sums with the NLA≤UFA clamp, corridorArea (= common = ',
          'UFA−NLA), guarded efficiency ratios + GFA→UFA / UFA→NLA pcts, DB-wide totals (unplaced = no-placement ',
          'units, occupied = OCCUPIED+OVERDUE) and per-size unitGroups (Locker=LOCKER, XS=SMALL, M=MEDIUM, ',
          'L=LARGE, XL=0/0 — no Extra Large UnitSize exists). Floors without a plan contribute zero geometry ',
          'and are listed in `floorsWithoutPlan`. Snapshot payloads are never summed (source LIVE).',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'getFacilityFloorPlanMetrics',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'branchRef',
            in: 'path',
            required: true,
            description: 'Branch row id or branch code (e.g. BM).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('FacilityMetricsReport') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Facility not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/metrics/snapshots': {
      post: {
        tags: ['Operator CMS'],
        summary: 'Publish a metrics snapshot (append-only)',
        description: [
          'Persists the live metrics as an append-only history row for `{effective_date}` (201 with the ',
          'created snapshot id + keys). Validation ERRORs block publication with 422 and the validation ',
          'array in the error details — invalid geometry is never persisted. Publishing the same date twice ',
          'creates two rows (history, not state); there is no PUT/PATCH route — updates are forbidden by design.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'createFloorPlanMetricsSnapshot',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('MetricsSnapshotInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('MetricsSnapshot') }),
          '400': openapiErrorResponse('Invalid effective_date (must be YYYY-MM-DD).'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Floor or floor plan not found.'),
          '422': {
            description: 'Blocking validation errors — snapshot not persisted.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      get: {
        tags: ['Operator CMS'],
        summary: 'List metrics snapshots',
        description: [
          'Append-only snapshot history for a floor, newest effective date first, payloads included. ',
          'Every row carries its `schemaVersion` and `geometryHash`.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'listFloorPlanMetricsSnapshots',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('MetricsSnapshotWithPayload') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Floor not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/blocks/{blockId}': {
      put: {
        tags: ['Operator CMS'],
        summary: 'Upsert a floor-plan decoration block',
        description: [
          'Set/upsert a block scoped to the floor\'s plan: updates an existing block on this plan (drag / resize / ',
          'rename persistence), or creates it when the id is a fresh one. A block id belonging to a different plan ',
          'is rejected.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'upsertFloorPlanBlock',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'blockId',
            in: 'path',
            required: true,
            description: 'Block id (cuid). A fresh id creates the block.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('BlockInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('PlanBlock') }),
          '400': openapiErrorResponse(
            'Invalid block payload, or geometry exceeds the plan canvas.',
          ),
          '404': openapiErrorResponse(
            'Block belongs to a different plan (cross-plan ids are rejected).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a floor-plan decoration block',
        description: [
          'Removes a block from the floor\'s plan. Cross-plan ids 404.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'deleteFloorPlanBlock',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'blockId',
            in: 'path',
            required: true,
            description: 'Block id (cuid).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['floorId', 'blockId', 'removed'],
            properties: {
              floorId: { type: 'string' },
              blockId: { type: 'string' },
              removed: { type: 'boolean', enum: [true] },
            },
          }),
          '404': openapiErrorResponse(
            'No plan for this floor, or block belongs to a different plan.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/boundaries': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List floor-plan boundary line items',
        description: [
          'Lists the facility-boundary line-item polylines on the floor\'s plan in editor sort order ' +
            '([] when the floor has no plan yet). Plan reads also embed `boundaries` plus derived ' +
            '`boundaryMetrics { gla, ufa, nla, unit, boundaryClosed, facilityAreaSqft, gfaSqft, gfaSource }` ' +
            '(marked-area rule: 3+-vertex polylines feed UFA/NLA; lone 2-vertex segments contribute 0, ' +
            'but endpoint-connected segments that join into a ring feed UFA/NLA as one loop).',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'listFloorPlanBoundaries',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('PlanBoundary') },
          }),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a floor-plan boundary line item',
        description: [
          'Creates a facility-boundary line-item polyline (grid-ft vertices `[[x, y], ...]`, 2+ vertices; ' +
            '`closed: true` needs 3+ distinct vertices) on the floor\'s plan. Vertices must sit on the canvas. ' +
            'The plan is lazily created at the default canvas if the floor has none yet. Marked-area rule: ' +
            '3+-vertex polylines (open or closed) feed UFA/NLA via chord-close, as do endpoint-connected ' +
            'segments that join into a ring (e.g. a square drawn as four strokes); lone open 2-vertex segments persist ' +
            'honestly and contribute 0 until extended/closed.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'createFloorPlanBoundary',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('BoundaryInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('PlanBoundary') }),
          '400': openapiErrorResponse(
            'Invalid boundary payload, or vertices sit outside the plan canvas.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/floor-plans/{floorId}/boundaries/{boundaryId}': {
      put: {
        tags: ['Operator CMS'],
        summary: 'Update a floor-plan boundary line item',
        description: [
          'Updates a boundary line item scoped to the floor\'s plan (vertex drag / close-loop / rename ' +
            'persistence). Omitted fields keep their values; `points` replaces the whole polyline. ' +
            'A boundary id belonging to a different plan is rejected.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'updateFloorPlanBoundary',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
          {
            name: 'boundaryId',
            in: 'path',
            required: true,
            description: 'Boundary id (cuid).',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('BoundaryInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('PlanBoundary') }),
          '400': openapiErrorResponse(
            'Invalid boundary payload, or vertices sit outside the plan canvas.',
          ),
          '404': openapiErrorResponse(
            'Boundary belongs to a different plan (cross-plan ids are rejected).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a floor-plan boundary line item',
        description: [
          'Removes a boundary line item from the floor\'s plan. Cross-plan ids 404.',
          '',
          'Operator CMS endpoints are documented here for reference only; they are served on the CMS host under ',
          '`/api/v1/cms` and require a Bearer JWT issued by `/api/v1/cms/login` (auto-login via `/api/v1/cms/config`).',
        ].join('\n'),
        operationId: 'deleteFloorPlanBoundary',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'floorId',
            in: 'path',
            required: true,
            description: 'Floor row id (the plan upsert key).',
            schema: { type: 'string' },
          },
          {
            name: 'boundaryId',
            in: 'path',
            required: true,
            description: 'Boundary id (cuid).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['floorId', 'boundaryId', 'removed'],
            properties: {
              floorId: { type: 'string' },
              boundaryId: { type: 'string' },
              removed: { type: 'boolean', enum: [true] },
            },
          }),
          '404': openapiErrorResponse(
            'No plan for this floor, or boundary belongs to a different plan.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/register': {
      post: {
        tags: ['Customer'],
        summary: 'Register a customer account',
        description:
          'Creates a customer and returns a fresh bearer JWT plus the serialized customer. Email must be unique (409 on clash).',
        operationId: 'registerCustomer',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('RegisterRequest') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({
            $ref: openapiSchemaRef('AuthResponse'),
          }),
          '400': openapiErrorResponse(
            'Invalid registration payload (zod-flattened details).',
          ),
          '409': openapiErrorResponse(
            'An account with this email already exists.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/login': {
      post: {
        tags: ['Customer'],
        summary: 'Log in',
        description:
          'Exchanges email + password for a bearer JWT. Wrong credentials or an unparseable body both yield `401 UNAUTHORIZED`.',
        operationId: 'loginCustomer',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('LoginRequest') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AuthResponse') }),
          '401': openapiErrorResponse('Invalid email or password.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/claim': {
      post: {
        tags: ['Customer'],
        summary: 'Set up portal access from a guest booking',
        description: [
          'For guests who booked with just an email + mobile: proves identity with their bookingRef ',
          '(delivered on booking confirmation) plus that email + mobile, then sets a real portal password — ',
          'replacing the shared guest default password and converting the account from GUEST to PERSONAL.',
          '',
          'Returns the same `{ token, customer }` shape as login. Every mismatch (unknown bookingRef, wrong email, ',
          'wrong mobile, no such account) returns one uniform `401 UNAUTHORIZED`; an already-claimed or registered ',
          'account returns `409 CONFLICT`. Failed attempts are rate-limited to 5 per rolling minute per IP+email.',
        ].join('\n'),
        operationId: 'claimGuestAccount',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ClaimRequest') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AuthResponse') }),
          '400': openapiErrorResponse(
            'Invalid claim payload (zod-flattened details).',
          ),
          '401': openapiErrorResponse(
            "Uniform failure for any mismatch: we couldn't match those details to a recent booking.",
          ),
          '409': openapiErrorResponse(
            'Portal access was already set up (account is no longer type GUEST) — sign in instead.',
          ),
          '429': openapiErrorResponse(
            'Too many failed attempts: 5 per rolling minute per IP+email. Successes do not count.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/forgot-password': {
      post: {
        tags: ['Customer'],
        summary: 'Request password reset',
        description:
          'Generates a one-time reset token for the given email. Returns the token directly (no email sending in development).',
        operationId: 'forgotPassword',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ForgotPasswordRequest') },
            },
          },
        },
        responses: {
          '200': openapiResponse({
            $ref: openapiSchemaRef('ForgotPasswordResponse'),
          }),
          '400': openapiErrorResponse('Invalid request.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/reset-password': {
      post: {
        tags: ['Customer'],
        summary: 'Reset password with token',
        description:
          'Validates the one-time reset token and sets a new password.',
        operationId: 'resetPassword',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ResetPasswordRequest') },
            },
          },
        },
        responses: {
          '200': openapiResponse({
            $ref: openapiSchemaRef('ResetPasswordResponse'),
          }),
          '400': openapiErrorResponse(
            'Invalid or expired reset token.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/me': {
      get: {
        tags: ['Customer'],
        summary: 'Get my profile',
        description:
          'Returns the serialized customer plus their booking history.',
        operationId: 'getCustomerProfile',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            $ref: openapiSchemaRef('CustomerWithBookings'),
          }),
          '401': openapiErrorResponse(
            'Missing/invalid bearer token, or customer record no longer exists.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/bookings': {
      post: {
        tags: ['Customer'],
        summary: 'Create a booking',
        description: [
          'Books a unit and returns the created booking. On success the unit is marked RESERVED and a DUE invoice is ',
          'raised for the server-recomputed due-today total (unit rate minus ACTIVE promotion-plan matrix discount — exact size × commitment-months cell, integer-rounded — else validated promo-code discount, plus catalog protection/addon prices); ',
          'the client `totalDueToday` is a hint only — a hint below server pricing is `400 VALIDATION` ' +
          'with details `{ expected, base, promoDiscount, protection, addons }` (all numbers) for refresh-and-retry.',
          '',
          'Auth: dual-mode. WITH a bearer token, books for the authenticated customer (invalid token = 401). ',
          'WITHOUT any Bearer Authorization header, performs guest checkout: the body must include `email`, and the customer ',
          'record is found-or-created by it (new customers get type GUEST and a bcrypt-hashed default password).',
          '',
          'Errors: `404 NOT_FOUND` when the unit code is unknown, `409 CONFLICT` when the unit is not AVAILABLE/RESERVED, ',
          '`400 VALIDATION` when unauthenticated and `email` is missing/invalid.',
        ].join('\n'),
        operationId: 'createCustomerBooking',
        security: [{ bearerAuth: [] }, []],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('CreateBookingRequest') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({
            $ref: openapiSchemaRef('BookingCreated'),
          }),
          '400': openapiErrorResponse(
            'Invalid booking payload, or `moveInDate` is not a valid date.',
          ),
          '401': openapiErrorResponse(
            'Bearer token was supplied but is invalid/expired. (No Bearer header at all → guest checkout instead of 401.)',
          ),
          '404': openapiErrorResponse('Unit not found.'),
          '409': openapiErrorResponse(
            'Unit is not AVAILABLE/RESERVED and cannot be booked.',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      get: {
        tags: ['Customer'],
        summary: 'List my bookings',
        description:
          'All bookings linked to the authenticated customer (matches the tenant by customer email), newest first.',
        operationId: 'listCustomerBookings',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('BookingSummary') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/portal': {
      get: {
        tags: ['Customer'],
        summary: 'Customer portal snapshot',
        description: [
          'Consolidated portal data: customer, their current unit (or the most recently booked one), invoices, and bookings.',
          '',
          'Additive since 1.1.0: `data.notice` echoes the latest persisted move-out notice (null when none was ' +
            'submitted — previously notices were not persisted at all) and `data.tenancy` carries the tenancy ' +
            'move-in and next-billing dates (null when the customer has no tenant record).',
        ].join('\n'),
        operationId: 'getCustomerPortal',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Portal') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/requests': {
      post: {
        tags: ['Customer'],
        summary: 'Submit a request',
        description:
          'Files a request (upsize / downsize / transfer) which is stored as a WEBSITE lead for the operator.',
        operationId: 'submitCustomerRequest',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('RequestPayload') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({
            $ref: openapiSchemaRef('RequestSubmitted'),
          }),
          '400': openapiErrorResponse('Invalid request payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/notice': {
      post: {
        tags: ['Customer'],
        summary: 'Submit move-out notice',
        description: [
          "Registers the customer's move-out notice for a unit. The unit must belong to the customer (`404` otherwise).",
          '',
          'Additive since 1.1.0: the notice is PERSISTED (one row per submission; the portal reads the latest via ' +
            '`GET /customer/portal` → `data.notice`), and the response additionally echoes `id`, `unitId`, ' +
            '`unitCode` and `submittedAt`. The pre-existing `status`/`lastDay` fields are unchanged.',
        ].join('\n'),
        operationId: 'submitCustomerNotice',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('NoticePayload') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('NoticeSubmitted') }),
          '400': openapiErrorResponse('Invalid notice payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Unit not found for this customer.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/checkout/sessions': {
      post: {
        tags: ['Customer'],
        summary: 'Create a Stripe Checkout Session',
        description: [
          'Creates a Stripe-hosted Checkout Session (TEST MODE only) for an existing booking and returns its id + redirect URL. ',
          'The amount is computed SERVER-SIDE from the booking invoice/unit rate in SGD — the client never sends an amount. ',
          'Idempotent per bookingRef: the booking\'s stored open session is reused and concurrent creates are deduped ',
          '(double-click safe; the session id is persisted on the booking). ',
          'Success redirects to `{BOOKING_APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`; cancel to ',
          '`{BOOKING_APP_URL}/checkout/cancel`.',
          '',
          'Auth: dual-mode like POST /customer/bookings. GUEST bookings (owning customer is type GUEST) need no ',
          'Authorization header; bookings owned by a registered customer require the owner Bearer token (401 without one, ',
          '403 for a different customer; a present-but-invalid token is a hard 401). ',
          'Email-proof bypass (pay gate only, no PII read): an unauthenticated caller whose `email` ',
          'matches the booking customer email (case-insensitive) for that `bookingRef` may create the ',
          'session without login — the unguessable bookingRef plus payer-email possession is the proof. ',
          'An optional `mobile` strengthens the proof when both sides hold a number (digits-only match; ',
          'a mismatch falls back to 401) but is never required. Portal/PII routes (`/me`, `/bookings`, ',
          '`/portal`, `/requests`, `/notice`) stay Bearer-gated and are unaffected.',
          '',
          'Errors: `400 VALIDATION` when `bookingRef` is missing, `404 NOT_FOUND` for an unknown bookingRef, ',
          '`409 CONFLICT` when the booking is cancelled/already paid/has nothing due, `503 STRIPE_NOT_CONFIGURED` when ',
          'Stripe env keys are missing.',
        ].join('\n'),
        operationId: 'createCheckoutSession',
        security: [{ bearerAuth: [] }, []],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('CheckoutSessionRequest') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('CheckoutSession') }),
          '400': openapiErrorResponse(
            'Invalid checkout payload (missing bookingRef).',
          ),
          '401': openapiErrorResponse(
            'Bearer token was supplied but is invalid, or the booking needs owner auth. (Guest bookings need no header.)',
          ),
          '403': openapiErrorResponse(
            'The booking belongs to a different customer.',
          ),
          '404': openapiErrorResponse('Booking not found.'),
          '409': openapiErrorResponse(
            'Booking is cancelled, already paid, or has no amount due.',
          ),
          '503': openapiErrorResponse(
            'Stripe is not configured (STRIPE_SECRET_KEY / BOOKING_APP_URL missing).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/customer/checkout/sessions/{sessionId}': {
      get: {
        tags: ['Customer'],
        summary: 'Verify a Checkout Session',
        description: [
          'Retrieves the session from Stripe and returns its truth — used by the frontend return page to verify payment ',
          '(never trusts client claims). `bookingRef` is echoed from the session metadata (null when absent). No auth required.',
        ].join('\n'),
        operationId: 'getCheckoutSession',
        security: [],
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            description: 'Stripe Checkout Session id (cs_test_…).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            $ref: openapiSchemaRef('CheckoutSessionStatus'),
          }),
          '400': openapiErrorResponse('Missing session id.'),
          '503': openapiErrorResponse(
            'Stripe is not configured (STRIPE_SECRET_KEY missing).',
          ),
          '500': openapiErrorResponse(
            'Unexpected server error (includes unknown Stripe session ids).',
          ),
        },
      },
    },
    '/customer/stripe/webhook': {
      post: {
        tags: ['Customer'],
        summary: 'Stripe webhook receiver',
        description: [
          'Stripe event delivery (TEST MODE only). Verifies the `stripe-signature` header against `STRIPE_WEBHOOK_SECRET` ',
          'using the raw request body — `400 INVALID_SIGNATURE` on mismatch. Handles `checkout.session.completed` by marking ',
          'the booking CONFIRMED and the invoiced session\'s DUE invoice PAID (method `Card`, Stripe session/payment-intent ids, ',
          'paid-at and amount-paid stamped on both rows); all other event types are acknowledged without ',
          'writes. Booking lookup prefers the stored session id (metadata ref as fallback). IDEMPOTENT: retried deliveries are safe no-ops once the booking/invoices are already paid, and other DUE invoices are never touched. No auth header — ',
          'the Stripe signature is the credential.',
        ].join('\n'),
        operationId: 'stripeWebhook',
        security: [],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('WebhookReceived') }),
          '400': openapiErrorResponse(
            'Missing/invalid stripe-signature header.',
          ),
          '503': openapiErrorResponse(
            'Stripe is not configured (STRIPE_WEBHOOK_SECRET missing).',
          ),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    // --- Operator CMS: booking-extras catalog (v1.6.0, additive) ---
    // Protection tiers + packing-supply addons. Served on the CMS host under
    // `/api/v1/cms` with a Bearer JWT. PATCH carries the active toggle
    // (deactivation preferred — bookings snapshot catalog values as free
    // text); DELETE is a hard delete.
    '/cms/protection-plans': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List protection plans (active + inactive)',
        description: 'Every protection-plan row in sortOrder. `?activeOnly=1` narrows to active rows.',
        operationId: 'listProtectionPlans',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('ProtectionPlan') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a protection plan',
        description: 'Creates a tier keyed by its frontend slug (409 on clash). Slug: lowercase letters, numbers, hyphens.',
        operationId: 'createProtectionPlan',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ProtectionPlanInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('ProtectionPlan') }),
          '400': openapiErrorResponse('Invalid protection plan payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '409': openapiErrorResponse('Protection plan id already exists.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/protection-plans/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a protection plan (incl. active toggle)',
        description: 'Partial update. `{ active: false }` deactivates (preferred over delete — hides the tier from public reads, keeps history).',
        operationId: 'updateProtectionPlan',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Protection plan slug (e.g. essential).',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ProtectionPlanInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('ProtectionPlan') }),
          '400': openapiErrorResponse('Invalid protection plan payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Protection plan not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a protection plan (hard delete)',
        description: 'Prefer deactivation (`PATCH { active: false }`) — delete is permanent.',
        operationId: 'deleteProtectionPlan',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Protection plan slug (e.g. essential).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Protection plan not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/addons': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List packing-supply addons (active + inactive)',
        description: 'Every addon row in sortOrder. `?activeOnly=1` narrows to active rows.',
        operationId: 'listAddons',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('Addon') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a packing-supply addon',
        description: 'Creates an addon keyed by its frontend slug (409 on clash). Slug: lowercase letters, numbers, hyphens.',
        operationId: 'createAddon',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AddonInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('Addon') }),
          '400': openapiErrorResponse('Invalid addon payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '409': openapiErrorResponse('Addon id already exists.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/addons/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a packing-supply addon (incl. active toggle)',
        description: 'Partial update. `{ active: false }` deactivates (preferred over delete — hides the addon from public reads, keeps history).',
        operationId: 'updateAddon',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Addon slug (e.g. medium-box).',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AddonInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Addon') }),
          '400': openapiErrorResponse('Invalid addon payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Addon not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a packing-supply addon (hard delete)',
        description: 'Prefer deactivation (`PATCH { active: false }`) — delete is permanent.',
        operationId: 'deleteAddon',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Addon slug (e.g. medium-box).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Addon not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    // --- Operator CMS: facility operations (v1.3.0, additive) ---
    // Served on the CMS host under `/api/v1/cms` with a Bearer JWT.
    '/cms/work-orders': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List maintenance work orders',
        description: [
          'Work orders with branch/unit scope, OPEN → IN_PROGRESS → DONE status and monetary value. ',
          'Optional filters `?status=` and `?branchId=`.',
        ].join('\n'),
        operationId: 'listWorkOrders',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('WorkOrder') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a maintenance work order',
        description: 'Creates a work order (201). Entering DONE stamps `completedAt`.',
        operationId: 'createWorkOrder',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('WorkOrderInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('WorkOrder') }),
          '400': openapiErrorResponse('Invalid work order payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/work-orders/{id}': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Get a work order',
        operationId: 'getWorkOrder',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('WorkOrder') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Work order not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a work order (incl. status transitions)',
        description: 'Partial update. Entering DONE stamps `completedAt`; reopening clears it.',
        operationId: 'updateWorkOrder',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('WorkOrderInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('WorkOrder') }),
          '400': openapiErrorResponse('Invalid work order payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Work order not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a work order',
        operationId: 'deleteWorkOrder',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Work order not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/preventive-tasks': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List preventive checklist tasks',
        description: 'Trade-category tasks (HVAC / Fire / Doors / CCTV) with % complete. Optional `?category=` / `?branchId=`.',
        operationId: 'listPreventiveTasks',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('PreventiveTask') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a preventive task',
        operationId: 'createPreventiveTask',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('PreventiveTaskInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('PreventiveTask') }),
          '400': openapiErrorResponse('Invalid preventive task payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/preventive-tasks/progress': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Preventive % complete per category',
        description: 'Average % complete grouped by HVAC / FIRE / DOORS / CCTV. Optional `?branchId=`.',
        operationId: 'getPreventiveProgress',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('PreventiveProgress') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/preventive-tasks/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a preventive task',
        operationId: 'updatePreventiveTask',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('PreventiveTaskInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('PreventiveTask') }),
          '400': openapiErrorResponse('Invalid preventive task payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Preventive task not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a preventive task',
        operationId: 'deletePreventiveTask',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Preventive task not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/assets': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List asset register rows',
        description: 'Assets with stable codes (e.g. AST-WDL-HVAC-04) + branch link. Optional `?status=` / `?branchId=`.',
        operationId: 'listAssets',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('Asset') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an asset',
        description: 'Asset codes are unique (409 on clash).',
        operationId: 'createAsset',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AssetInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('Asset') }),
          '400': openapiErrorResponse('Invalid asset payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '409': openapiErrorResponse('Asset code already exists.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/assets/{id}': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Get an asset',
        operationId: 'getAsset',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Asset') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Asset not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an asset',
        description: 'The asset code is immutable and cannot be changed.',
        operationId: 'updateAsset',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AssetInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Asset') }),
          '400': openapiErrorResponse('Invalid asset payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Asset not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an asset',
        operationId: 'deleteAsset',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Asset not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/vendors': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List vendor register rows',
        description: 'Vendors with SLA commitment + YTD spend. Optional `?status=`.',
        operationId: 'listVendors',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('Vendor') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a vendor',
        operationId: 'createVendor',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('VendorInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('Vendor') }),
          '400': openapiErrorResponse('Invalid vendor payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/vendors/{id}': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Get a vendor',
        operationId: 'getVendor',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Vendor') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Vendor not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a vendor',
        operationId: 'updateVendor',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('VendorInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Vendor') }),
          '400': openapiErrorResponse('Invalid vendor payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Vendor not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a vendor',
        operationId: 'deleteVendor',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Vendor not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/incidents': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List incidents',
        description: 'Incidents with severity, lifecycle status and branch/unit link. Optional `?severity=` / `?status=` / `?branchId=`.',
        operationId: 'listIncidents',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('Incident') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an incident',
        description: 'Accepts a multi-step resolution checklist (`[{ label, done }, ...]`).',
        operationId: 'createIncident',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('IncidentInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('Incident') }),
          '400': openapiErrorResponse('Invalid incident payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/incidents/{id}': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Get an incident',
        operationId: 'getIncident',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Incident') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Incident not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an incident (incl. status transitions + checklist)',
        description: 'Entering RESOLVED/CLOSED stamps `resolvedAt`; reopening clears it.',
        operationId: 'updateIncident',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('IncidentInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Incident') }),
          '400': openapiErrorResponse('Invalid incident payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Incident not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an incident',
        operationId: 'deleteIncident',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Incident not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/stats': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Access control header stats',
        description: 'Entry / credential / door counts (plus denied and temporary counts). Optional `?branchId=`.',
        operationId: 'getAccessStats',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AccessStats') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/events': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List access events (Live + Exceptions panels)',
        description: 'Newest-first entry log. `?result=DENIED` backs the Exceptions panel; `?limit=` caps rows (1..200, default 50).',
        operationId: 'listAccessEvents',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('AccessEvent') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Record an access event',
        operationId: 'createAccessEvent',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessEventInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('AccessEvent') }),
          '400': openapiErrorResponse('Invalid access event payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/credentials': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List access credentials',
        description: '`?temporary=1` returns only credentials carrying an expiry window (Temporary panel).',
        operationId: 'listCredentials',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('AccessCredential') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an access credential',
        operationId: 'createCredential',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessCredentialInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('AccessCredential') }),
          '400': openapiErrorResponse('Invalid credential payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/credentials/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an access credential',
        operationId: 'updateCredential',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessCredentialInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AccessCredential') }),
          '400': openapiErrorResponse('Invalid credential payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Credential not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an access credential',
        description: 'Credentials with recorded events cannot be deleted (409 — revoke instead).',
        operationId: 'deleteCredential',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Credential not found.'),
          '409': openapiErrorResponse('Credential has access events.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/doors': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List access doors',
        operationId: 'listDoors',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('AccessDoor') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an access door',
        description: 'Door codes are unique (409 on clash).',
        operationId: 'createDoor',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessDoorInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('AccessDoor') }),
          '400': openapiErrorResponse('Invalid door payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '409': openapiErrorResponse('Door code already exists.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/doors/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an access door',
        description: 'The door code is immutable and cannot be changed.',
        operationId: 'updateDoor',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessDoorInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AccessDoor') }),
          '400': openapiErrorResponse('Invalid door payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Door not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an access door',
        description: 'Doors with recorded events cannot be deleted (409).',
        operationId: 'deleteDoor',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Door not found.'),
          '409': openapiErrorResponse('Door has access events.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/policies': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List access policies',
        operationId: 'listPolicies',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('AccessPolicy') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an access policy',
        operationId: 'createPolicy',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessPolicyInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('AccessPolicy') }),
          '400': openapiErrorResponse('Invalid policy payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/access/policies/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an access policy',
        operationId: 'updatePolicy',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AccessPolicyInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AccessPolicy') }),
          '400': openapiErrorResponse('Invalid policy payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Policy not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an access policy',
        operationId: 'deletePolicy',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Policy not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/inspections/checklists': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List inspection checklists',
        description: 'Recurring checklists (daily / monthly / ...) with % complete. Optional `?frequency=` / `?branchId=`.',
        operationId: 'listChecklists',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('InspectionChecklist') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an inspection checklist',
        operationId: 'createChecklist',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('InspectionChecklistInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('InspectionChecklist') }),
          '400': openapiErrorResponse('Invalid checklist payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/inspections/checklists/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an inspection checklist',
        operationId: 'updateChecklist',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('InspectionChecklistInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('InspectionChecklist') }),
          '400': openapiErrorResponse('Invalid checklist payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Checklist not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an inspection checklist',
        operationId: 'deleteChecklist',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Checklist not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/inspections/certificates': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List compliance certificates',
        description: 'Certificates (Fire Safety / Lift / Public Liability / ...) with expiry dates. `?expiring=1` returns only EXPIRING/EXPIRED rows (expiry surfacing).',
        operationId: 'listCertificates',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'array',
            items: { $ref: openapiSchemaRef('ComplianceCertificate') },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a compliance certificate',
        operationId: 'createCertificate',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ComplianceCertificateInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('ComplianceCertificate') }),
          '400': openapiErrorResponse('Invalid certificate payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/inspections/certificates/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a compliance certificate',
        operationId: 'updateCertificate',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('ComplianceCertificateInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('ComplianceCertificate') }),
          '400': openapiErrorResponse('Invalid certificate payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Certificate not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a compliance certificate',
        operationId: 'deleteCertificate',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Certificate not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    // --- Operator CMS: P1 facility extensions (v1.4.0, additive) ---
    // Portfolio overview, net PSF, quotes, move-outs, fees, business rules,
    // users & roles. Served on the CMS host under `/api/v1/cms` with a Bearer
    // JWT issued by `/api/v1/cms/login`.
    '/cms/portfolio': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Portfolio overview (computed)',
        description: [
          'Per-facility sqft totals (totalSqft, leasedSqft, occupancy) plus a portfolio rollup, ',
          'computed from live Unit rows. No stored state.',
        ].join('\n'),
        operationId: 'getPortfolio',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('Portfolio') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/rates/net-psf': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Net rental rate per sqft per facility (computed)',
        description: [
          'Average Unit.monthlyRate/sqft grouped by branch over OCCUPIED + OVERDUE units, ',
          'with MARKET_PSF as a read-only reference and per-size actuals.',
        ].join('\n'),
        operationId: 'getNetPsf',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('NetPsf') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/quotes': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Quotes queue (PROPOSAL_SENT + live inventory)',
        description: [
          'Read-model over PROPOSAL_SENT leads: each quote carries its live AVAILABLE-unit match ',
          'count. No quote table exists by design; stage moves reuse PATCH /leads.',
        ].join('\n'),
        operationId: 'listQuotes',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('Quote') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/quotes/{id}': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Get a quote with concrete unit options',
        operationId: 'getQuote',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('QuoteDetail') }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Lead not found.'),
          '409': openapiErrorResponse('Lead is not in PROPOSAL_SENT.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/move-outs': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Move-outs queue (NOTICE tenants + latest notice)',
        description: 'Read-model over Notice rows + TenantStatus.NOTICE. No auto-transitions.',
        operationId: 'listMoveOuts',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('MoveOut') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/move-outs/{tenantId}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Explicit move-out transition (complete/cancel)',
        description: [
          'complete: NOTICE → INACTIVE + unit released. cancel: NOTICE → ACTIVE, unit untouched. ',
          'The ONLY path that flips tenant status here — Notice submission never does.',
        ].join('\n'),
        operationId: 'transitionMoveOut',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: { action: { type: 'string', enum: ['complete', 'cancel'] } },
              },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('MoveOutResult') }),
          '400': openapiErrorResponse('Invalid move-out action.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Tenant not found.'),
          '409': openapiErrorResponse('Tenant is not on notice.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/fees': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List fee/deposit rules',
        description: 'Optional filters `?kind=` `?key=` `?branchId=` `?active=`.',
        operationId: 'listFees',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('FacilityFee') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create a fee/deposit rule',
        description: 'Scope must agree with its target (FACILITY→branchId, PRODUCT→sizeId, EXCEPTION→tenantId). Gated by fees.manage for permission-holding operators.',
        operationId: 'createFee',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('FacilityFeeInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('FacilityFee') }),
          '400': openapiErrorResponse('Invalid fee payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '403': openapiErrorResponse('Requires permission "fees.manage".'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/fees/resolve': {
      get: {
        tags: ['Operator CMS'],
        summary: 'Resolve the effective fee rule for a context',
        description: 'Collapses Global → Facility → Product → Exception to one rule for `?kind=&key=[&branchId=][&sizeId=][&tenantId=]`. Null when uncovered.',
        operationId: 'resolveFee',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('FacilityFee') }),
          '400': openapiErrorResponse('key is required.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/fees/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update a fee/deposit rule',
        operationId: 'updateFee',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('FacilityFeeInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('FacilityFee') }),
          '400': openapiErrorResponse('Invalid fee payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Fee not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete a fee/deposit rule',
        operationId: 'deleteFee',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('Fee not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/business-rules': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List business rules (stored rows merged over defaults)',
        operationId: 'listBusinessRules',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('BusinessRule') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      put: {
        tags: ['Operator CMS'],
        summary: 'Batch upsert business rules',
        description: 'Unknown keys / invalid values 400 with nothing written. Gated by businessRules.manage for permission-holding operators.',
        operationId: 'upsertBusinessRules',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', description: 'Map of { key: value }.' },
            },
          },
        },
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('BusinessRule') } }),
          '400': openapiErrorResponse('Invalid business-rules payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '403': openapiErrorResponse('Requires permission "businessRules.manage".'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/users': {
      get: {
        tags: ['Operator CMS'],
        summary: 'List operators with facility access + grants',
        operationId: 'listUsers',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('AdminUser') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      post: {
        tags: ['Operator CMS'],
        summary: 'Create an operator',
        description: 'Gated by users.manage for permission-holding operators.',
        operationId: 'createUser',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AdminUserInput') },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({ $ref: openapiSchemaRef('AdminUser') }),
          '400': openapiErrorResponse('Invalid user payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '409': openapiErrorResponse('Admin already exists.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/users/{id}': {
      patch: {
        tags: ['Operator CMS'],
        summary: 'Update an operator (name/role/password)',
        operationId: 'updateUser',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: openapiSchemaRef('AdminUserInput') },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AdminUser') }),
          '400': openapiErrorResponse('Invalid user payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('User not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      delete: {
        tags: ['Operator CMS'],
        summary: 'Delete an operator (never self, never the last)',
        operationId: 'deleteUser',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('User not found.'),
          '409': openapiErrorResponse('Self-deletion or last-operator deletion.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/users/{id}/access': {
      get: {
        tags: ['Operator CMS'],
        summary: "Get an operator's facility access rows",
        operationId: 'getFacilityAccess',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({ type: 'array', items: { $ref: openapiSchemaRef('FacilityAccess') } }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('User not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
      put: {
        tags: ['Operator CMS'],
        summary: "Replace an operator's facility access (empty = unscoped)",
        operationId: 'setFacilityAccess',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['access'],
                properties: {
                  access: { type: 'array', items: { $ref: openapiSchemaRef('FacilityAccessInput') } },
                },
              },
            },
          },
        },
        responses: {
          '200': openapiResponse({ $ref: openapiSchemaRef('AdminUser') }),
          '400': openapiErrorResponse('Invalid access payload.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('User not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/users/{id}/permissions': {
      post: {
        tags: ['Operator CMS'],
        summary: 'Grant a verified permission to an operator',
        operationId: 'grantPermission',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['permission'],
                properties: { permission: { type: 'string', enum: ['promotions.approve', 'fees.manage', 'businessRules.manage', 'users.manage'] } },
              },
            },
          },
        },
        responses: {
          '201': openapiCreatedResponse({
            type: 'object',
            properties: { adminUserId: { type: 'string' }, permission: { type: 'string' } },
          }),
          '400': openapiErrorResponse('Unknown permission.'),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('User not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
    '/cms/users/{id}/permissions/{permission}': {
      delete: {
        tags: ['Operator CMS'],
        summary: 'Revoke a verified permission from an operator',
        operationId: 'revokePermission',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': openapiResponse({
            type: 'object',
            properties: { adminUserId: { type: 'string' }, permission: { type: 'string' } },
          }),
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
          '404': openapiErrorResponse('User not found.'),
          '500': openapiErrorResponse('Unexpected server error'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT returned by POST /customer/register, POST /customer/login or POST /customer/claim.',
      },
    },
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                description:
                  'Machine-readable error code (e.g. VALIDATION, UNAUTHORIZED, NOT_FOUND, CONFLICT, INTERNAL).',
              },
              message: {
                type: 'string',
                description: 'Human-readable error message.',
              },
              details: {
                description:
                  'Optional structured detail (e.g. zod-flattened validation errors).',
              },
            },
          },
        },
      },
      BrowseableUnitStatus: {
        type: 'string',
        enum: ['AVAILABLE', 'RESERVED'],
        description: 'Statuses a public listing can filter on.',
      },
      UnitStatus: {
        type: 'string',
        enum: [
          'OCCUPIED',
          'AVAILABLE',
          'RESERVED',
          'OVERDUE',
          'MAINTENANCE',
          'INACTIVE',
          'BLOCKED',
        ],
        description:
          'Full unit status (P1 adds BLOCKED: held out of inventory — counts toward totals, never leased/browseable). Public listing/map surfaces only ever expose AVAILABLE or RESERVED rows.',
      },
      PublicBranch: {
        type: 'object',
        required: [
          'id',
          'code',
          'name',
          'address',
          'operatingHours',
          'floors',
          'availableUnits',
        ],
        properties: {
          id: { type: 'string' },
          code: {
            type: 'string',
            description: 'Branch code (e.g. BM, WD, UB).',
          },
          name: { type: 'string' },
          address: { type: 'string' },
          operatingHours: { type: 'string' },
          floors: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Distinct floor levels, ascending.',
          },
          availableUnits: {
            type: 'integer',
            description: 'Count of units currently AVAILABLE.',
          },
        },
      },
      PublicBranches: {
        type: 'array',
        items: { $ref: openapiSchemaRef('PublicBranch') },
      },
      PublicUnit: {
        type: 'object',
        required: [
          'id',
          'code',
          'unitCode',
          'name',
          'sqft',
          'rate',
          'psf',
          'status',
          'deletedAt',
          'size',
          'branch',
          'floor',
        ],
        properties: {
          id: { type: 'string', description: 'Database unit id.' },
          code: {
            type: 'string',
            description: 'Unit code (4-digit, e.g. 1001). Alias of unitCode.',
          },
          unitCode: {
            type: 'string',
            description: 'Unit code (4-digit, e.g. 1001).',
          },
          name: {
            type: 'string',
            description: 'Display name; falls back to the unit code.',
          },
          sqft: { type: 'integer' },
          rate: { type: 'number', description: 'Monthly rate (SGD).' },
          psf: { type: 'number', description: 'Rate per square foot.' },
          status: { $ref: openapiSchemaRef('UnitStatus') },
          climateControl: {
            type: ['string', 'null'],
            description:
              'Legacy free-text climate note (e.g. "Ambient climate"); prefer hasAC.',
          },
          hasAC: { type: 'boolean', description: 'True when the unit is air-conditioned.' },
          hasPillar: { type: 'boolean', description: 'True when the unit contains a structural pillar.' },
          deletedAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description:
              'Always null on this surface (deleted units are never listed).',
          },
          size: {
            type: 'object',
            required: ['code', 'name'],
            properties: { code: { type: 'string' }, name: { type: 'string' } },
          },
          branch: {
            type: 'object',
            required: ['code', 'name'],
            properties: { code: { type: 'string' }, name: { type: 'string' } },
          },
          floor: {
            type: 'object',
            required: ['level'],
            properties: { level: { type: 'integer' } },
          },
        },
      },
      UnitMap: {
        type: 'object',
        required: ['branch', 'level', 'legend', 'units'],
        properties: {
          branch: { type: 'string' },
          level: { type: 'integer' },
          legend: {
            type: 'object',
            required: [
              'occupied',
              'available',
              'reserved',
              'overdue',
              'maintenance',
            ],
            properties: {
              occupied: { type: 'integer' },
              available: { type: 'integer' },
              reserved: { type: 'integer' },
              overdue: { type: 'integer' },
              maintenance: { type: 'integer' },
            },
          },
          units: {
            type: 'array',
            items: {
              type: 'object',
              required: [
                'id',
                'code',
                'short',
                'size',
                'psf',
                'rate',
                'sqft',
                'status',
              ],
              properties: {
                id: { type: 'string', description: 'Unit code.' },
                code: { type: 'string', description: 'Unit code.' },
                short: {
                  type: 'string',
                  description:
                    'Unit code without the branch prefix (e.g. 01-01).',
                },
                size: {
                  type: 'string',
                  description: 'Size name (e.g. Small, Medium).',
                },
                psf: { type: 'number' },
                rate: { type: 'number', description: 'Monthly rate (SGD).' },
                sqft: { type: 'integer' },
                status: {
                  type: 'string',
                  description:
                    'Lowercased unit status (e.g. available, occupied; tenant omitted on the public surface).',
                },
              },
            },
          },
        },
      },
      Promotion: {
        type: 'object',
        required: ['code', 'name', 'discountType', 'discountValue'],
        properties: {
          code: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          discountType: { type: 'string', enum: ['PERCENTAGE', 'FLAT'] },
          discountValue: {
            type: 'number',
            description: 'Percent (PERCENTAGE) or fixed SGD amount (FLAT).',
          },
          minMonths: {
            type: ['integer', 'null'],
            description: 'Minimum lease months the code applies to.',
          },
          type: {
            type: 'string',
            enum: ['PERCENTAGE', 'DOLLAR', 'FLAT', 'CREDITS'],
            description: 'Additive v1.5.2: frontend-tolerant promo type token.',
          },
          appliesTo: {
            type: 'string',
            description: 'Additive v1.5.2: scope token (FIRST_MONTH / ONE_TIME / DUE_TODAY / RECURRING).',
          },
          durationScope: {
            type: 'string',
            description: 'Additive v1.5.2: scope token (FIRST_MONTH / ONE_TIME / DUE_TODAY / RECURRING).',
          },
        },
      },
      ValidatePromotionRequest: {
        type: 'object',
        required: ['code', 'rate', 'months'],
        properties: {
          code: { type: 'string', minLength: 1 },
          rate: {
            type: 'number',
            minimum: 0,
            description: 'Monthly rate to apply the promo against.',
          },
          months: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Lease length in months.',
          },
        },
      },
      PromotionValidationResult: {
        type: 'object',
        required: ['valid', 'discountAmt', 'monthlyAfterPromo'],
        properties: {
          valid: { type: 'boolean' },
          discountAmt: {
            type: 'number',
            description: 'Discount amount in SGD (0 when invalid).',
          },
          monthlyAfterPromo: {
            type: 'number',
            description: 'Rate minus discount.',
          },
          type: {
            type: 'string',
            enum: ['PERCENTAGE', 'DOLLAR', 'FLAT', 'CREDITS'],
            description: 'Additive v1.5.2: frontend-tolerant promo type token (stable defaults on the invalid path).',
          },
          appliesTo: {
            type: 'string',
            description: 'Additive v1.5.2: scope token (FIRST_MONTH / ONE_TIME / DUE_TODAY / RECURRING).',
          },
          durationScope: {
            type: 'string',
            description: 'Additive v1.5.2: scope token (FIRST_MONTH / ONE_TIME / DUE_TODAY / RECURRING).',
          },
        },
      },
      PublicPromotionPlanCell: {
        type: 'object',
        required: ['sizeCategory', 'commitmentMonths', 'discountPct'],
        properties: {
          sizeCategory: {
            type: 'string',
            description: 'Size category (LOCKER / SMALL / MEDIUM / LARGE / XL / XXL; legacy XS reads as LOCKER).',
          },
          commitmentMonths: {
            type: 'integer',
            enum: [1, 3, 6, 12],
            description: 'Commitment tier in months.',
          },
          discountPct: {
            type: 'number',
            description: 'Discount percent (0–100).',
          },
          accessType: {
            type: 'string',
            description: 'Additive: access tier (e.g. Ground floor / Standard) disambiguating the two cells that share a size × month key. Builder authors Standard only; Ground floor is legacy read-only.',
          },
        },
      },
      PublicPromotionPlan: {
        type: 'object',
        required: ['id', 'name', 'status', 'cells'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: {
            type: 'string',
            enum: ['ACTIVE'],
            description: 'Always ACTIVE on this surface — DRAFT / SCHEDULED / ENDED plans are excluded.',
          },
          cells: {
            type: 'array',
            items: { $ref: openapiSchemaRef('PublicPromotionPlanCell') },
            description: 'Discount-matrix cells, sorted by commitmentMonths, then sizeCategory, then accessType.',
          },
        },
      },
      // --- Booking-extras catalog (v1.6.0, additive) ---
      ProtectionPlan: {
        type: 'object',
        required: ['id', 'name', 'price', 'coverage', 'sortOrder', 'active'],
        description:
          'A CMS-editable protection tier (monthly recurring price). `id` is the stable frontend slug.',
        properties: {
          id: { type: 'string', description: 'Stable slug, e.g. essential / standard / enhanced / premium.' },
          name: { type: 'string', description: 'Display name, e.g. Essential.' },
          price: { type: 'number', description: 'Monthly recurring price (SGD).' },
          coverage: { type: ['string', 'null'], description: 'Short coverage description shown at checkout.' },
          sortOrder: { type: 'integer', description: 'Ascending display order.' },
          active: { type: 'boolean', description: 'False = hidden from public reads, kept for history.' },
        },
      },
      ProtectionPlanInput: {
        type: 'object',
        required: ['id', 'name', 'price'],
        description: 'Payload for creating a protection plan (PATCH accepts any subset except id).',
        properties: {
          id: { type: 'string', description: 'URL-safe slug: lowercase letters, numbers, hyphens.' },
          name: { type: 'string' },
          price: { type: 'number', minimum: 0 },
          coverage: { type: ['string', 'null'] },
          sortOrder: { type: 'integer', minimum: 0 },
          active: { type: 'boolean' },
        },
      },
      Addon: {
        type: 'object',
        required: ['id', 'name', 'price', 'unit', 'sortOrder', 'active'],
        description:
          'A CMS-editable packing-supply addon (one-off price). `id` is the stable frontend slug.',
        properties: {
          id: { type: 'string', description: 'Stable slug, e.g. medium-box / disc-padlock.' },
          name: { type: 'string', description: 'Display name, e.g. Medium Box.' },
          price: { type: 'number', description: 'One-off price (SGD).' },
          unit: { type: ['string', 'null'], description: 'Sale unit shown at checkout, e.g. box / each.' },
          sortOrder: { type: 'integer', description: 'Ascending display order.' },
          active: { type: 'boolean', description: 'False = hidden from public reads, kept for history.' },
        },
      },
      AddonInput: {
        type: 'object',
        required: ['id', 'name', 'price'],
        description: 'Payload for creating an addon (PATCH accepts any subset except id).',
        properties: {
          id: { type: 'string', description: 'URL-safe slug: lowercase letters, numbers, hyphens.' },
          name: { type: 'string' },
          price: { type: 'number', minimum: 0 },
          unit: { type: ['string', 'null'] },
          sortOrder: { type: 'integer', minimum: 0 },
          active: { type: 'boolean' },
        },
      },
      PublicLeadRequest: {
        type: 'object',
        required: ['name'],
        description:
          'Booking "Your details" lead capture. All strings are trimmed server-side; empty strings are treated as null. `name` plus at least one of `email`/`mobile` is required.',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          email: { type: ['string', 'null'], format: 'email' },
          mobile: { type: ['string', 'null'], maxLength: 40, description: 'Full international number, e.g. +6591234567.' },
          purpose: {
            type: ['string', 'null'],
            enum: ['personal', 'business'],
            description: 'Maps to PERSONAL|BUSINESS (default PERSONAL; BUSINESS when business or companyName/uen present).',
          },
          companyName: { type: ['string', 'null'], maxLength: 120 },
          uen: { type: ['string', 'null'], maxLength: 40 },
          branchCode: { type: ['string', 'null'], description: 'Branch code (BM/WD/UB, case-insensitive); resolved server-side. Unknown codes are 400.' },
          preferredBranchId: { type: ['string', 'null'], description: 'Branch cuid alternative to branchCode.' },
          preferredSize: { type: ['string', 'null'], maxLength: 40 },
          unitCode: { type: ['string', 'null'], maxLength: 40, description: 'Loose unit reference — stored as a column, never an FK.' },
          moveInDate: { type: ['string', 'null'], description: 'ISO date string; stored as a column.' },
          durationMonths: { type: ['integer', 'null'], minimum: 1, description: 'Stored as a column.' },
          monthlyRate: { type: ['number', 'null'], minimum: 0 },
          message: { type: ['string', 'null'], maxLength: 2000, description: 'Stored as the head of note.' },
          source: {
            type: ['string', 'null'],
            enum: ['WEBSITE', 'WHATSAPP', 'REFERRAL', 'GOOGLE'],
            default: 'WEBSITE',
          },
          consentPdpa: { type: ['boolean', 'null'], description: 'When supplied must be true.' },
          consentMarketing: { type: ['boolean', 'null'] },
          protectionTier: { type: ['string', 'null'], maxLength: 80, description: 'Protection plan id or name.' },
          protectionCost: { type: ['number', 'null'], minimum: 0 },
          addons: {
            type: ['array', 'null'],
            maxItems: 20,
            description: 'Booking addons snapshot (max 20 items).',
            items: {
              type: 'object',
              required: ['name', 'qty', 'price'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                qty: { type: 'integer', minimum: 1 },
                price: { type: 'number', minimum: 0 },
              },
            },
          },
          promoCode: { type: ['string', 'null'], maxLength: 40 },
          promoDiscountAmt: { type: ['number', 'null'], minimum: 0 },
          movingService: { type: ['boolean', 'null'] },
          totalDueToday: { type: ['number', 'null'], minimum: 0 },
          idempotencyKey: { type: ['string', 'null'], maxLength: 80, description: 'Repeat key returns the existing row with 200.' },
        },
      },
      PublicLead: {
        type: 'object',
        required: ['id', 'name', 'type', 'stage', 'source', 'preferredBranchId', 'createdAt'],
        description:
          'Serialized Lead echoed back from POST /public/leads (operator lead shape plus the resolved preferredBranchId).',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['PERSONAL', 'BUSINESS'] },
          segment: { type: ['string', 'null'] },
          size: { type: ['string', 'null'], description: 'Preferred size.' },
          branchCode: { type: 'string', description: 'Resolved branch code (empty when no branch).' },
          branchName: { type: 'string' },
          preferredBranchId: { type: ['string', 'null'], description: 'Resolved branch id (null when no branch).' },
          note: { type: ['string', 'null'], description: 'Message head (pre-v2 rows may also carry legacy `key: value` lines).' },
          stage: { type: 'string', enum: ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'] },
          source: { type: 'string', enum: ['WEBSITE', 'WHATSAPP', 'REFERRAL', 'GOOGLE'] },
          monthlyRate: { type: ['number', 'null'] },
          email: { type: ['string', 'null'] },
          mobile: { type: ['string', 'null'] },
          owner: { type: ['string', 'null'] },
          nextActionAt: { type: ['string', 'null'], format: 'date-time' },
          lossReason: { type: ['string', 'null'] },
          lossValue: { type: ['number', 'null'] },
          unitCode: { type: ['string', 'null'] },
          moveInDate: { type: ['string', 'null'], format: 'date-time' },
          durationMonths: { type: ['integer', 'null'] },
          companyName: { type: ['string', 'null'] },
          uen: { type: ['string', 'null'] },
          consentPdpa: { type: ['boolean', 'null'] },
          consentMarketing: { type: ['boolean', 'null'] },
          protectionTier: { type: ['string', 'null'] },
          protectionCost: { type: ['number', 'null'] },
          addons: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              required: ['name', 'qty', 'price'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                qty: { type: 'integer' },
                price: { type: 'number' },
              },
            },
          },
          promoCode: { type: ['string', 'null'] },
          promoDiscountAmt: { type: ['number', 'null'] },
          movingService: { type: ['boolean', 'null'] },
          totalDueToday: { type: ['number', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          daysSince: { type: 'integer' },
        },
      },
      RegisterRequest: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
          mobile: { type: 'string' },
          password: { type: 'string', minLength: 6, format: 'password' },
          type: {
            type: 'string',
            enum: ['PERSONAL', 'BUSINESS'],
            default: 'PERSONAL',
          },
          companyName: {
            type: 'string',
            description: 'Required for BUSINESS accounts.',
          },
          uen: {
            type: 'string',
            description: 'Business registration number (UEN).',
          },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1, format: 'password' },
        },
      },
      ClaimRequest: {
        type: 'object',
        required: ['email', 'bookingRef', 'mobile', 'password'],
        description:
          'Guest portal-password setup. The bookingRef acts as the out-of-band secret; email + mobile must match the booking.',
        properties: {
          email: {
            type: 'string',
            format: 'email',
            description: 'Email the booking was made with (case-insensitive).',
          },
          bookingRef: {
            type: 'string',
            minLength: 1,
            description: 'Booking reference from the confirmation, e.g. SL-2026-0912.',
          },
          mobile: {
            type: 'string',
            minLength: 6,
            description:
              'Mobile the booking was made with; compared digit-for-digit (formatting/spaces ignored).',
          },
          password: {
            type: 'string',
            minLength: 6,
            format: 'password',
            description: 'New portal password; replaces the shared guest default.',
          },
        },
      },
      Customer: {
        type: 'object',
        required: ['id', 'name', 'email', 'type'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          mobile: { type: ['string', 'null'] },
          type: { type: 'string', enum: ['PERSONAL', 'BUSINESS'] },
          companyName: { type: ['string', 'null'] },
          uen: { type: ['string', 'null'] },
        },
      },
      AuthResponse: {
        type: 'object',
        required: ['token', 'customer'],
        properties: {
          token: {
            type: 'string',
            description: 'JWT. Send as `Authorization: Bearer <token>`.',
          },
          customer: { $ref: openapiSchemaRef('Customer') },
        },
      },
      BookingStatus: {
        type: 'string',
        enum: ['PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'CANCELLED'],
      },
      BookingSummary: {
        type: 'object',
        required: [
          'bookingRef',
          'status',
          'moveInDate',
          'duration',
          'amount',
          'unitCode',
          'sqft',
          'branchName',
        ],
        properties: {
          bookingRef: { type: 'string', description: 'e.g. SL-2026-0912.' },
          status: { $ref: openapiSchemaRef('BookingStatus') },
          moveInDate: { type: 'string', format: 'date-time' },
          duration: { type: 'string', description: 'e.g. "3 months".' },
          amount: { type: 'number', description: 'Amount (SGD).' },
          unitCode: { type: 'string' },
          sqft: { type: 'integer' },
          branchName: { type: 'string' },
        },
      },
      CustomerWithBookings: {
        type: 'object',
        required: ['customer', 'bookings'],
        properties: {
          customer: { $ref: openapiSchemaRef('Customer') },
          bookings: {
            type: 'array',
            items: { $ref: openapiSchemaRef('BookingSummary') },
          },
        },
      },
      CreateBookingRequest: {
        type: 'object',
        required: ['unitCode', 'moveInDate', 'durationMonths'],
        properties: {
          unitCode: {
            type: 'string',
            minLength: 1,
            description: 'e.g. BM-01-01.',
          },
          moveInDate: {
            type: 'string',
            format: 'date-time',
            description: 'ISO-8601 datetime of the move-in.',
          },
          durationMonths: { type: 'integer', minimum: 1 },
          protectionPlan: {
            type: 'object',
            required: ['tier', 'cost'],
            properties: {
              tier: { type: 'string' },
              cost: { type: 'number', minimum: 0 },
            },
          },
          addons: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'qty', 'price'],
              properties: {
                name: { type: 'string' },
                qty: { type: 'integer', minimum: 0 },
                price: { type: 'number', minimum: 0 },
              },
            },
          },
          promoCode: { type: 'string' },
          movingService: { type: 'boolean' },
          totalDueToday: {
            type: 'number',
            minimum: 0,
            description:
              'Client hint for the due-today total. The invoiced figure is recomputed server-side ' +
              '(unit rate minus validated promo plus catalog protection/addon prices); a hint below ' +
              'server pricing is rejected with 400 VALIDATION. Omit to invoice server pricing directly.',
          },
          email: {
            type: 'string',
            format: 'email',
            description:
              'Guest checkout only (no Authorization header): the booker is found-or-created by this email — new customers are saved with type GUEST and a bcrypt-hashed default password. Required when unauthenticated.',
          },
          name: {
            type: 'string',
            description: 'Guest checkout only. Used when creating a new guest customer; existing accounts are never overwritten.',
          },
          mobile: {
            type: 'string',
            description: 'Guest checkout only. Same find-or-create rules as name.',
          },
        },
      },
      BookingCreated: {
        type: 'object',
        required: ['bookingRef', 'status', 'unit', 'moveInDate', 'amount'],
        properties: {
          bookingRef: { type: 'string', description: 'e.g. SL-2026-0912.' },
          status: {
            type: 'string',
            enum: ['PENDING_PAYMENT'],
            description: 'Always PENDING_PAYMENT on creation.',
          },
          unit: {
            type: 'object',
            required: ['code', 'sqft', 'rate'],
            properties: {
              code: { type: 'string' },
              sqft: { type: 'integer', description: 'Square footage.' },
              rate: { type: 'number', description: 'Monthly rate (SGD).' },
            },
          },
          moveInDate: { type: 'string', format: 'date-time' },
          amount: { type: 'number', description: 'Booking amount (SGD).' },
        },
      },
      PortalUnit: {
        type: 'object',
        required: [
          'id',
          'code',
          'size',
          'sqft',
          'rate',
          'psf',
          'status',
          'branchName',
          'level',
        ],
        properties: {
          id: {
            type: 'string',
            description: 'Unit code (used as id on this surface).',
          },
          code: { type: 'string', description: 'Unit code.' },
          size: { type: 'string', description: 'Size name.' },
          sqft: { type: 'integer' },
          rate: { type: 'number', description: 'Monthly rate (SGD).' },
          psf: { type: 'number' },
          status: { $ref: openapiSchemaRef('UnitStatus') },
          branchName: { type: 'string' },
          level: { type: 'integer' },
          climateControl: {
            type: ['string', 'null'],
            description:
              'Legacy free-text climate note (e.g. "Ambient climate"); prefer hasAC.',
          },
          hasAC: { type: 'boolean', description: 'True when the unit is air-conditioned.' },
          hasPillar: { type: 'boolean', description: 'True when the unit contains a structural pillar.' },
          sizeCode: {
            type: 'string',
            description: 'Size code (e.g. LOCKER / SMALL / MEDIUM / LARGE / XL).',
          },
          branch: {
            type: 'object',
            required: ['address', 'operatingHours'],
            description: 'The unit branch location details (additive since 1.1.0).',
            properties: {
              address: { type: 'string' },
              operatingHours: { type: 'string' },
            },
          },
        },
      },
      InvoiceStatus: {
        type: 'string',
        enum: ['PAID', 'DUE', 'OVERDUE'],
      },
      InvoiceSummary: {
        type: 'object',
        required: ['id', 'no', 'amount', 'dueDate', 'status', 'billedMonth'],
        properties: {
          id: { type: 'string' },
          no: {
            type: 'string',
            description: 'Invoice number, e.g. INV-2026-0847.',
          },
          amount: { type: 'number', description: 'Amount (SGD).' },
          dueDate: { type: 'string', format: 'date-time' },
          status: { $ref: openapiSchemaRef('InvoiceStatus') },
          billedMonth: { type: 'string', format: 'date-time' },
          method: {
            type: ['string', 'null'],
            description:
              'Payment method (e.g. Auto-debit, Card, Manual) when known.',
          },
        },
      },
      Portal: {
        type: 'object',
        required: ['customer', 'unit', 'invoices', 'bookings'],
        properties: {
          customer: { $ref: openapiSchemaRef('Customer') },
          unit: {
            $ref: openapiSchemaRef('PortalUnit'),
            nullable: true,
            description:
              "Current unit, else the most recent booking's unit, else null.",
          },
          invoices: {
            type: 'array',
            items: { $ref: openapiSchemaRef('InvoiceSummary') },
          },
          bookings: {
            type: 'array',
            items: { $ref: openapiSchemaRef('BookingSummary') },
          },
          notice: {
            nullable: true,
            description:
              'Latest persisted move-out notice, or null when none was ever submitted (additive since 1.1.0).',
            allOf: [{ $ref: openapiSchemaRef('PortalNotice') }],
          },
          tenancy: {
            type: 'object',
            nullable: true,
            required: ['moveInDate', 'nextPayment'],
            description:
              'The tenancy record dates for this customer; null when the customer has no tenant row (additive since 1.1.0).',
            properties: {
              moveInDate: {
                type: ['string', 'null'],
                format: 'date-time',
                description: 'Tenancy start / move-in date.',
              },
              nextPayment: {
                type: ['string', 'null'],
                format: 'date-time',
                description: 'Next billing date.',
              },
            },
          },
        },
      },
      PortalNotice: {
        type: 'object',
        required: ['id', 'unitId', 'unitCode', 'status', 'lastDay', 'submittedAt'],
        properties: {
          id: { type: 'string', description: 'Notice row id (cuid).' },
          unitId: { type: 'string', description: "Noticed unit's database id." },
          unitCode: { type: 'string', description: "Noticed unit's code, e.g. BM-01-01." },
          status: {
            type: 'string',
            enum: ['SUBMITTED'],
            description:
              'Always SUBMITTED while a notice exists — no workflow state machine yet.',
          },
          lastDay: {
            type: 'string',
            format: 'date-time',
            description: 'Customer-declared final day of tenancy.',
          },
          submittedAt: {
            type: 'string',
            format: 'date-time',
            description: 'When the notice was submitted.',
          },
        },
      },
      RequestPayload: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['UPSIZE', 'DOWNSIZE', 'TRANSFER'] },
          notes: { type: 'string' },
          preferredDate: { type: 'string' },
        },
      },
      RequestSubmitted: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: {
            type: 'string',
            description: 'Lead id stored for the operator.',
          },
          status: { type: 'string', enum: ['SUBMITTED'] },
        },
      },
      NoticePayload: {
        type: 'object',
        required: ['unitId', 'lastDay'],
        properties: {
          unitId: {
            type: 'string',
            minLength: 1,
            description:
              "The unit's database id (not the unit code) — matched against the unit the customer currently occupies or has booked.",
          },
          lastDay: {
            type: 'string',
            format: 'date-time',
            description: 'ISO-8601 datetime of the last day.',
          },
        },
      },
      NoticeSubmitted: {
        type: 'object',
        required: ['status', 'lastDay'],
        properties: {
          status: { type: 'string', enum: ['SUBMITTED'] },
          lastDay: {
            type: 'string',
            format: 'date-time',
            description: 'Echoes the submitted last day as an ISO datetime.',
          },
          id: {
            type: 'string',
            description: 'Persisted notice row id (cuid). Additive since 1.1.0.',
          },
          unitId: {
            type: 'string',
            description: "Noticed unit's database id. Additive since 1.1.0.",
          },
          unitCode: {
            type: 'string',
            description: "Noticed unit's code, e.g. BM-01-01. Additive since 1.1.0.",
          },
          submittedAt: {
            type: 'string',
            format: 'date-time',
            description: 'When the notice was persisted. Additive since 1.1.0.',
          },
        },
      },
      ForgotPasswordRequest: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
      ForgotPasswordResponse: {
        type: 'object',
        required: ['message', 'token'],
        properties: {
          message: { type: 'string' },
          token: { type: 'string' },
        },
      },
      ResetPasswordRequest: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token: { type: 'string' },
          password: { type: 'string', minLength: 6, format: 'password' },
        },
      },
      ResetPasswordResponse: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
        },
      },
      CheckoutSessionRequest: {
        type: 'object',
        required: ['bookingRef'],
        properties: {
          bookingRef: {
            type: 'string',
            minLength: 1,
            description:
              'Booking reference from POST /customer/bookings, e.g. SL-2026-0912.',
          },
          email: {
            type: 'string',
            format: 'email',
            description:
              'Receipt email. Optional — defaults to the booking customer email. When no Bearer token is sent for a registered-customer booking, a matching email is accepted as ownership proof for session creation only.',
          },
          mobile: {
            type: 'string',
            description:
              'Optional extra ownership proof (min 6 digits after stripping non-digits). Never required; when supplied and the booking holds a stored number the digits must match.',
          },
        },
      },
      CheckoutSession: {
        type: 'object',
        required: ['sessionId', 'url'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Stripe Checkout Session id (cs_test_…).',
          },
          url: {
            type: 'string',
            description:
              'Stripe-hosted payment page URL — redirect the customer here.',
          },
        },
      },
      CheckoutSessionStatus: {
        type: 'object',
        required: ['status', 'paymentStatus', 'bookingRef'],
        properties: {
          status: {
            type: 'string',
            description:
              'Stripe session status (open | complete | expired).',
          },
          paymentStatus: {
            type: 'string',
            description:
              'Stripe payment status (unpaid | paid | no_payment_required).',
          },
          bookingRef: {
            type: ['string', 'null'],
            description:
              'Booking reference from the session metadata, null when absent.',
          },
        },
      },
      WebhookReceived: {
        type: 'object',
        required: ['received', 'applied'],
        properties: {
          received: { type: 'boolean', enum: [true] },
          bookingRef: {
            type: ['string', 'null'],
            description:
              'Booking reference from the event metadata (null for non-checkout events).',
          },
          applied: {
            type: 'boolean',
            description:
              'True when this delivery transitioned booking/invoices to paid; false for ignored event types, unknown bookings, or idempotent retries.',
          },
        },
      },
      PlacementInput: {
        type: 'object',
        required: ['x', 'y', 'width', 'height'],
        description:
          'Payload for placing (upserting) a unit on a floor plan. Geometry is in feet (1 grid unit = 1 ft); the drawn area must be within ±15% of the unit\'s sqft.',
        properties: {
          x: { type: 'integer', minimum: 0 },
          y: { type: 'integer', minimum: 0 },
          width: { type: 'integer', minimum: 1 },
          height: { type: 'integer', minimum: 1 },
          stackTier: {
            type: 'integer',
            minimum: 0,
            maximum: 1,
            description:
              'Stacking tier: 0 = ground/sole tier (default), 1 = upper tier of a same-rect locker pair. Omitted keeps the tier on update. Tier 1 requires a tier-0 LOCKER partner on the exact same rect; stacking is lockers-only, at most 2 high.',
          },
          doorEdges: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string', enum: ['N', 'S', 'E', 'W'] },
            description:
              'Authored door compass edges (editor N/S/E/W toggles): omitted keeps the placement\'s edges, null clears back to unauthored (AUTO_ALL_EDGES in metrics), an array replaces. Anything outside N/S/E/W is 400.',
          },
        },
      },
      PlanPlacement: {
        type: 'object',
        required: ['id', 'x', 'y', 'width', 'height', 'stackTier', 'doorEdges', 'unit'],
        description:
          'A unit placed on a floor plan with its grid geometry. Two LOCKER placements may share the exact same rect as a stacked upper/lower pair (stackTier 0 + 1), rendered as one block split by a divider line.',
        properties: {
          id: { type: 'string', description: 'UnitPlacement row id (cuid).' },
          x: { type: 'integer', description: 'Top-left grid-unit x coordinate.' },
          y: { type: 'integer', description: 'Top-left grid-unit y coordinate.' },
          width: { type: 'integer', description: 'Bounding box width in feet (1 grid unit = 1 ft).' },
          height: { type: 'integer', description: 'Bounding box height in feet (1 grid unit = 1 ft).' },
          stackTier: {
            type: 'integer',
            minimum: 0,
            maximum: 1,
            description: 'Stacking tier: 0 = ground/sole tier, 1 = upper tier of a same-rect locker pair.',
          },
          doorEdges: {
            type: ['array', 'null'],
            items: { type: 'string', enum: ['N', 'S', 'E', 'W'] },
            description:
              'Authored door compass edges (N/S/E/W toggles); null = unauthored (metrics falls back to AUTO_ALL_EDGES for this unit).',
          },
          unit: {
            type: 'object',
            required: ['id', 'unitCode', 'name', 'sqft', 'status', 'size'],
            properties: {
              id: { type: 'string' },
              unitCode: { type: 'string' },
              name: { type: 'string', description: 'Display label; falls back to unitCode.' },
              sqft: { type: 'integer' },
              status: { $ref: openapiSchemaRef('UnitStatus') },
              size: {
                type: 'object',
                required: ['code', 'name'],
                properties: {
                  code: { type: 'string' },
                  name: { type: 'string' },
                },
              },
            },
          },
        },
      },
      PlanBlock: {
        type: 'object',
        required: ['id', 'name', 'x', 'y', 'width', 'height', 'doorEdges'],
        description:
          'A user-authored layout-decoration rectangle on a floor plan (e.g. Lift, Stairs, Exit, Walking area). Display only — no business behaviour. Geometry is in feet, the same coordinate space as placements (1 grid unit = 1 ft).',
        properties: {
          id: { type: 'string', description: 'FloorPlanBlock row id (cuid).' },
          name: {
            type: 'string',
            description: 'Operator-given label (e.g. "Lift", "Stair", "Walking area").',
          },
          x: { type: 'integer', description: 'Top-left grid-unit x coordinate.' },
          y: { type: 'integer', description: 'Top-left grid-unit y coordinate.' },
          width: { type: 'integer', description: 'Bounding box width in feet (1 grid unit = 1 ft).' },
          height: { type: 'integer', description: 'Bounding box height in feet (1 grid unit = 1 ft).' },
          color: {
            type: ['string', 'null'],
            description: 'Optional render tint (hex); renderers default to a neutral tone when null.',
          },
          doorEdges: {
            type: ['array', 'null'],
            items: { type: 'string', enum: ['N', 'S', 'E', 'W'] },
            description:
              'Authored door edges round-tripped per region (same keep/clear/replace semantics as placements); blocks are non-leasable so metrics ignores them.',
          },
        },
      },
      BlockInput: {
        type: 'object',
        required: ['name', 'x', 'y', 'width', 'height'],
        description: 'Payload for creating/upserting a plan block.',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          x: { type: 'integer', minimum: 0 },
          y: { type: 'integer', minimum: 0 },
          width: { type: 'integer', minimum: 1 },
          height: { type: 'integer', minimum: 1 },
          color: { type: ['string', 'null'] },
          doorEdges: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string', enum: ['N', 'S', 'E', 'W'] },
            description:
              'Authored door edges round-tripped per region (same keep/clear/replace semantics as placements).',
          },
        },
      },
      PlanBoundary: {
        type: 'object',
        required: ['id', 'label', 'kind', 'points', 'closed', 'sortOrder'],
        description:
          'A facility-boundary line item on a floor plan: an operator-drawn polyline marking the facility layout for line-area UFA / NLA measurement. Vertices are grid-ft [x, y] pairs (1 grid unit = 1 ft); 3+-vertex polylines (open or closed) feed boundaryMetrics, 2-vertex segments contribute 0 until extended/closed.',
        properties: {
          id: { type: 'string', description: 'FloorPlanBoundary row id (cuid).' },
          label: {
            type: 'string',
            description: 'Operator-given line name (e.g. "North wing boundary").',
          },
          kind: {
            type: 'string',
            description: 'Line-kind tag (BOUNDARY today; additive for future kinds).',
          },
          points: {
            type: 'array',
            description: 'Polyline vertices [[x, y], ...] in grid-ft units.',
            items: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'integer' },
            },
          },
          closed: {
            type: 'boolean',
            description: 'True once the loop is closed. Marked-area rule: closed loops AND open 3+-vertex polylines (chord-closed) feed boundaryMetrics; open 2-vertex segments contribute 0 until extended/closed.',
          },
          sortOrder: { type: 'integer', description: 'Stable editor ordering (lowest first).' },
        },
      },
      BoundaryInput: {
        type: 'object',
        description: 'Payload for creating/updating a plan boundary line item (update: omitted fields keep their values).',
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 80 },
          kind: { type: 'string', minLength: 1, maxLength: 24 },
          points: {
            type: 'array',
            minItems: 2,
            maxItems: 500,
            items: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'integer' },
            },
          },
          closed: { type: 'boolean' },
          sortOrder: { type: 'integer', minimum: 0, maximum: 100000 },
        },
      },
      BoundaryMetrics: {
        type: 'object',
        required: ['gla', 'ufa', 'nla', 'unit', 'boundaryClosed'],
        description:
          'Line-area UFA/NLA from the marked facility layout. Marked-area rule: every polyline with 3+ vertices and nonzero shoelace area contributes its chord-closed area (closed loops and open 3+-vertex polylines alike); open 2-vertex segments contribute 0 — never fabricated. facilityAreaSqft = marked gross (same value as gla); UFA = marked gross minus block + solid-structure footprints (thin wall lines excluded); NLA = placed-unit footprints inside the marked loops (both stack tiers count), clamped to UFA. All-zero with boundaryClosed: false when no marked line contributes area. Rounded to 1 decimal. gfaSqft mirrors the plan operator-entered GFA (null when unset); gfaSource tags it USER vs CANVAS.',
        properties: {
          gla: { type: 'number', description: 'Marked gross area (sqft) — same value as facilityAreaSqft, kept for compatibility.' },
          ufa: { type: 'number', description: 'Usable floor area (sqft).' },
          nla: { type: 'number', description: 'Net lettable area (sqft).' },
          unit: { type: 'string', enum: ['sqft'] },
          boundaryClosed: { type: 'boolean', description: 'True when at least one area-contributing marked line exists (closed loop OR open 3+-vertex polyline).' },
          facilityAreaSqft: { type: 'number', description: 'Marked gross facility area (sqft) — same value as gla.' },
          gfaSqft: { type: 'number', nullable: true, description: 'Operator-entered plan GFA (sqft); null when unset.' },
          gfaSource: { type: 'string', enum: ['USER', 'CANVAS'], description: 'USER when gfaSqft is set, CANVAS when the metrics report falls back to the canvas rect.' },
        },
      },
      PublicFloorPlan: {
        type: 'object',
        required: ['branch', 'floor', 'plan'],
        description:
          'A floor\'s layout for the booking renderer: branch + floor + plan canvas (width/height in feet, 1 grid unit = 1 ft, legacy free-form structure JSON, authored `blocks`) + placements joined to unit code/name/size/status. Soft-deleted units are filtered out; no tenant/PII/rates.',
        properties: {
          branch: {
            type: 'object',
            required: ['id', 'code', 'name'],
            properties: {
              id: { type: 'string' },
              code: { type: 'string', description: 'e.g. BM / WD / UB' },
              name: { type: 'string' },
            },
          },
          floor: {
            type: 'object',
            required: ['id', 'level', 'name'],
            properties: {
              id: { type: 'string' },
              level: { type: 'integer' },
              name: { type: 'string' },
            },
          },
          plan: {
            type: 'object',
            nullable: true,
            required: ['id', 'floorId', 'width', 'height', 'structure', 'placements', 'blocks', 'boundaries', 'boundaryMetrics'],
            description:
              'The canvas + decorations when a plan has been authored; null when the floor has no plan yet (renderers should fall back to a synthesized grid).',
            properties: {
              id: { type: 'string' },
              floorId: { type: 'string' },
              width: { type: 'integer', description: 'Canvas width in feet (1 grid unit = 1 ft).' },
              height: { type: 'integer', description: 'Canvas height in feet (1 grid unit = 1 ft).' },
              gfaSqft: { type: 'number', nullable: true, description: 'Operator-entered gross floor area (sqft); null when unset (metrics fall back to the canvas rect).' },
              gfaSource: { type: 'string', enum: ['USER', 'CANVAS'], description: 'USER when gfaSqft is set, CANVAS otherwise.' },
              structure: {
                description:
                  'LEGACY free-form JSONB decorations authored by the operator (walls / corridors / entrance / lift / stairs / fireExit). Kept for old clients; new decorations are authored as `blocks`. Optional.',
              },
              blocks: {
                type: 'array',
                description:
                  'Operator-authored decoration rectangles (lift, stairs, exit, walking area, ...) as uniform name+rect primitives. Display only.',
                items: { $ref: openapiSchemaRef('PlanBlock') },
              },
              boundaries: {
                type: 'array',
                description:
                  'Facility-boundary line-item polylines (grid-ft vertices) in editor sort order.',
                items: { $ref: openapiSchemaRef('PlanBoundary') },
              },
              boundaryMetrics: {
                description:
                  'Line-area UFA/NLA from the marked facility layout (all-zero with boundaryClosed: false when no marked line contributes area).',
                $ref: openapiSchemaRef('BoundaryMetrics'),
              },
              placements: {
                type: 'array',
                description: 'Units placed on the plan with their grid geometry (`stackTier` 0/1 marks a stacked locker pair sharing one rect).',
                items: { $ref: openapiSchemaRef('PlanPlacement') },
              },
            },
          },
        },
      },
      // --- Floor-plan area metrics (v1.5.0, additive; v1.5.1 adds doorEdges/doors/doorSource) ---
      AreaMeasure: {
        type: 'object',
        required: ['q', 'sqft'],
        description:
          'Exact area: `q` is the decimal-string integer in quarter-base-units^2 (exact, never float); `sqft` is the display float.',
        properties: {
          q: { type: 'string', description: 'Exact area in quarter-base-units^2 (decimal string).' },
          sqft: { type: 'number', description: 'Display area in square feet.' },
        },
      },
      MoneyMeasure: {
        type: 'object',
        required: ['cents', 'sgd'],
        description: 'Exact money: integer cents plus 2dp SGD display.',
        properties: {
          cents: { type: 'integer', description: 'Integer cents (1 SGD = 100 cents).' },
          sgd: { type: 'number', description: 'Display SGD (2dp).' },
        },
      },
      MetricsAssumptions: {
        type: 'object',
        required: [
          'measurement_basis',
          'pricing_basis',
          'gla_convention',
          'wall_thickness_ft',
          'residual_tolerance_sqft',
          'min_aisle_width_ft',
          'access_model',
          'ceiling_height_ft',
          'market_rate_source',
          'basis_notes',
        ],
        properties: {
          measurement_basis: { type: 'string', enum: ['CENTERLINE'] },
          pricing_basis: { type: 'string', description: 'Floor-level pricing basis (placements default GROSS).' },
          gla_convention: { type: 'string', description: 'GLA is dual-tagged exclusive (= NLA) and inclusive (= NLA + COMMON).' },
          wall_thickness_ft: {
            type: 'object',
            required: ['partition', 'demising', 'exterior'],
            properties: {
              partition: { type: 'number' },
              demising: { type: 'number' },
              exterior: { type: 'number' },
            },
          },
          residual_tolerance_sqft: { type: 'number', description: 'Always 0.25.' },
          min_aisle_width_ft: { type: 'number', description: 'Always 3.0.' },
          access_model: { type: 'string', description: 'AUTO_ALL_EDGES_SEEDED_ENTRANCE until a unit has authored door edges, then MIXED_AUTHORED_AND_AUTO_SEEDED_ENTRANCE.' },
          ceiling_height_ft: { type: 'number', description: 'Default clear height (no per-unit overrides stored yet).' },
          market_rate_source: { type: 'string', description: 'MARKET_PSF reference table (size -> sgd/sqft/month).' },
          basis_notes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Human-readable basis flags (GPI 100%-occupancy assumption, heuristics, coverage gaps).',
          },
        },
      },
      MetricsUnit: {
        type: 'object',
        required: [
          'regionId', 'unitId', 'unitCode', 'name', 'sizeCode', 'sqft', 'status', 'occupied',
          'climateControlled', 'monthlyRate', 'marketRate', 'nominal', 'gross', 'clear',
          'billable', 'cubicFt', 'kindSource', 'doors', 'doorSource',
        ],
        properties: {
          regionId: { type: 'string' },
          unitId: { type: 'string' },
          unitCode: { type: 'string' },
          name: { type: 'string' },
          sizeCode: { type: 'string' },
          sizeName: { type: 'string' },
          sqft: { type: 'integer' },
          status: { $ref: openapiSchemaRef('UnitStatus') },
          occupied: { type: 'boolean', description: 'OCCUPIED or OVERDUE (revenue convention, no new flags).' },
          climateControlled: { type: 'boolean' },
          monthlyRate: { $ref: openapiSchemaRef('MoneyMeasure') },
          marketRate: { $ref: openapiSchemaRef('MoneyMeasure') },
          marketRateSource: { type: 'string', enum: ['MARKET_PSF', 'ACTUAL_FALLBACK'] },
          nominal: { $ref: openapiSchemaRef('AreaMeasure') },
          gross: { $ref: openapiSchemaRef('AreaMeasure') },
          clear: { $ref: openapiSchemaRef('AreaMeasure') },
          billable: { $ref: openapiSchemaRef('AreaMeasure') },
          nominalVariancePct: { type: ['number', 'null'] },
          nominalVarianceWarn: { type: ['boolean', 'null'] },
          ceilingFt: { type: ['number', 'null'], description: 'Null until per-unit overrides are stored.' },
          cubicFt: { type: 'number', description: 'Cubic capacity (clear area x ceiling).' },
          kindSource: { type: 'string', enum: ['placement', 'heuristic'] },
          doors: {
            type: ['array', 'null'],
            items: { type: 'string', enum: ['N', 'S', 'E', 'W'] },
            description: 'Effective door compass edges driving reachability for this unit.',
          },
          doorSource: { type: 'string', enum: ['authored', 'auto'], description: 'authored = editor N/S/E/W toggles; auto = AUTO_ALL_EDGES fallback.' },
        },
      },
      FloorMetricsReport: {
        type: 'object',
        required: [
          'schema_version', 'geometry_hash', 'facility', 'floor', 'coverage', 'assumptions',
          'geometry', 'boundaryMetrics', 'occupancy', 'revenue', 'unit_mix', 'volumetric', 'units',
          'circulation', 'reachability', 'validation', 'statusBreakdown',
        ],
        description:
          'Live floor-plan area metrics. `geometry` carries GFA/exteriorWall/UFA/NLA/common/dual-tagged GLA/efficiency/loadFactor plus the tessellation balance flag; `occupancy` the physical/sqft/economic triple; `revenue` GPI/actual with the walkable chain; `unit_mix` climate share + size-band area histogram; `volumetric` per-unit + floor cubic capacity.',
        properties: {
          schema_version: { type: 'integer', description: 'Payload schema version (stored on snapshots).' },
          geometry_hash: { type: 'string', description: 'SHA-256 over the canonicalised sorted region set.' },
          facility: {
            type: 'object',
            required: ['id', 'code', 'name'],
            properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' } },
          },
          floor: {
            type: 'object',
            required: ['id', 'level', 'name', 'canvasWidthFt', 'canvasHeightFt'],
            properties: {
              id: { type: 'string' },
              level: { type: 'integer' },
              name: { type: 'string' },
              canvasWidthFt: { type: 'integer' },
              canvasHeightFt: { type: 'integer' },
            },
          },
          coverage: {
            type: 'object',
            required: ['placedUnits', 'totalUnits', 'unplacedUnits', 'unplacedCodes'],
            description: 'Measured population (placed, non-deleted units) vs the whole floor.',
            properties: {
              placedUnits: { type: 'integer' },
              totalUnits: { type: 'integer' },
              unplacedUnits: { type: 'integer' },
              unplacedCodes: { type: 'array', items: { type: 'string' } },
            },
          },
          assumptions: { $ref: openapiSchemaRef('MetricsAssumptions') },
          geometry: {
            type: 'object',
            description: 'Centreline-basis aggregates; every area is an AreaMeasure. gfaSource tags the GFA basis: USER (operator-entered FloorPlan.gfaSqft, driving gfa/efficiency/revenue chain) vs CANVAS (canvas-rect fallback, flagged in basis_notes). ufa/nlaEnclosed/nlaTotal/common are LINE-ONLY (marked-area, authoritative = boundaryMetrics; all-zero with boundaryClosed false, never the whole-canvas rect); nlaOutdoor is 0 under the marked-area model.',
            properties: {
              gfa: { $ref: openapiSchemaRef('AreaMeasure') },
              gfaSource: { type: 'string', enum: ['USER', 'CANVAS'] },
              exteriorWall: { $ref: openapiSchemaRef('AreaMeasure') },
              ufa: { $ref: openapiSchemaRef('AreaMeasure') },
              nlaEnclosed: { $ref: openapiSchemaRef('AreaMeasure') },
              nlaOutdoor: { $ref: openapiSchemaRef('AreaMeasure') },
              nlaTotal: { $ref: openapiSchemaRef('AreaMeasure') },
              common: { $ref: openapiSchemaRef('AreaMeasure') },
              corridorArea: { $ref: openapiSchemaRef('AreaMeasure'), description: 'Additive alias of common (= UFA − NLA, ≥ 0) — Total Corridor Area.' },
              gfaToUfaEfficiencyPct: { type: 'number', description: 'Additive: GFA → UFA efficiency (%) = UFA/GFA*100, zero-division guarded.' },
              ufaToNlaEfficiencyPct: { type: 'number', description: 'Additive: UFA → NLA efficiency (%) = NLA/UFA*100, zero-division guarded.' },
              efficiency: { type: 'number' },
              loadFactor: { type: 'number' },
              derivedCirculation: { $ref: openapiSchemaRef('AreaMeasure') },
              droppedSlivers: { $ref: openapiSchemaRef('AreaMeasure') },
              balanced: { type: 'boolean' },
            },
          },
          boundaryMetrics: {
            description:
              'Authoritative line-only (marked-area) UFA/NLA figures (byte-identical to the plan-read shape; all-zero with boundaryClosed: false when no marked line contributes area).',
            $ref: openapiSchemaRef('BoundaryMetrics'),
          },
          unitGroups: {
            type: 'object',
            description: 'Additive per-size unit groups (owner-confirmed mapping: Locker=LOCKER, XS=SMALL, M=MEDIUM, L=LARGE, XL=missing → 0/0 flagged; overall = sum of all buckets over nominal Unit.sqft).',
            properties: {
              overall: {
                type: 'object',
                properties: { units: { type: 'integer' }, areaSqft: { type: 'number' } },
              },
              groups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    sizeCodes: { type: 'array', items: { type: 'string' } },
                    units: { type: 'integer' },
                    areaSqft: { type: 'number' },
                    areaSharePct: { type: 'number' },
                  },
                },
              },
              notes: { type: 'array', items: { type: 'string' } },
            },
          },
          occupancy: {
            type: 'object',
            description: 'Occupancy triple: physical (count), sqft (billable occupied / NLA), economic (actual / GPI).',
            properties: {
              physical: {
                type: 'object',
                properties: {
                  occupiedUnits: { type: 'integer' },
                  totalUnits: { type: 'integer' },
                  pct: { type: 'number' },
                },
              },
              sqft: {
                type: 'object',
                properties: {
                  occupiedQ: { type: 'string' },
                  occupiedSqft: { type: 'number' },
                  nlaQ: { type: 'string' },
                  nlaSqft: { type: 'number' },
                  pct: { type: 'number' },
                },
              },
              economic: {
                type: 'object',
                properties: {
                  actual: { $ref: openapiSchemaRef('MoneyMeasure') },
                  gpi: { $ref: openapiSchemaRef('MoneyMeasure') },
                  pct: { type: 'number' },
                },
              },
            },
          },
          revenue: {
            type: 'object',
            description: 'GPI at 100% market occupancy + actual contracted rent, with the walkable chain.',
            properties: {
              gpiMonthly: { $ref: openapiSchemaRef('MoneyMeasure') },
              gpiAnnual: { $ref: openapiSchemaRef('MoneyMeasure') },
              actualMonthly: { $ref: openapiSchemaRef('MoneyMeasure') },
              actualAnnual: { $ref: openapiSchemaRef('MoneyMeasure') },
              ratePerSfAnnual: { type: 'number' },
              revpafMonthly: { type: 'number' },
              revpafAnnual: { type: 'number' },
              revpofMonthly: { type: 'number' },
              basisNote: { type: 'string' },
            },
          },
          unit_mix: {
            type: 'object',
            description: 'Climate-controlled area share + size-band histogram by area share.',
            properties: {
              climateControlledQ: { type: 'string' },
              climateControlledSqft: { type: 'number' },
              totalQ: { type: 'string' },
              totalSqft: { type: 'number' },
              climateControlledPct: { type: 'number' },
              bySize: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sizeCode: { type: 'string' },
                    units: { type: 'integer' },
                    areaQ: { type: 'string' },
                    areaSqft: { type: 'number' },
                    areaSharePct: { type: 'number' },
                  },
                },
              },
            },
          },
          volumetric: {
            type: 'object',
            description: 'Cubic capacity per unit (clear area x ceiling override ?? floor height) + floor sums.',
            properties: {
              totalVolumeEighth: { type: 'string' },
              totalCubicFt: { type: 'number' },
              defaultHeightFt: { type: 'number' },
            },
          },
          units: {
            type: 'array',
            items: { $ref: openapiSchemaRef('MetricsUnit') },
          },
          circulation: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                area: { $ref: openapiSchemaRef('AreaMeasure') },
                cells: { type: 'integer' },
                reachable: { type: 'boolean' },
                seedFeet: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' } },
                },
              },
            },
          },
          reachability: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                regionId: { type: 'string' },
                label: { type: 'string' },
                reachable: { type: 'boolean' },
                code: { type: 'string' },
              },
            },
          },
          validation: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                severity: { type: 'string', enum: ['error', 'warn'] },
                region_ids: { type: 'array', items: { type: 'string' } },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      FacilityMetricsReport: {
        type: 'object',
        required: ['facility', 'source', 'floors', 'geometry', 'totals', 'unitGroups', 'basis_notes'],
        description:
          'Facility-level floor-plan rollup: per-floor LIVE reports summed into one aggregate (geometry sums with the NLA≤UFA clamp + guarded efficiencies; DB-wide totals/unitGroups with the owner-confirmed size mapping). Additive — per-floor shapes are unchanged.',
        properties: {
          facility: {
            type: 'object',
            required: ['id', 'code', 'name'],
            properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' } },
          },
          source: { type: 'string', enum: ['LIVE'], description: 'Rollup source: per-floor live reports (snapshots are never summed).' },
          floors: {
            type: 'array',
            description: 'Per-floor contributions (floors without a plan contribute zero geometry).',
            items: {
              type: 'object',
              properties: {
                floorId: { type: 'string' },
                level: { type: 'integer' },
                name: { type: 'string' },
                hasPlan: { type: 'boolean' },
                gfaSqft: { type: 'number' },
                ufaSqft: { type: 'number' },
                nlaSqft: { type: 'number' },
                gfaSource: { type: 'string', enum: ['USER', 'CANVAS'] },
                placedUnits: { type: 'integer' },
                unplacedUnits: { type: 'integer' },
                occupiedUnits: { type: 'integer' },
              },
            },
          },
          floorCount: { type: 'integer' },
          floorsWithPlan: { type: 'integer' },
          floorsWithoutPlan: { type: 'array', items: { type: 'string' } },
          geometry: {
            type: 'object',
            description: 'Summed GFA/UFA/NLA with corridorArea (= common = UFA−NLA), guarded efficiency ratios + pcts.',
            properties: {
              gfa: { $ref: openapiSchemaRef('AreaMeasure') },
              gfaSource: { type: 'string', enum: ['USER', 'CANVAS', 'MIXED'] },
              gfaSourcesByFloor: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { floorId: { type: 'string' }, gfaSource: { type: 'string', enum: ['USER', 'CANVAS'] } },
                },
              },
              ufa: { $ref: openapiSchemaRef('AreaMeasure') },
              nlaEnclosed: { $ref: openapiSchemaRef('AreaMeasure') },
              nlaOutdoor: { $ref: openapiSchemaRef('AreaMeasure') },
              nlaTotal: { $ref: openapiSchemaRef('AreaMeasure') },
              common: { $ref: openapiSchemaRef('AreaMeasure') },
              corridorArea: { $ref: openapiSchemaRef('AreaMeasure') },
              efficiency: { type: 'number' },
              loadFactor: { type: 'number' },
              gfaToUfaEfficiencyPct: { type: 'number' },
              ufaToNlaEfficiencyPct: { type: 'number' },
            },
          },
          totals: {
            type: 'object',
            description: 'Facility sums: unplaced = no-placement units; occupied = OCCUPIED+OVERDUE (RESERVED excluded).',
            properties: {
              totalUnits: { type: 'integer' },
              placedUnits: { type: 'integer' },
              unplacedUnits: { type: 'integer' },
              occupiedUnits: { type: 'integer' },
            },
          },
          unitGroups: {
            type: 'object',
            description: 'Per-size unit groups over nominal Unit.sqft (overall = sum; XL = 0/0, no DB code).',
            properties: {
              overall: {
                type: 'object',
                properties: { units: { type: 'integer' }, areaSqft: { type: 'number' } },
              },
              groups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    sizeCodes: { type: 'array', items: { type: 'string' } },
                    units: { type: 'integer' },
                    areaSqft: { type: 'number' },
                    areaSharePct: { type: 'number' },
                  },
                },
              },
              notes: { type: 'array', items: { type: 'string' } },
            },
          },
          basis_notes: { type: 'array', items: { type: 'string' } },
        },
      },
      MetricsSnapshotInput: {
        type: 'object',
        required: ['effective_date'],
        description: 'Publish a metrics snapshot for an effective date (append-only).',
        properties: {
          effective_date: { type: 'string', description: 'Effective date (YYYY-MM-DD).' },
        },
      },
      MetricsSnapshot: {
        type: 'object',
        required: ['id', 'floorId', 'branchId', 'effectiveDate', 'schemaVersion', 'geometryHash', 'createdAt'],
        description: 'Created snapshot id + keys (append-only row; same date twice yields two rows).',
        properties: {
          id: { type: 'string' },
          floorId: { type: 'string' },
          branchId: { type: 'string' },
          effectiveDate: { type: 'string', description: 'Effective date (YYYY-MM-DD).' },
          schemaVersion: { type: 'integer' },
          geometryHash: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      MetricsSnapshotWithPayload: {
        type: 'object',
        required: ['id', 'floorId', 'branchId', 'effectiveDate', 'schemaVersion', 'geometryHash', 'createdAt', 'payload'],
        description: 'Snapshot history row with the full published FloorMetricsReport payload.',
        properties: {
          id: { type: 'string' },
          floorId: { type: 'string' },
          branchId: { type: 'string' },
          effectiveDate: { type: 'string', description: 'Effective date (YYYY-MM-DD).' },
          schemaVersion: { type: 'integer' },
          geometryHash: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          payload: { $ref: openapiSchemaRef('FloorMetricsReport') },
        },
      },
      // --- Facility operations (v1.3.0, additive) ---
      WorkOrder: {
        type: 'object',
        required: ['id', 'title', 'status', 'value'],
        description: 'Maintenance work order with branch/unit scope and monetary value.',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: ['string', 'null'] },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          unitId: { type: ['string', 'null'] },
          unitCode: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'DONE'] },
          priority: { type: ['string', 'null'] },
          value: { type: 'number', description: 'Job value (SGD).' },
          assignee: { type: ['string', 'null'] },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      WorkOrderInput: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          description: { type: ['string', 'null'] },
          branchId: { type: ['string', 'null'] },
          unitId: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'DONE'] },
          priority: { type: ['string', 'null'] },
          value: { type: 'number', minimum: 0 },
          assignee: { type: ['string', 'null'] },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      PreventiveTask: {
        type: 'object',
        required: ['id', 'title', 'category', 'percentComplete'],
        description: 'Preventive checklist task in one trade category with % complete.',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          category: { type: 'string', enum: ['HVAC', 'FIRE', 'DOORS', 'CCTV'] },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          percentComplete: { type: 'integer', minimum: 0, maximum: 100 },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      PreventiveTaskInput: {
        type: 'object',
        required: ['title', 'category'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          category: { type: 'string', enum: ['HVAC', 'FIRE', 'DOORS', 'CCTV'] },
          branchId: { type: ['string', 'null'] },
          percentComplete: { type: 'integer', minimum: 0, maximum: 100 },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      PreventiveProgress: {
        type: 'object',
        required: ['category', 'tasks', 'percentComplete'],
        properties: {
          category: { type: 'string', enum: ['HVAC', 'FIRE', 'DOORS', 'CCTV'] },
          tasks: { type: 'integer' },
          percentComplete: { type: 'number' },
        },
      },
      Asset: {
        type: 'object',
        required: ['id', 'code', 'name', 'category', 'status'],
        description: 'Asset register row with a stable operator code (e.g. AST-WDL-HVAC-04).',
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string' },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['ACTIVE', 'IN_SERVICE', 'RETIRED'] },
          purchaseDate: { type: ['string', 'null'], format: 'date-time' },
          value: { type: ['number', 'null'] },
        },
      },
      AssetInput: {
        type: 'object',
        required: ['code', 'name', 'category'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 40 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          category: { type: 'string', minLength: 1, maxLength: 40 },
          branchId: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['ACTIVE', 'IN_SERVICE', 'RETIRED'] },
          purchaseDate: { type: ['string', 'null'], format: 'date-time' },
          value: { type: ['number', 'null'], minimum: 0 },
        },
      },
      Vendor: {
        type: 'object',
        required: ['id', 'name', 'ytdSpend', 'status'],
        description: 'Vendor register row with SLA commitment + YTD spend.',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          service: { type: ['string', 'null'] },
          sla: { type: ['string', 'null'] },
          ytdSpend: { type: 'number', description: 'Year-to-date spend (SGD).' },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
          contact: { type: ['string', 'null'] },
        },
      },
      VendorInput: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 160 },
          service: { type: ['string', 'null'] },
          sla: { type: ['string', 'null'] },
          ytdSpend: { type: 'number', minimum: 0 },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
          contact: { type: ['string', 'null'] },
        },
      },
      Incident: {
        type: 'object',
        required: ['id', 'title', 'severity', 'status'],
        description: 'Operational incident with severity, branch/unit link and a multi-step checklist.',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: ['string', 'null'] },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          unitId: { type: ['string', 'null'] },
          unitCode: { type: ['string', 'null'] },
          checklist: { description: 'Multi-step resolution checklist ([{ label, done }, ...]).' },
          checklistProgress: { type: 'number', description: '% of checklist steps done.' },
          reportedBy: { type: ['string', 'null'] },
          resolvedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      IncidentInput: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          description: { type: ['string', 'null'] },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] },
          branchId: { type: ['string', 'null'] },
          unitId: { type: ['string', 'null'] },
          checklist: { description: 'Multi-step resolution checklist ([{ label, done }, ...]).' },
          reportedBy: { type: ['string', 'null'] },
        },
      },
      AccessDoor: {
        type: 'object',
        required: ['id', 'code', 'name', 'status'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          name: { type: 'string' },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
      AccessDoorInput: {
        type: 'object',
        required: ['code', 'name'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 40 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          branchId: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
      AccessCredential: {
        type: 'object',
        required: ['id', 'holderName', 'type', 'status'],
        properties: {
          id: { type: 'string' },
          holderName: { type: 'string' },
          type: { type: 'string', enum: ['PERMANENT', 'TEMPORARY', 'VISITOR'] },
          status: { type: 'string', enum: ['ACTIVE', 'REVOKED', 'EXPIRED'] },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          validFrom: { type: ['string', 'null'], format: 'date-time' },
          validTo: { type: ['string', 'null'], format: 'date-time' },
          expired: { type: 'boolean' },
        },
      },
      AccessCredentialInput: {
        type: 'object',
        required: ['holderName'],
        properties: {
          holderName: { type: 'string', minLength: 1, maxLength: 160 },
          type: { type: 'string', enum: ['PERMANENT', 'TEMPORARY', 'VISITOR'] },
          status: { type: 'string', enum: ['ACTIVE', 'REVOKED', 'EXPIRED'] },
          branchId: { type: ['string', 'null'] },
          validFrom: { type: ['string', 'null'], format: 'date-time' },
          validTo: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      AccessPolicy: {
        type: 'object',
        required: ['id', 'name', 'active'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          scope: { type: ['string', 'null'] },
          active: { type: 'boolean' },
        },
      },
      AccessPolicyInput: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 160 },
          description: { type: ['string', 'null'] },
          scope: { type: ['string', 'null'] },
          active: { type: 'boolean' },
        },
      },
      AccessEvent: {
        type: 'object',
        required: ['id', 'result', 'occurredAt'],
        description: 'Access log entry. `DENIED` rows back the Exceptions sub-panel.',
        properties: {
          id: { type: 'string' },
          doorId: { type: ['string', 'null'] },
          doorCode: { type: ['string', 'null'] },
          doorName: { type: ['string', 'null'] },
          credentialId: { type: ['string', 'null'] },
          holderName: { type: ['string', 'null'] },
          credentialType: { type: ['string', 'null'] },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          result: { type: 'string', enum: ['GRANTED', 'DENIED'] },
          occurredAt: { type: 'string', format: 'date-time' },
          note: { type: ['string', 'null'] },
        },
      },
      AccessEventInput: {
        type: 'object',
        properties: {
          doorId: { type: ['string', 'null'] },
          credentialId: { type: ['string', 'null'] },
          branchId: { type: ['string', 'null'] },
          result: { type: 'string', enum: ['GRANTED', 'DENIED'] },
          occurredAt: { type: 'string', format: 'date-time' },
          note: { type: ['string', 'null'] },
        },
      },
      AccessStats: {
        type: 'object',
        required: ['entries', 'credentials', 'doors', 'denied', 'temporary'],
        properties: {
          entries: { type: 'integer' },
          credentials: { type: 'integer' },
          doors: { type: 'integer' },
          denied: { type: 'integer' },
          temporary: { type: 'integer' },
        },
      },
      InspectionChecklist: {
        type: 'object',
        required: ['id', 'title', 'frequency', 'percentComplete', 'status'],
        description: 'Recurring inspection checklist (daily / monthly / ...) with % complete.',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          items: { description: 'Checklist steps ([{ label, done }, ...]).' },
          steps: { type: 'integer' },
          percentComplete: { type: 'integer', minimum: 0, maximum: 100 },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'DONE'] },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      InspectionChecklistInput: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] },
          branchId: { type: ['string', 'null'] },
          items: { description: 'Checklist steps ([{ label, done }, ...]).' },
          percentComplete: { type: 'integer', minimum: 0, maximum: 100 },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'DONE'] },
          dueDate: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ComplianceCertificate: {
        type: 'object',
        required: ['id', 'name', 'type', 'expiryDate', 'derivedStatus', 'status'],
        description: 'Compliance certificate with expiry date; expiry surfacing reads `derivedStatus` (computed from the date).',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', description: 'e.g. Fire Safety / Lift / Public Liability.' },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          issuer: { type: ['string', 'null'] },
          expiryDate: { type: 'string', format: 'date-time' },
          daysUntilExpiry: { type: 'integer' },
          derivedStatus: { type: 'string', enum: ['VALID', 'EXPIRING', 'EXPIRED'] },
          status: { type: 'string', enum: ['VALID', 'EXPIRING', 'EXPIRED'] },
        },
      },
      ComplianceCertificateInput: {
        type: 'object',
        required: ['name', 'type', 'expiryDate'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 160 },
          type: { type: 'string', minLength: 1, maxLength: 80 },
          branchId: { type: ['string', 'null'] },
          issuer: { type: ['string', 'null'] },
          expiryDate: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['VALID', 'EXPIRING', 'EXPIRED'] },
        },
      },
      // --- P1 facility extensions (v1.4.0, additive) ---
      Portfolio: {
        type: 'object',
        properties: {
          totals: { type: 'object' },
          facilities: { type: 'array', items: { type: 'object' } },
        },
      },
      NetPsf: {
        type: 'object',
        properties: {
          portfolioNetPsf: { type: 'number' },
          marketPsf: { type: 'object' },
          bySize: { type: 'array', items: { type: 'object' } },
          facilities: { type: 'array', items: { type: 'object' } },
        },
      },
      Quote: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          stage: { type: 'string' },
          branchCode: { type: 'string' },
          preferredSize: { type: ['string', 'null'] },
          monthlyRate: { type: ['number', 'null'] },
          matchingAvailable: { type: 'number' },
        },
      },
      QuoteDetail: {
        type: 'object',
        properties: {
          quote: { $ref: openapiSchemaRef('Quote') },
          options: { type: 'array', items: { type: 'object' } },
        },
      },
      MoveOut: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          unitCode: { type: ['string', 'null'] },
          lastDay: { type: ['string', 'null'], format: 'date-time' },
          noticeCount: { type: 'number' },
        },
      },
      MoveOutResult: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          action: { type: 'string' },
          status: { type: 'string' },
          unitReleased: { type: 'boolean' },
        },
      },
      FacilityFee: {
        type: 'object',
        required: ['id', 'kind', 'key', 'scope', 'amount', 'amountKind', 'active'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['FEE', 'DEPOSIT'] },
          key: { type: 'string' },
          scope: { type: 'string', enum: ['GLOBAL', 'FACILITY', 'PRODUCT', 'EXCEPTION'] },
          branchId: { type: ['string', 'null'] },
          sizeId: { type: ['string', 'null'] },
          tenantId: { type: ['string', 'null'] },
          amount: { type: 'number' },
          amountKind: { type: 'string', enum: ['FLAT', 'PCT', 'MONTHS'] },
          active: { type: 'boolean' },
          note: { type: ['string', 'null'] },
        },
      },
      FacilityFeeInput: {
        type: 'object',
        required: ['key', 'amount'],
        properties: {
          kind: { type: 'string', enum: ['FEE', 'DEPOSIT'] },
          key: { type: 'string', minLength: 1, maxLength: 80 },
          scope: { type: 'string', enum: ['GLOBAL', 'FACILITY', 'PRODUCT', 'EXCEPTION'] },
          branchId: { type: ['string', 'null'] },
          sizeId: { type: ['string', 'null'] },
          tenantId: { type: ['string', 'null'] },
          amount: { type: 'number', minimum: 0 },
          amountKind: { type: 'string', enum: ['FLAT', 'PCT', 'MONTHS'] },
          active: { type: 'boolean' },
          note: { type: ['string', 'null'] },
        },
      },
      BusinessRule: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          category: { type: 'string' },
          kind: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          value: {},
          active: { type: 'boolean' },
          customized: { type: 'boolean' },
        },
      },
      AdminUser: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          facilityAccess: { type: 'array', items: { $ref: openapiSchemaRef('FacilityAccess') } },
          permissions: { type: 'array', items: { type: 'string' } },
          scoped: { type: 'boolean' },
        },
      },
      AdminUserInput: {
        type: 'object',
        required: ['email', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['OWNER', 'MANAGER', 'VIEWER'] },
        },
      },
      FacilityAccess: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          branchId: { type: ['string', 'null'] },
          branchCode: { type: ['string', 'null'] },
          branchName: { type: ['string', 'null'] },
          scope: { type: 'string' },
        },
      },
      FacilityAccessInput: {
        type: 'object',
        properties: {
          branchId: { type: ['string', 'null'] },
          scope: { type: 'string', enum: ['FACILITY', 'ALL'] },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers (kept beside the spec for readability; produce OpenAPI 3.0 response
// objects). The envelope mirrors src/lib/http.ts: `ok()` → { data, meta },
// `created()` → 201 { data }.
// ---------------------------------------------------------------------------

function openapiSchemaRef(name: string): string {
  return `#/components/schemas/${name}`;
}

function envelopeSchema(
  dataSchema: unknown,
  metaSchema?: unknown,
): Record<string, unknown> {
  return {
    type: 'object',
    required: ['data'],
    properties: {
      data: dataSchema,
      ...(metaSchema ? { meta: metaSchema } : {}),
    },
  };
}

function openapiResponse(dataSchema: unknown): {
  description: string;
  content: {
    'application/json': { schema: ReturnType<typeof envelopeSchema> };
  };
} {
  return {
    description: 'OK',
    content: { 'application/json': { schema: envelopeSchema(dataSchema) } },
  };
}

function openapiCreatedResponse(dataSchema: unknown): {
  description: string;
  content: {
    'application/json': { schema: ReturnType<typeof envelopeSchema> };
  };
} {
  return {
    description: 'Created',
    content: { 'application/json': { schema: envelopeSchema(dataSchema) } },
  };
}

function openapiErrorResponse(description: string): {
  description: string;
  content: { 'application/json': { schema: { $ref: string } } };
} {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorEnvelope' },
      },
    },
  };
}
