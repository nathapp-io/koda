import { AfterCommitService } from './after-commit.service';

/**
 * Permissions P1a (B3) — the deferred-work queue `MembershipService` uses to invalidate the permission
 * cache only after the transaction that wrote a binding committed. No database is involved.
 */
describe('AfterCommitService', () => {
  let service: AfterCommitService;
  let ran: string[];

  beforeEach(() => {
    service = new AfterCommitService();
    ran = [];
  });

  const task = (name: string) => async (): Promise<void> => {
    ran.push(name);
  };

  it('runs a deferred task once the scope resolves, not before', async () => {
    await service.scope(async () => {
      expect(service.defer(task('a'))).toBe(true);
      expect(ran).toEqual([]);
    });

    expect(ran).toEqual(['a']);
  });

  it('keeps deferred tasks in order', async () => {
    await service.scope(async () => {
      service.defer(task('a'));
      service.defer(task('b'));
    });

    expect(ran).toEqual(['a', 'b']);
  });

  it('joins a nested scope to the outermost one, flushing exactly once', async () => {
    await service.scope(async () => {
      service.defer(task('outer'));
      await service.scope(async () => {
        service.defer(task('inner'));
        // The inner scope must not flush: the outer transaction is still open.
        expect(ran).toEqual([]);
      });
      expect(ran).toEqual([]);
    });

    expect(ran).toEqual(['outer', 'inner']);
  });

  it('reports that nothing can be deferred outside a scope', async () => {
    expect(service.defer(task('nowhere'))).toBe(false);
    expect(ran).toEqual([]);
  });

  it('drops the deferred tasks when the scope throws, as a rolled-back transaction does', async () => {
    const failure = new Error('rolled back');

    await expect(
      service.scope(async () => {
        service.defer(task('a'));
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(ran).toEqual([]);
  });

  it('starts from an empty queue in the next scope', async () => {
    await service.scope(async () => {
      service.defer(task('first'));
    });
    ran.length = 0;

    await service.scope(async () => {
      service.defer(task('second'));
    });

    expect(ran).toEqual(['second']);
    expect(service.defer(task('outside'))).toBe(false);
  });
});
