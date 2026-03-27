import * as Joi from 'joi';

const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  API_PORT: Joi.number().integer().default(3100),
  GLOBAL_PREFIX: Joi.string().default('api'),
  DATABASE_URL: Joi.string().required(),
  DATABASE_PROVIDER: Joi.string()
    .valid('sqlite', 'postgresql', 'mysql')
    .default('sqlite'),
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),
  API_KEY_SECRET: Joi.string().required(),
  RAG_IN_MEMORY_ONLY: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .optional(),
}).unknown(true);

export function validate(config: Record<string, unknown>): Record<string, unknown> {
  const { error, value } = envSchema.validate(config, { abortEarly: false });
  if (error) {
    throw new Error(
      `Config validation error: ${error.details.map((d) => d.message).join(', ')}`,
    );
  }
  return value as Record<string, unknown>;
}
