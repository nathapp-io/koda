import { repoThreadFields } from './chat-thread.domain';

/**
 * US-002 AC-3, AC-8, AC-9, AC-10 — the REPO-only guard: a REPO thread (or a row with no/unknown kind, which
 * older fixtures and rows produce) yields its four repo fields; a PROJECT thread or any null field is a 409.
 */
describe('repoThreadFields (US-002)', () => {
  const fields = { repoId: 'r1', baseRef: 'trunk', feature: 'auth', specPath: '.nax/features/auth/spec.md' };

  it('AC-3: a thread object with no kind property and all four fields set returns those four values', () => {
    expect(repoThreadFields({ ...fields })).toEqual(fields);
  });

  it('AC-8: a REPO thread with all four fields set returns those four values', () => {
    expect(repoThreadFields({ kind: 'REPO', ...fields })).toEqual(fields);
  });

  it('treats an unknown kind like an absent one, so a future kind cannot crash a REPO row', () => {
    expect(repoThreadFields({ kind: 'WORKSPACE', ...fields })).toEqual(fields);
  });

  it('AC-9: a PROJECT thread throws ConflictAppException with the threads.notRepoThread key', () => {
    expect(() => repoThreadFields({ kind: 'PROJECT', ...fields }))
      .toThrow(expect.objectContaining({ code: 409, httpStatus: 409, prefix: 'threads.notRepoThread' }));
  });

  it('AC-10: a REPO thread whose feature is null throws ConflictAppException with the threads.notRepoThread key', () => {
    expect(() => repoThreadFields({ kind: 'REPO', ...fields, feature: null }))
      .toThrow(expect.objectContaining({ code: 409, httpStatus: 409, prefix: 'threads.notRepoThread' }));
  });

  it.each(['repoId', 'baseRef', 'feature', 'specPath'] as const)('a REPO thread whose %s is null is refused', (field) => {
    expect(() => repoThreadFields({ kind: 'REPO', ...fields, [field]: null }))
      .toThrow(expect.objectContaining({ prefix: 'threads.notRepoThread' }));
  });
});
