import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { assertRotationGiven, UpdateGitlabCredentialsDto } from './update-gitlab-credentials.dto';

/**
 * US-005: the body of the GitLab credential rotation, validated the way the HTTP pipe and
 * `parseBody` validate it (`whitelist`, `stopAtFirstError`).
 *
 * A token may be left out — a partial rotation replaces only the token it names — but a token that
 * is *there* has to be a string: `null` is a malformed token, not an absent one. `@IsOptional` would
 * wave `null` through, so the token fields are guarded by `@ValidateIf(value !== undefined)` instead
 * (fix round 1, F1).
 */
const PIPE_OPTIONS = { whitelist: true, stopAtFirstError: true, forbidUnknownValues: false } as const;

/**
 * The properties the pipe refuses. `stopAtFirstError` reports one constraint per field, and which
 * one fires first is class-validator's business — so a case asserts *which field* is refused, not
 * which rule happened to catch it.
 */
const refused = (body: unknown): string[] => validateSync(
  plainToInstance(UpdateGitlabCredentialsDto, body),
  PIPE_OPTIONS,
).map((error) => error.property);

describe('UpdateGitlabCredentialsDto', () => {
  it('F1: refuses a null token instead of treating it as an absent one', () => {
    expect(refused({ writeToken: null })).toEqual(['writeToken']);
    expect(refused({ readToken: null, writeToken: 'glpat-write' })).toEqual(['readToken']);
  });

  it('F1: still accepts a rotation that omits one token', () => {
    expect(refused({ writeToken: 'glpat-write' })).toEqual([]);
    expect(refused({ readToken: 'glpat-read' })).toEqual([]);
    expect(refused({ readToken: 'glpat-read', writeToken: 'glpat-write', confirmBotAccount: true })).toEqual([]);
  });

  it('refuses a token that is empty or too long', () => {
    expect(refused({ writeToken: '' })).toEqual(['writeToken']);
    expect(refused({ writeToken: 'x'.repeat(513) })).toEqual(['writeToken']);
  });

  it('refuses a confirmation that is not a boolean', () => {
    const errors = validateSync(
      plainToInstance(UpdateGitlabCredentialsDto, { writeToken: 'glpat-write', confirmBotAccount: 'yes' }),
      PIPE_OPTIONS,
    );

    expect(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]))
      .toEqual([['confirmBotAccount', ['isBoolean']]]);
  });

  it('drops an undeclared field, so a body cannot smuggle one into the frozen input', () => {
    const instance = plainToInstance(UpdateGitlabCredentialsDto, { writeToken: 'glpat-write', isBot: true });
    expect(validateSync(instance, PIPE_OPTIONS)).toEqual([]);

    expect(Object.keys(instanceToPlain(instance))).toEqual(['writeToken']);
  });

  it('answers the rotation-empty refusal when the body names no token, whatever else it carries', () => {
    expect(() => assertRotationGiven({})).toThrow(ValidationAppException);
    expect(() => assertRotationGiven({ confirmBotAccount: true })).toThrow(ValidationAppException);
    expect(() => assertRotationGiven({ writeToken: 'glpat-write' })).not.toThrow();
    expect(() => assertRotationGiven({ readToken: 'glpat-read' })).not.toThrow();
  });
});
