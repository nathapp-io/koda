/**
 * US-003 AC-1..AC-3 — `parseBody` is the global pipe's validation for a body a gated handler
 * validates itself (a route command parses the same input on the immediate and the deferred path).
 */
import { ValidationAppException } from '@nathapp/nestjs-common';
import { CreateRoleDto } from '../../permissions/dto/role.dto';
import { parseBody } from './parse-body';

/** Runs `parseBody` and returns whatever it threw (null when it did not throw). */
function errorOf(raw: unknown): unknown {
  try {
    parseBody(CreateRoleDto, raw);
    return null;
  } catch (error) {
    return error;
  }
}

function expectInvalidInput(raw: unknown): void {
  const error = errorOf(raw);

  expect(error).toBeInstanceOf(ValidationAppException);
  expect((error as ValidationAppException).prefix).toBe('approvals.invalidInput');
  expect((error as ValidationAppException).httpStatus).toBe(400);
}

describe('parseBody', () => {
  it('AC-1: answers the plain whitelisted object the global pipe hands a handler', () => {
    const parsed = parseBody(CreateRoleDto, {
      key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'], extra: 1,
    });

    expect(parsed).toEqual({ key: 'qa', name: 'QA', scope: 'GLOBAL', permissions: ['role.read'] });
    expect('extra' in parsed).toBe(false);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('AC-2: a body that fails the DTO rules is an approvals.invalidInput 400', () => {
    expectInvalidInput({ name: 'QA', scope: 'GLOBAL', permissions: [] });
  });

  it('AC-3: a null body is the same 400', () => {
    expectInvalidInput(null);
  });

  it('rejects the other non-object bodies with the same 400', () => {
    for (const raw of [undefined, [], 'QA', 42, true]) expectInvalidInput(raw);
  });

  it('accepts a DTO with no validation rules for the given body shape', () => {
    class Empty {
      label?: string;
    }

    expect(parseBody(Empty, { label: 'x', other: 2 })).toEqual({});
  });
});
