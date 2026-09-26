import { GlobalLock, KODA_LOCK_CLASS, lockGlobal, lockProjectMembers } from './advisory-lock';

describe('advisory locks', () => {
  function fakeDb() {
    const $queryRaw = jest.fn().mockResolvedValue([{ locked: 1 }]);
    return { db: { $queryRaw } as never, $queryRaw };
  }

  it('lockGlobal takes pg_advisory_xact_lock(GLOBAL, key)', async () => {
    const { db, $queryRaw } = fakeDb();
    await lockGlobal(db, GlobalLock.USER_BOOTSTRAP);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual([KODA_LOCK_CLASS.GLOBAL, GlobalLock.USER_BOOTSTRAP]);
  });

  it('lockProjectMembers hashes the project id under the PROJECT_MEMBERS class', async () => {
    const { db, $queryRaw } = fakeDb();
    await lockProjectMembers(db, 'proj-1');

    const [strings, ...values] = $queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('hashtext(');
    expect(values).toEqual([KODA_LOCK_CLASS.PROJECT_MEMBERS, 'proj-1']);
  });

  it('never selects the void lock result directly', async () => {
    const { db, $queryRaw } = fakeDb();
    await lockGlobal(db, GlobalLock.USER_ADMINISTRATION);
    const sql = ($queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(/SELECT 1 AS locked FROM \(SELECT pg_advisory_xact_lock/);
  });
});
