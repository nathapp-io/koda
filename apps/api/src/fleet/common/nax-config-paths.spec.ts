// Runtime import of the package is allowed in a spec (protocol.spec.ts pins the rule for production code only).
import * as pkgPaths from '@nathapp/fleet-protocol';
import * as apiPaths from './nax-config-paths';
import * as apiJobs from './config-jobs';

const IMPLS = [
  ['package', pkgPaths.naxPathGroup, pkgPaths.isAllowedNaxPath],
  ['api mirror', apiPaths.naxPathGroup, apiPaths.isAllowedNaxPath],
] as const;

describe.each(IMPLS)('nax config allowlist (%s, spec §2)', (_name, group, allowed) => {
  it.each([
    ['.nax/rules/testing.md', 'rules'],
    ['.nax/rules/api/nest-conventions.md', 'rules'],
    ['.nax/context.md', 'context'],
    ['.nax/mono/apps/api/context.md', 'context'],
    ['.nax/mono/api/context.md', 'context'],
    ['.nax/config.json', 'config'],
    ['.nax/mono/apps/web/config.json', 'config'],
    ['.nax/profiles/fast.json', 'profiles'],
    ['.nax/profiles/codex-review.v2.json', 'profiles'],
    ['.nax/constitution.md', 'constitution'],
  ])('allows %s as %s', (path, expected) => {
    expect(group(path)).toBe(expected);
    expect(allowed(path)).toBe(true);
  });

  it.each([
    ['.nax/profiles/fast.env', 'an env profile'],
    ['.nax/profiles/fast.json.env', 'an env suffix'],
    ['.nax/rules/secrets.env/x.md', 'an env segment'],
    ['.nax/rules/../config.json', 'a dot-dot segment'],
    ['.nax/rules/./a.md', 'a dot segment'],
    ['.nax//context.md', 'an empty segment'],
    ['/.nax/context.md', 'an absolute path'],
    ['.nax\\context.md', 'a backslash'],
    ['.nax/context.md\u0000', 'a NUL'],
    ['.NAX/context.md', 'a case variant of .nax'],
    ['.nax/Rules/a.md', 'a case variant of rules'],
    ['.nax/CONTEXT.md', 'a case variant of context.md'],
    ['.nax/rules/a.txt', 'a non-md rule'],
    ['.nax/rules/.md', 'an empty rule name'],
    ['.nax/rules', 'the rules dir'],
    ['.nax/mono/context.md', 'mono without a package dir'],
    ['.nax/mono/apps/api/rules/a.md', 'a mono rules overlay (not allowlisted)'],
    ['.nax/profiles/sub/fast.json', 'a nested profile'],
    ['.nax/profiles/-bad.json', 'a profile name not starting alphanumeric'],
    ['.nax/features/x/prd.json', 'a feature file'],
    ['.nax/status.json', 'a runtime file'],
    ['AGENTS.md', 'a generated agent file'],
    ['CLAUDE.md', 'a generated agent file'],
    ['.nax/rules/has space.md', 'a space'],
    [`.nax/rules/${'a'.repeat(510)}.md`, 'a path over 512 chars'],
    ['', 'empty'],
  ])('refuses %s (%s)', (path) => {
    expect(group(path)).toBeNull();
    expect(allowed(path)).toBe(false);
  });

  it('refuses non-strings without throwing', () => {
    expect(allowed(42 as unknown as string)).toBe(false);
    expect(group(undefined as unknown as string)).toBeNull();
  });
});

describe('API mirrors match the package', () => {
  it('limits', () => {
    expect(apiPaths.NAX_CONFIG_LIMITS).toEqual(pkgPaths.NAX_CONFIG_LIMITS);
    expect(apiJobs.CONFIG_RESULT_LIMITS).toEqual(pkgPaths.CONFIG_RESULT_LIMITS);
  });
  it('kinds and completed outcomes', () => {
    expect([...apiJobs.CONFIG_JOB_KINDS]).toEqual([...pkgPaths.CONFIG_JOB_KINDS]);
    expect([...apiJobs.CONFIG_COMPLETED_OUTCOMES]).toEqual([...pkgPaths.CONFIG_COMPLETED_OUTCOMES]);
  });
  it.each([['CONFIG_EDIT', true], ['CONFIG_DRIFT', true], ['RUN', false], ['PLAN', false], ['config_edit', false]])(
    'isConfigKind(%s) is %s in both', (kind, expected) => {
      expect(apiJobs.isConfigKind(kind)).toBe(expected);
      expect(pkgPaths.isConfigKind(kind)).toBe(expected);
    });
});
