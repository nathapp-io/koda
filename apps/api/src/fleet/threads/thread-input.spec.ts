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

describe('validateCreateThread — ACP backends on every kind (thread-agents-modes US-001)', () => {
  it('AC-8: a PROJECT thread with an ACP codex backend validates as kind PROJECT', () => {
    const normalized = validateCreateThread(raw({ kind: 'PROJECT', backend: { kind: 'acp', agent: 'codex' } }), 'trunk');
    expect(normalized.kind).toBe('PROJECT');
    expect(normalized).toEqual({ kind: 'PROJECT', title: 'Brainstorm', maxCostUsd: '5', backend: { kind: 'acp', agent: 'codex' } });
  });

  it('AC-9: a REPO thread accepts acp cursor with a bracketed ACP model id', () => {
    const backend = { kind: 'acp', agent: 'cursor', model: 'gpt-5.5[context=272k,reasoning=medium]' };
    const normalized = validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend }), 'main');
    expect(normalized).toMatchObject({ kind: 'REPO', repoId: 'r1', feature: 'add-auth', backend });
  });

  it('AC-10: refuses acp gemini with a validation error naming backend', () => {
    expect(reasonOf(() => validateCreateThread(raw({ kind: 'PROJECT', backend: { kind: 'acp', agent: 'gemini' } }), 'trunk'))).toBe('backend');
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'gemini' } }), 'main'))).toBe('backend');
  });

  it('keeps MODEL_ID_RE for a native model id, so a bracketed suffix is still refused', () => {
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'native', model: 'gpt-5.5[context=272k]' } }), 'main'))).toBe('backend');
    expect(validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'native', model: 'gpt-5.5' } }), 'main'))
      .toMatchObject({ backend: { kind: 'native', model: 'gpt-5.5' } });
  });

  it('refuses an ACP model id that ACP_MODEL_ID_RE rejects', () => {
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'cursor', model: 'bad model' } }), 'main'))).toBe('backend');
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'cursor', model: 'a'.repeat(129) } }), 'main'))).toBe('backend');
    // The 128-character boundary is admitted, so the refusal above is the length rule and not a narrower one.
    expect(validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'cursor', model: 'a'.repeat(128) } }), 'main'))
      .toMatchObject({ backend: { kind: 'acp', agent: 'cursor' } });
  });

  it('accepts the effort ids the offer list advertises for an ACP agent', () => {
    // The picker (US-011) sends an effort straight from `acpOffers`, whose ids ACP_EFFORT_RE admits, so create has to
    // admit the same set for an acp backend. A native effort keeps its older, narrower rule.
    expect(validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'cursor', effort: 'x-high_2' } }), 'main'))
      .toMatchObject({ backend: { kind: 'acp', agent: 'cursor', effort: 'x-high_2' } });
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'native', effort: 'x-high_2' } }), 'main'))).toBe('backend');
    expect(reasonOf(() => validateCreateThread(raw({ repoId: 'r1', feature: 'add-auth', backend: { kind: 'acp', agent: 'cursor', effort: 'HIGH' } }), 'main'))).toBe('backend');
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
