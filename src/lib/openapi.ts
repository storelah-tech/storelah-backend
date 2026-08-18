// ---------------------------------------------------------------------------
// StoreLah Booking API — OpenAPI 3.0.3 spec (developer-facing docs).
//
// This spec is the single source of truth for clients of the customer-facing
// API served on api.storelah.sg. It documents ONLY the public + customer
// endpoints consumed by booking.storelah.sg and external integrators; the
// operator CMS API (/api/v1/cms) is deliberately out of scope here.
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
    version: '1.0.0',
    description: [
      'Customer-facing booking API for the StoreLah self-storage business.',
      '',
      'Public endpoints under `/public/branches`, `/public/units`, `/public/promotions` need no ' +
        'authentication. Customer endpoints under `/customer/*` require ',
      '`Authorization: Bearer <token>` with a JWT issued by `POST /customer/register` or ',
      '`POST /customer/login` (default lifetime 12h).',
      '',
      '**Envelope:** successful responses are `{ data, meta? }`; errors are ',
      '`{ error: { code, message, details? } }`. Codes seen below: `VALIDATION`, `UNAUTHORIZED`, ',
      '`NOT_FOUND`, `CONFLICT`, `INTERNAL`.',
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
    '/public/floor-plans/{branchCode}/{level}': {
      get: {
        tags: ['Public'],
        summary: 'Get a floor\'s floor plan',
        description: [
          'The authored layout for one branch floor, for the booking app to render real unit positions: plan canvas ',
          '(width/height in LOGICAL GRID UNITS) + free-form `structure` decorations + placements joined to unit ',
          '`unitCode`/`name`/`size`/`status`.',
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
          'raised for `totalDueToday` (or the unit monthly rate when omitted).',
          '',
          'Errors: `404 NOT_FOUND` when the unit code is unknown, `409 CONFLICT` when the unit is not AVAILABLE/RESERVED.',
        ].join('\n'),
        operationId: 'createCustomerBooking',
        security: [{ bearerAuth: [] }],
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
          '401': openapiErrorResponse('Missing/invalid bearer token.'),
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
        description:
          'Consolidated portal data: customer, their current unit (or the most recently booked one), invoices, and bookings.',
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
        description:
          "Registers the customer's move-out notice for a unit. The unit must belong to the customer (`404` otherwise).",
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
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT returned by POST /customer/register or POST /customer/login.',
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
        ],
        description:
          'Full unit status. Public listing/map surfaces only ever expose AVAILABLE or RESERVED rows.',
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
            description: 'Unit code (e.g. BM-01-01). Alias of unitCode.',
          },
          unitCode: {
            type: 'string',
            description: 'Unit code (e.g. BM-01-01).',
          },
          name: {
            type: 'string',
            description: 'Display name; falls back to the unit code.',
          },
          sqft: { type: 'integer' },
          rate: { type: 'number', description: 'Monthly rate (SGD).' },
          psf: { type: 'number', description: 'Rate per square foot.' },
          status: { $ref: openapiSchemaRef('UnitStatus') },
          climateControl: { type: ['string', 'null'] },
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
              'Amount invoiced on booking. Defaults to the unit monthly rate when omitted.',
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
        },
      },
      PublicFloorPlan: {
        type: 'object',
        required: ['branch', 'floor', 'plan'],
        description:
          'A floor\'s layout for the booking renderer: branch + floor + plan canvas (width/height in logical grid units, free-form structure JSON) + placements joined to unit code/name/size/status. Soft-deleted units are filtered out; no tenant/PII/rates.',
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
            required: ['id', 'floorId', 'width', 'height', 'placements'],
            description:
              'The canvas + decorations when a plan has been authored; null when the floor has no plan yet (renderers should fall back to a synthesized grid).',
            properties: {
              id: { type: 'string' },
              floorId: { type: 'string' },
              width: { type: 'integer', description: 'Canvas width in logical grid units.' },
              height: { type: 'integer', description: 'Canvas height in logical grid units.' },
              structure: {
                description:
                  'Free-form JSONB decorations authored by the operator (walls / corridors / entrance / lift / stairs / fireExit). Optional.',
              },
              placements: {
                type: 'array',
                description: 'Units placed on the plan with their grid geometry.',
                items: {
                  type: 'object',
                  required: ['id', 'x', 'y', 'width', 'height', 'unit'],
                  properties: {
                    id: { type: 'string' },
                    x: { type: 'integer', description: 'Top-left grid-unit x coordinate.' },
                    y: { type: 'integer', description: 'Top-left grid-unit y coordinate.' },
                    width: { type: 'integer', description: 'Bounding box width in grid units.' },
                    height: { type: 'integer', description: 'Bounding box height in grid units.' },
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
              },
            },
          },
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
