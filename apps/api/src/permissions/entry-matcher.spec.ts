import {
  expandEntries,
  ScopeMismatchEntryError,
  UnknownPermissionEntryError,
} from './entry-matcher';
import { SYSTEM_ROLES } from './system-roles';

function captureThrow(act: () => void): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('expandEntries', () => {
  it('AC-1/2/3: Developer can decide the narrowed fleet shell escalation ask', () => {
    const developer = SYSTEM_ROLES.find((role) => role.key === 'developer');
    expect(developer).toBeDefined();
    expect(developer?.permissions).toContain('approval.decide@fleet.job.shell.escalate');
    expect(developer?.permissions).toContain('fleet.approval.decide.bash');
    expect(() => expandEntries(developer?.permissions ?? [], 'PROJECT')).not.toThrow();
    expect(expandEntries(developer?.permissions ?? [], 'PROJECT').has(
      'approval.decide@fleet.job.shell.escalate',
    )).toBe(true);
  });

  it('AC-24: expands a prefix wildcard to the fitting role-grantable keys under it', () => {
    const result = expandEntries(['ticket.*'], 'PROJECT');

    expect(result.has('ticket.delete')).toBe(true);
    expect(result.has('ticket.transition.fix')).toBe(true);
    expect(result.has('comment.create')).toBe(false);
  });

  it('AC-25: `*` covers every fitting role-grantable key, in the role scope only', () => {
    const result = expandEntries(['*'], 'PROJECT');

    expect(result.has('ticket.delete')).toBe(true);
    expect(result.has('agent.read')).toBe(true);
    // runner access, not role-grantable
    expect(result.has('runner.sync')).toBe(false);
    // implicit, not role-grantable
    expect(result.has('notification.read')).toBe(false);
    // global scope does not fit a PROJECT role
    expect(result.has('user.create')).toBe(false);
  });

  it('AC-26: `*.read` covers read keys only', () => {
    const result = expandEntries(['*.read'], 'PROJECT');

    expect(result.has('fleet.job.logs.read')).toBe(true);
    expect(result.has('ticket.create')).toBe(false);
    // public and implicit reads are not role-grantable
    expect(result.has('health.read')).toBe(false);
    expect(result.has('notification.read')).toBe(false);
  });

  it('AC-27: an exclusion removes what its entry expands to, after every inclusion', () => {
    const result = expandEntries(['*', '!role.binding.owner'], 'GLOBAL');

    expect(result.has('role.binding.global')).toBe(true);
    expect(result.has('role.binding.owner')).toBe(false);
  });

  it('AC-28: `p.*.own` expands to the ownable keys under `p.`, and `k.own` stays qualified', () => {
    const result = expandEntries(['thread.*.own', 'comment.update.own'], 'PROJECT');

    expect(result.has('thread.stop.own')).toBe(true);
    expect(result.has('comment.update.own')).toBe(true);
    // thread.create is not ownable
    expect(result.has('thread.create.own')).toBe(false);
    // the any-row key is not implied by the `.own` entry
    expect(result.has('comment.update')).toBe(false);
  });

  it('AC-29: an entry no catalog key matches throws UnknownPermissionEntryError', () => {
    const error = captureThrow(() => expandEntries(['unknown.key'], 'PROJECT'));

    expect(error).toBeInstanceOf(UnknownPermissionEntryError);
    expect((error as UnknownPermissionEntryError).entry).toBe('unknown.key');
  });

  it('AC-30: a key that does not fit the role scope throws ScopeMismatchEntryError', () => {
    const error = captureThrow(() => expandEntries(['user.create'], 'PROJECT'));

    expect(error).toBeInstanceOf(ScopeMismatchEntryError);
    expect((error as ScopeMismatchEntryError).entry).toBe('user.create');
  });

  it('AC-31: an approval.decide entry that matches a catalog pattern is kept verbatim', () => {
    const result = expandEntries(['approval.decide@ticket.*'], 'PROJECT');

    expect(result.has('approval.decide@ticket.*')).toBe(true);
    expect([...result]).toEqual(['approval.decide@ticket.*']);
  });

  it('AC-32: an approval.decide pattern that matches no catalog key throws UnknownPermissionEntryError', () => {
    const error = captureThrow(() => expandEntries(['approval.decide@nope.*'], 'PROJECT'));

    expect(error).toBeInstanceOf(UnknownPermissionEntryError);
    expect((error as UnknownPermissionEntryError).entry).toBe('approval.decide@nope.*');
  });

  it('accepts an exact key as an approval.decide pattern', () => {
    const result = expandEntries(['approval.decide@ticket.delete'], 'PROJECT');

    expect([...result]).toEqual(['approval.decide@ticket.delete']);
  });

  it('rejects a catalog key that is not role-grantable', () => {
    const implicit = captureThrow(() => expandEntries(['mcp.access'], 'PROJECT'));
    const runner = captureThrow(() => expandEntries(['runner.sync'], 'PROJECT'));

    expect(implicit).toBeInstanceOf(ScopeMismatchEntryError);
    expect((implicit as ScopeMismatchEntryError).entry).toBe('mcp.access');
    expect(runner).toBeInstanceOf(ScopeMismatchEntryError);
    expect((runner as ScopeMismatchEntryError).entry).toBe('runner.sync');
  });

  it('rejects a `.own` entry whose base key is unknown or not ownable', () => {
    const unknown = captureThrow(() => expandEntries(['no.such.key.own'], 'PROJECT'));
    const notOwnable = captureThrow(() => expandEntries(['thread.create.own'], 'PROJECT'));

    expect(unknown).toBeInstanceOf(UnknownPermissionEntryError);
    expect((unknown as UnknownPermissionEntryError).entry).toBe('no.such.key.own');
    expect(notOwnable).toBeInstanceOf(ScopeMismatchEntryError);
    expect((notOwnable as ScopeMismatchEntryError).entry).toBe('thread.create.own');
  });

  it('rejects a prefix wildcard with no role-grantable match', () => {
    const error = captureThrow(() => expandEntries(['runner.*'], 'PROJECT'));

    expect(error).toBeInstanceOf(UnknownPermissionEntryError);
    expect((error as UnknownPermissionEntryError).entry).toBe('runner.*');
  });

  it('keeps a GLOBAL role off project keys and gives it the fitting global ones', () => {
    const result = expandEntries(['*'], 'GLOBAL');

    expect(result.has('user.create')).toBe(true);
    expect(result.has('role.binding.global')).toBe(true);
    expect(result.has('ticket.delete')).toBe(false);
    expect(result.has('ticket.read')).toBe(false);
  });

  it('applies exclusions after inclusions regardless of entry order, and deduplicates', () => {
    const result = expandEntries(['!*.read', 'ticket.*', 'ticket.read'], 'PROJECT');

    expect(result.has('ticket.read')).toBe(false);
    expect(result.has('ticket.create')).toBe(true);
    expect(result.has('ticket.delete')).toBe(true);
  });

  it('returns an empty set for an empty entry list', () => {
    expect([...expandEntries([], 'PROJECT')]).toEqual([]);
  });

  it('expands an explicit key to itself only', () => {
    expect([...expandEntries(['ticket.read'], 'PROJECT')]).toEqual(['ticket.read']);
    expect([...expandEntries(['comment.update.own'], 'PROJECT')]).toEqual(['comment.update.own']);
  });
});
