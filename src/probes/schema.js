export const probeSchema = {
  body: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 2048 },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      up_status_codes: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
};

export const healthSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, role: { type: 'string' } },
    },
  },
};
