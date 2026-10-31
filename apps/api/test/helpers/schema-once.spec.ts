import { prepareSchemaOnce, resetSchemaOnceForTests } from './schema-once';

/**
 * The schema is reset once per database per process (fix round 1, F1).
 *
 * Vitest runs global setup once per project (`db-shared` and `db-isolated`), and `prisma db push --force-reset`
 * truncates everything. Running it a second time while the first project's files are already executing deletes the rows
 * under them, which showed up as intermittent `401 Unauthorized` answers: `AuthService.register` re-reads the user it
 * just created, and a bearer token's user is looked up per request.
 */
describe('prepareSchemaOnce', () => {
  beforeEach(() => resetSchemaOnceForTests());

  it('runs the preparation once per database, however many projects ask for it', async () => {
    const prepare = vi.fn(async () => undefined);

    await Promise.all([
      prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', prepare),
      prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', prepare),
    ]);
    await prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', prepare);

    expect(prepare).toHaveBeenCalledTimes(1);
    // The other database is prepared on its own.
    await prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_other', prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('waits for a preparation already in flight before answering', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prepare = vi.fn(async () => gate);

    const first = prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', prepare);
    let settled = false;
    const second = prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', prepare).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  });

  it('retries after a failed preparation instead of caching the failure', async () => {
    const failing = vi.fn(async () => { throw new Error('db push failed'); });

    await expect(prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', failing)).rejects.toThrow('db push failed');

    const retry = vi.fn(async () => undefined);
    await prepareSchemaOnce('postgresql://koda:koda@localhost:5433/koda_test', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
