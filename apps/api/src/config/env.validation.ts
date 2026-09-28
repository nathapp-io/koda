import * as Joi from 'joi';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseAllowedHosts } from './webhook.config';

const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  API_PORT: Joi.number().integer().default(3100),
  GLOBAL_PREFIX: Joi.string().default('api'),
  DATABASE_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().required().invalid(Joi.ref('JWT_SECRET')),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
  API_KEY_SECRET: Joi.string().required(),
  VCS_ENCRYPTION_KEY: Joi.string().hex().length(64).optional(),
  VCS_DEFAULT_POLLING_INTERVAL_MS: Joi.number().integer().min(60000).optional(),
  GITHUB_API_URL: Joi.string().uri().optional(),
  RAG_IN_MEMORY_ONLY: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .optional(),
  OUTBOX_RELAY_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .optional(),
  OUTBOX_RETENTION_DAYS: Joi.number()
    .integer()
    .min(0)
    .optional(),
  // Digits-only to match the class-validator `@Matches(/^\d+$/)` rule in
  // live.config.ts (`Joi.number()` would coerce '1e3' / '100.0' and diverge).
  LIVE_HEARTBEAT_MS: Joi.string()
    .pattern(/^\d+$/)
    .custom((value: string, helpers) => (Number(value) >= 100 ? value : helpers.error('number.min')))
    .optional(),
  // US-001: `WEBHOOK_ALLOWED_HOSTS` is parsed through `parseAllowedHosts` so a bad
  // entry refuses boot. The custom rule turns the parser's `Error` into a Joi
  // detail keyed on `WEBHOOK_ALLOWED_HOSTS`.
  WEBHOOK_ALLOWED_HOSTS: Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      try {
        parseAllowedHosts(value);
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid value';
        return helpers.error('any.invalid', { message });
      }
    })
    .messages({ 'any.invalid': '{{#message}}' })
    .optional(),
}).unknown(true);

export function validate(config: Record<string, unknown>): Record<string, unknown> {
  const { error, value } = envSchema.validate(config, { abortEarly: false });
  if (error) {
    // Preserve field-level detail (e.g. JWT_REFRESH_SECRET when it equals JWT_SECRET)
    // instead of dropping it into a bare ValidationAppException.
    const args: Record<string, string> = {};
    for (const detail of error.details) {
      const path = detail.path.join('.') || 'config';
      args[path] = detail.message;
    }
    throw new ValidationAppException(args);
  }
  return value as Record<string, unknown>;
}
