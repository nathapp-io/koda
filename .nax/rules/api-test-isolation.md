---
paths:
  - "apps/api/*"
priority: 70
---

# API Test Isolation — apps/api

Unit spec files run in parallel worker processes (`fileParallelism` in `vitest.config.ts`), and any
test may run in any order. A spec must pass alone, alongside every other file, and shuffled.
DB-backed runs (`KODA_DB_TESTS=1`) stay serial because they share one Postgres schema; do not rely
on that for unit specs.

## Filesystem
- Never write to a fixed path (`./lancedb`, `./tmp`, `os.tmpdir() + '/name'`, a dir under `src/` or `test/`).
  Two files writing the same path collide and leave artifacts in the repo
- Create a per-file dir and remove it:

```typescript
// Correct
const root = mkdtempSync(join(tmpdir(), 'koda-<feature>-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Wrong: shared by every worker, and left behind after the run
const ragConfig = { lancedbPath: './lancedb', inMemoryOnly: false };
```

- Mocking the LanceDB connection does not stop `LanceTableManager` from creating `lancedbPath`.
  Use `inMemoryOnly: true` or a `mkdtempSync` dir
- Do not read data written by an earlier `it(...)`. Each test writes what it reads

## Ports
- Test servers listen on port 0 and read the bound port from `server.address()`. Never a fixed number

## Environment variables
- Restore every `process.env` change. A delete counts: deleting a value loaded from `.env.test`
  leaks into the rest of the file
- Use `restoreEnvAfterEach()` from `src/common/test-helpers/restore-env.ts` at `describe` scope,
  or `vi.stubEnv(...)` with `vi.unstubAllEnvs()` in `afterEach`, or save and restore in `finally`

## Mocks
- Mocks declared at `describe` or module scope keep implementations and queued `mockResolvedValueOnce`
  values across tests. If a test overrides one (`mockResolvedValue`, `mockImplementation`,
  `mockRejectedValue`), reset it in `beforeEach` (`mockReset()`, then re-apply the default)
- `test-setup.ts` spies on `Logger.prototype` globally. Call `spy.mockClear()` before asserting on
  `calls[0]` of a logger spy

## Verification
Run a story's unit specs shuffled before declaring them done; a failure only under shuffle is an
order dependency to fix, not flakiness to retry:

```bash
cd apps/api && bunx vitest run --exclude "test/integration/**" --exclude "test/e2e/**" --sequence.shuffle --sequence.seed=23
```
