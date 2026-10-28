import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';

/**
 * US-003: the body validation a gated handler runs itself.
 *
 * A gated route validates its input twice — now, before a request is opened, and again when the
 * command runs (the engine re-parses the frozen input). The second run has no HTTP pipe, so the
 * command's `parse` needs the pipe's contract as a function: the same DTO, the same options, the same
 * 400 `approvals.invalidInput`.
 *
 * The options mirror `useAppGlobalPipes()`: `whitelist` drops every property the DTO does not
 * declare (so a body cannot smuggle an undeclared field into the frozen input), `stopAtFirstError`
 * keeps one bad field from producing a pile of messages, and `forbidUnknownValues: false` lets a DTO
 * with no rules pass instead of failing on an unknown-object error.
 */
const BODY_PIPE_OPTIONS = { whitelist: true, stopAtFirstError: true, forbidUnknownValues: false } as const;

/**
 * Validates `raw` as `cls` and answers the plain, whitelisted object the global pipe would hand the
 * handler — never the class instance, so the value stays JSON-serialisable for the frozen request.
 *
 * A body that is not an object (null, an array, a primitive) is the same 400: the pipe never runs
 * for it here, so there is no validation error to report.
 */
export function parseBody<T extends object>(cls: new () => T, raw: unknown): T {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalidInput();

  const instance = plainToInstance(cls, raw);
  if (validateSync(instance, BODY_PIPE_OPTIONS).length > 0) throw invalidInput();

  return instanceToPlain(instance) as T;
}

function invalidInput(): ValidationAppException {
  return new ValidationAppException({}, 'approvals.invalidInput');
}
