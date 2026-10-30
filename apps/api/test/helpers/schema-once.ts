/**
 * The test schema is prepared once per database per process (fix round 1, F1).
 *
 * Vitest runs `globalSetup` once per project (`db-shared` and `db-isolated`), and `prepareSchema` force-resets the
 * schema. The second run of it overlaps the first project's test files — the main process blocks in `execSync` while the
 * workers keep testing — and the reset deletes rows the running suites just created. That surfaced as intermittent
 * `401 Unauthorized` answers (a bearer token's user is looked up per request, and `AuthService.register` re-reads the
 * user it has just committed), which is why whole suites failed in `beforeAll` with nothing structured to report.
 *
 * The state lives on `globalThis`, not in a module variable: each project's global setup gets its own module instance.
 */
interface SchemaSlot {
  /** One in-flight or finished preparation per database URL. */
  readonly prepared: Map<string, Promise<void>>;
}

const SLOT = Symbol.for('koda.test.schemaPrepared');

function slot(): SchemaSlot {
  const holder = globalThis as unknown as Record<symbol, SchemaSlot | undefined>;
  holder[SLOT] ??= { prepared: new Map() };
  return holder[SLOT] as SchemaSlot;
}

/**
 * Runs `prepare` at most once per database in this process, and answers the same promise to every later caller — so a
 * project that starts while the schema is being pushed waits for it instead of resetting it again.
 */
export function prepareSchemaOnce(databaseUrl: string, prepare: () => Promise<void>): Promise<void> {
  const { prepared } = slot();
  const existing = prepared.get(databaseUrl);
  if (existing !== undefined) return existing;

  const running = prepare();
  prepared.set(databaseUrl, running);
  // A failed push must not cache its failure: the run is about to fail anyway, and a retry is the honest next step.
  running.catch(() => prepared.delete(databaseUrl));
  return running;
}

/** Clears the process-wide memory; the unit spec uses it so its cases do not see each other's preparations. */
export function resetSchemaOnceForTests(): void {
  slot().prepared.clear();
}
