import { ValidationAppException } from '@nathapp/nestjs-common';
import { validateCreateThread, type CreateThreadInput } from './thread-input';

/**
 * The create-input discriminator (fleet S5b US-003). `raw` builds the request body as the HTTP
 * boundary would deliver it, so a case can carry a value the TypeScript type forbids (a WORKSPACE
 * kind, a feature on a PROJECT thread) exactly as a hostile client would.
 */
const raw = (over: Record<string, unknown> = {}): CreateThreadInput =>
  ({ title: 'Brainstorm', backend: { kind: 'native', model: 'm1' }, ...over }) as unknown as CreateThreadInput;

const reasonOf = (fn: () => unknown): string => {
  // ValidationAppException carries its i18n args on `.args` (see config-edit-input.spec.ts:9).
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationAppException);
    // ValidationAppException is `ret: -2` with httpStatus 400 (`CommonExceptionCode.REQUEST_PARAMETER_ERROR`).
    const { args, prefix, httpStatus } = e as { args: { reason: string }; prefix: string; httpStatus: number };
    expect(prefix).toBe('threads.input');
    expect(httpStatus).toBe(400);
    return args.reason;
  }
  throw new Error('validateCreateThread did not throw');
};

describe('validateCreateThread — PROJECT threads (fleet S5b US-003)', () => {
  it('AC-1: a PROJECT thread with a title and a native backend validates as kind PROJECT', () => {
    const normalized = validateCreateThread(raw({ kind: 'PROJECT' }), 'trunk');
    expect(normalized.kind).toBe('PROJECT');
    expect(normalized).toEqual({ kind: 'PROJECT', title: 'Brainstorm', maxCostUsd: '5', backend: { kind: 'native', model: 'm1' } });
  });

  it('AC-2: a PROJECT thread with a feature is refused with reason projectFields', () => {
    expect(reasonOf(() => validateCreateThread(raw({ kind: 'PROJECT', feature: 'add-auth' }), 'trunk'))).toBe('projectFields');
  });

  it('AC-3: a PROJECT thread with a repoId is refused with reason projectFields', () => {
    expect(reasonOf(() => validateCreateThread(raw({ kind: 'PROJECT', repoId: 'r1' }), 'trunk'))).toBe('projectFields');
  });

  it('AC-4: a PROJECT thread with a baseRef is refused with reason projectFields', () => {
    expect(reasonOf(() => validateCreateThread(raw({ kind: 'PROJECT', baseRef: 'trunk' }), 'trunk'))).toBe('projectFields');
  });

  it('AC-5: a PROJECT thread with an ACP backend (1a-R2) is refused with reason backend', () => {
    expect(reasonOf(() => validateCreateThread(raw({ kind: 'PROJECT', backend: { kind: 'acp', agent: 'claude' } }), 'trunk'))).toBe('backend');
  });

  it('AC-6: an unknown kind is refused with reason kind', () => {
    expect(reasonOf(() => validateCreateThread(raw({ kind: 'WORKSPACE', repoId: 'r1', feature: 'add-auth' }), 'trunk'))).toBe('kind');
  });

  it('AC-7: an absent kind with no repoId and no feature is refused with reason repoId', () => {
    expect(reasonOf(() => validateCreateThread(raw(), 'trunk'))).toBe('repoId');
  });

  it('AC-8: an absent kind with a repoId, a valid feature and a native backend validates as kind REPO', () => {
    const normalized = validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth' }), 'trunk');
    expect(normalized.kind).toBe('REPO');
    expect(normalized).toEqual({ kind: 'REPO', repoId: 'r1', feature: 'add-auth', baseRef: 'trunk', title: 'Brainstorm', maxCostUsd: '5', backend: { kind: 'native', model: 'm1' } });
  });
});

describe('validateCreateThread — REPO behaviour is unchanged (fleet S5b US-003)', () => {
  it('derives baseRef from the default branch and carries an explicit baseRef through', () => {
    expect(validateCreateThread(raw({ kind: 'REPO', repoId: 'r1', feature: 'add-auth' }), 'main')).toMatchObject({ baseRef: 'main' });
    expect(validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', baseRef: 'release/1' }), 'main')).toMatchObject({ baseRef: 'release/1' });
  });

  it('refuses a REPO thread with a bad feature before it looks at the baseRef', () => {
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'Add Auth', baseRef: 'release/1' }), 'main'))).toBe('feature');
  });

  it('refuses a REPO thread whose repoId is not a string', () => {
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 7, feature: 'add-auth' }), 'main'))).toBe('repoId');
  });

  it('refuses a bad baseRef, title, cap and backend in the documented order', () => {
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', baseRef: 'bad ref' }), 'main'))).toBe('baseRef');
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', title: '' }), 'main'))).toBe('title');
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', maxCostUsd: 0 }), 'main'))).toBe('maxCostUsd');
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'gemini' } }), 'main'))).toBe('backend');
  });
});
