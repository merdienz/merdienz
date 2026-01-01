import { SINGLE_EMAIL_RE, EMAIL_MAX_LENGTH } from './email-address.js';

export const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const NO_NUL = '^[^\u0000]*$';
const NO_CONTROLS = '^[^\u0000-\u001F\u007F]+$';

/** A string schema that always rejects NUL, optionally with an extra pattern. */
export function str(opts = {}) {
  const { pattern, allOf, ...rest } = opts;
  const parts = [{ pattern: NO_NUL }];
  if (pattern) parts.push({ pattern });
  if (Array.isArray(allOf)) parts.push(...allOf);
  return { type: 'string', ...rest, allOf: parts };
}

/** Site and heartbeat names: no C0 controls or DEL. */
export function nameStr(opts = {}) {
  const { minLength = 1, maxLength = 200, ...rest } = opts;
  return str({ minLength, maxLength, pattern: NO_CONTROLS, ...rest });
}

export const errorBody = {
  type: 'object',
  additionalProperties: true,
  properties: {
    error: str(),
    code: str(),
  },
};

export const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: str({ pattern: UUID }),
  },
};

export const uuidParams = {
  type: 'object',
  required: ['uuid'],
  additionalProperties: false,
  properties: {
    uuid: str({ pattern: UUID }),
  },
};

export const healthSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, role: str() },
    },
  },
};

export const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: str({ minLength: 1, maxLength: 320 }),
      password: str({ minLength: 1, maxLength: 1024 }),
    },
  },
};

export const setupSchema = {
  body: {
    type: 'object',
    required: ['token', 'email', 'password'],
    additionalProperties: false,
    properties: {
      token: str({ minLength: 8, maxLength: 256 }),
      email: str({ minLength: 3, maxLength: EMAIL_MAX_LENGTH, pattern: SINGLE_EMAIL_RE.source }),
      password: str({ minLength: 8, maxLength: 1024 }),
    },
  },
};

export const signupSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: str({ minLength: 1, maxLength: 400 }),
      password: str({ minLength: 1, maxLength: 1024 }),
    },
  },
};

export const siteCreateSchema = {
  body: {
    type: 'object',
    required: ['name', 'url'],
    additionalProperties: false,
    properties: {
      name: nameStr(),
      url: str({ minLength: 1, maxLength: 2048 }),
      interval_seconds: { type: 'integer', minimum: 1, maximum: 86400 },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      up_status_codes: str({ minLength: 1, maxLength: 100 }),
      public_on_status: { type: 'boolean' },
      tier: {},
    },
  },
};

export const heartbeatCreateSchema = {
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: nameStr(),
      period_seconds: { type: 'integer', minimum: 1, maximum: 30 * 24 * 3600 },
      cron_expr: str({ minLength: 1, maxLength: 200 }),
      timezone: str({ minLength: 1, maxLength: 100 }),
      grace_seconds: { type: 'integer', minimum: 0, maximum: 7 * 24 * 3600 },
      public_on_status: { type: 'boolean' },
      tier: {},
    },
  },
};

export const statusSlugParams = {
  type: 'object',
  required: ['slug'],
  additionalProperties: false,
  properties: {
    slug: str({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9-]+$' }),
  },
};

export const statusPageUpsertSchema = {
  body: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: str({ minLength: 1, maxLength: 200 }),
      slug: str({ minLength: 1, maxLength: 80 }),
      tier: {},
      plan: {},
    },
  },
};

export const statusPageCreateSchema = {
  body: {
    type: 'object',
    required: ['title', 'slug'],
    additionalProperties: false,
    properties: {
      title: str({ minLength: 1, maxLength: 200 }),
      slug: str({ minLength: 1, maxLength: 80 }),
      tier: {},
      plan: {},
    },
  },
};

export const statusPagePatchSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: str({ minLength: 1, maxLength: 200 }),
      slug: str({ minLength: 1, maxLength: 80 }),
      tier: {},
      plan: {},
    },
  },
};

export const sitePatchSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      public_on_status: { type: 'boolean' },
      interval_seconds: { type: 'integer', minimum: 1, maximum: 86400 },
      tier: {},
      plan: {},
    },
  },
};

export const heartbeatPatchSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      public_on_status: { type: 'boolean' },
      period_seconds: { type: ['integer', 'null'], minimum: 1, maximum: 30 * 24 * 3600 },
      cron_expr: { anyOf: [{ type: 'null' }, str({ minLength: 1, maxLength: 200 })] },
      timezone: str({ minLength: 1, maxLength: 100 }),
      grace_seconds: { type: 'integer', minimum: 0, maximum: 7 * 24 * 3600 },
      tier: {},
      plan: {},
    },
  },
};

export const probeSchema = {
  body: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: str({ minLength: 1, maxLength: 2048 }),
      timeout_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      up_status_codes: str({ minLength: 1, maxLength: 100 }),
    },
  },
};

export const emptyBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
};

export const pingQuerySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    exit: { type: 'string', pattern: '^(0|[1-9]\\d{0,2})$' },
  },
};
