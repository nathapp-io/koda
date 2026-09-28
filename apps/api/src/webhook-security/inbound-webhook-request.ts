import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';

/** The parts of the Fastify request an inbound webhook controller reads. */
export type InboundWebhookRequest = { rawBody?: Buffer; body?: unknown };

/**
 * The bytes the sender signed. Prefer the raw bytes captured by the preParsing
 * hook (KODA-02). Without the hook (Express-based test setups) fall back to the
 * re-serialized body, which the platform round-trips from the same JSON.
 */
export function signedBytesOf(request: InboundWebhookRequest): string {
  return request.rawBody ? request.rawBody.toString('utf8') : JSON.stringify(request.body ?? {});
}

/**
 * Validates an inbound webhook body against a class-validator DTO. Call it only
 * after the signature check, so an unauthenticated caller never sees a
 * validation error. The options mirror the global ValidationPipe.
 */
export async function parseInboundPayload<T extends object>(
  cls: ClassConstructor<T>,
  body: unknown,
): Promise<T> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationAppException({ param: 'body' });
  }

  const instance = plainToInstance(cls, body as Record<string, unknown>);
  const errors = await validate(instance, { forbidUnknownValues: false, stopAtFirstError: true });
  if (errors.length > 0) {
    throw new ValidationAppException({ param: firstErrorPath(errors) });
  }
  return instance;
}

function firstErrorPath(errors: ValidationError[], parent = ''): string {
  const [first] = errors;
  const path = parent ? `${parent}.${first.property}` : first.property;
  return first.children && first.children.length > 0 ? firstErrorPath(first.children, path) : path;
}
