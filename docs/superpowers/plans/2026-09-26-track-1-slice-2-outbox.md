# Track 1 Slice 2 — Outbox on `@nathapp/nestjs-outbox` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace koda's hand-rolled outbox (5 s cron, in-loop backoff `await`, singleton failure counter) with `@nathapp/nestjs-outbox@3.3.0` backed by a Prisma store, and make every producer record its outbox row atomically with the write that caused it. Closes review finding M4 (both halves).

**Architecture:** The package supplies `OutboxService.record()` (writes through the active transaction client) and `OutboxRelay` (poll loop with an `inFlight` overlap guard, leases, capped exponential backoff). koda supplies the two adapters the package lacks: `PrismaOutboxStore` (claims with one `UPDATE … FOR UPDATE SKIP LOCKED` statement, owner-checked state writes) and `FanOutPublisher` (the existing handler registry, reshaped to throw one aggregate error and record `lastError`). The `OutboxEvent` table is reshaped in place by a hand-written migration that also rewrites legacy rows.

**Tech Stack:** NestJS 11 + Fastify, Prisma 6 on Postgres 16, `@nathapp/nestjs-outbox` 3.3.0, `@nathapp/nestjs-prisma` 3.3.0 (`PrismaTransactionManager`, ALS-proxied `PrismaService.client`), Jest (ts-jest, `maxWorkers: 1`), Bun 1.3.x.

**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md`, section "Slice 2 — Outbox on `@nathapp/nestjs-outbox`". Read it before starting.

**Branch:** `feat/track1-outbox` (already created off `main` @ `202121e9`).

## Global Constraints

- Package: `@nathapp/nestjs-outbox@^3.3.0` in `apps/api/package.json`. It is `global: true`, its module class is also called `OutboxModule`, and its service is also called `OutboxService`. Always import them aliased where koda has a same-named symbol: `import { OutboxModule as NathappOutboxModule } from '@nathapp/nestjs-outbox'`.
- Relay settings (verbatim from the spec): `pollIntervalMs 1000`, `batchSize 20`, `leaseMs 30000`, `maxAttempts 8`, `backoffBaseMs 2000`, `backoffCapMs 300000`.
- The relay is enabled outside tests, disabled under `NODE_ENV=test`, and `OUTBOX_RELAY_ENABLED=true|false` overrides both. Tests drive the relay explicitly with `OutboxRelay.dispatchPendingBatch()`.
- Statuses: `pending | processing | published | dead` (the package's `OutboxStatus`). The strings `completed`, `failed` and `dead_letter` must not remain anywhere in `apps/api/src` or `apps/cli/src` after Task 6.
- `payload` and `headers` stay JSON-as-String columns. String-typed enums stay String.
- `projectId` and `eventId` stay real columns. Producers pass them in `record({ metadata: { projectId, eventId } })`. The store rejects a record without `metadata.projectId`.
- **Transaction trap:** `record()` is atomic with the business write only inside `txManager.run(...)`. Outside it, `getClient()` returns the root client and the write silently commits on its own. Every producer that has a business write calls `record()` inside the same `txManager.run` as that write.
- Prisma interactive transactions must not run queries in parallel. Inside `txManager.run`, write loops sequentially (`for … of` + `await`), never `Promise.all`.
- Never retry inside an aborted transaction. The package never retries `record()`, and neither do we.
- Timestamps: `claimBatch` compares `timestamp(3)` columns with JS `Date` parameters. This assumes the Postgres session timezone is UTC (the stock `postgres:16` image, and every compose file in this repo). Do not change the compose images' timezone.
- Follow `nathapp-nestjs-patterns`: repository → service → controller, `AppException` subclasses for errors, `registerAs` config, no `console.log`, no raw `process.env` outside config files and test harnesses. 409 uses koda's convention `new HttpException(message, HttpStatus.CONFLICT)`.
- No `forwardRef()` (removed repo-wide by #125).
- `bun run test` (unit) must pass with **no database running**. DB-backed tests live under `test/integration/` and are gated by `KODA_DB_TESTS === '1'`.
- Never edit generated files (`apps/cli/src/generated/`, root `openapi.json` except via `bun run generate`).
- Do not push, open a PR, or touch `projects/koda/deployments/koda-local` without the user's explicit approval at that moment.
- Git: the rtk hook rewrites git commands. If one misbehaves, prefix it with `RTK_DISABLED=1`.

## Review Focus

1. **Legacy rows caught mid-flight by the migration.** A `processing` row from the old cron has no `leaseUntil`, so the new claim query (`leaseUntil < now`) would never pick it up again; `failed` and `pending` rows with a null `nextAttemptAt` would violate the new `NOT NULL`. All of them must end up `pending` and claimable. Pinned in Task 3 (migration test).
2. **A row whose `payload` is not valid JSON** must not throw inside `claimBatch` (that would fail every relay cycle and wedge the whole queue). It is handed to the publisher as the raw string, fails its handlers, and dies after `maxAttempts`. Pinned in Task 3 (store test).
3. **A webhook whose stored `events` column is malformed JSON.** Once webhook dispatch runs inside the ticket transition's transaction, a `JSON.parse` throw would fail the user's transition. The bad webhook is skipped and logged. Pinned in Task 4.
4. **Admin retry on a row that is `processing` right now.** Resetting it clears `owner`, so the in-flight relay's `markPublished` becomes a no-op and the event is delivered twice. Retry is allowed for `dead` and `pending` rows only; `processing`/`published` → 409. Pinned in Task 6.
5. **A handler that throws a huge or multi-line error** (for example an HTTP response body). `lastError` is truncated to 2000 characters, and a failure to write `lastError` must not hide the handler failure from the relay (otherwise the event is marked published). Pinned in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/config/outbox.config.ts` (+ `.spec.ts`) | `registerAs('outbox')`: relay settings + enabled flag | 1 |
| `apps/api/src/config/env.validation.ts` | Joi entry for `OUTBOX_RELAY_ENABLED` | 1 |
| `apps/api/src/app.module.ts` | load `outboxConfig`; import `OutboxAdminModule` (Task 3) | 1, 3 |
| `apps/api/test/helpers/outbox-record.ts` | `outboxRecord()` test fixture + `noopLastErrors` | 2 |
| `apps/api/src/outbox/fan-out-publisher.ts` (+ `.spec.ts`) | `IOutboxPublisher`: handler registry, aggregate failure, `lastError` | 2 |
| `apps/api/src/outbox/outbox-fan-out-registry.ts` (+ `.spec.ts`) | **deleted** | 2 |
| `apps/api/prisma/schema.prisma` | `OutboxEvent` reshape | 3 |
| `apps/api/prisma/migrations/20260926090000_outbox_nestjs_outbox/migration.sql` | hand-written reshape + legacy row rewrite | 3 |
| `apps/api/test/integration/outbox/outbox-migration.integration.spec.ts` | applies init + slice-2 SQL to a scratch schema, asserts the rewrite | 3 |
| `apps/api/src/outbox/prisma-outbox.store.ts` | `IOutboxStore` on Prisma | 3 |
| `apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts` | store behavior on real Postgres | 3 |
| `apps/api/src/outbox/outbox-core.module.ts` | provides repository, store, publisher | 3 |
| `apps/api/src/outbox/outbox.module.ts` (+ `.spec.ts`) | wires `NathappOutboxModule.registerAsync`; re-exports core | 3 |
| `apps/api/src/outbox/outbox-admin.module.ts` | hosts `AdminController` (keeps HTTP out of the domain module) | 3 |
| `apps/api/test/integration/outbox/outbox-relay.integration.spec.ts` | record → relay → handler → published / retry, end to end | 3 |
| `apps/api/src/outbox/prisma-outbox.repository.ts` | admin reads + `recordLastError` + `resetForRetry` only | 2, 3, 6 |
| `apps/api/src/outbox/domain/outbox-event.domain.ts` | new row shape; drop `OUTBOX_BACKOFF_MS`, `OUTBOX_REPOSITORY` | 3 |
| `apps/api/src/outbox/outbox.service.ts` | transitional `enqueue()` adapter (Task 3), **deleted** in Task 6 | 3, 6 |
| `apps/api/src/outbox/outbox-processor.ts`, `outbox-service-full.spec.ts`, `outbox-processor.spec.ts` | **deleted** | 3 |
| `apps/api/src/tickets/tickets.service.ts` | ticket events recorded inside the write's transaction | 4 |
| `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` | status event + webhook rows inside the transition transaction | 4 |
| `apps/api/src/webhook/webhook-dispatcher.service.ts` | sequential `record()`, skips malformed webhooks | 4 |
| `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` | rollback leaves no outbox row; commit leaves exactly one | 4, 5 |
| `apps/api/src/koda-domain-writer/koda-domain-writer.service.ts` | event + outbox row in one transaction | 5 |
| `apps/api/src/vcs/vcs-webhook.service.ts`, `prisma-vcs.repository.ts` | `record()`; dedupe query on `type` | 3, 5 |
| `apps/api/src/outbox/outbox-admin.service.ts` (+ `.spec.ts`), `dto/outbox-list-query.dto.ts`, `admin.controller.ts` | admin list/retry with status validation, 404/409 | 6 |
| `apps/api/src/i18n/{en,zh}/outbox.json` | `404` message | 6 |
| `apps/cli/src/commands/admin.ts` | status help text | 6 |
| `apps/api/src/memory/prisma-memory-item.repository.ts` | replay of an identical fact is a no-op | 7 |
| `docs/architecture.md`, spec status line | docs | 8 |

---

### Task 1: Add the package and the outbox config

**Files:**
- Modify: `apps/api/package.json` (via `bun add`)
- Create: `apps/api/src/config/outbox.config.ts`
- Test: `apps/api/src/config/outbox.config.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `OUTBOX_CFG = 'outbox'`, `interface IOutboxConfig { relay: OutboxRelayConfig }`, `interface OutboxRelayConfig { enabled: boolean; pollIntervalMs: number; batchSize: number; leaseMs: number; maxAttempts: number; backoffBaseMs: number; backoffCapMs: number }`, `outboxConfig` (a `registerAs` factory). Task 3 reads it with `ConfigService.get<IOutboxConfig>(OUTBOX_CFG)`.

- [ ] **Step 1: Add the dependency**

Run: `cd apps/api && bun add @nathapp/nestjs-outbox@^3.3.0`
Expected: `apps/api/package.json` gains `"@nathapp/nestjs-outbox": "^3.3.0"` next to the other `@nathapp/nestjs-*` entries; `bun.lock` updates.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/config/outbox.config.spec.ts`:

```ts
import { outboxConfig, IOutboxConfig } from './outbox.config';

describe('outboxConfig', () => {
  const saved = {
    NODE_ENV: process.env['NODE_ENV'],
    OUTBOX_RELAY_ENABLED: process.env['OUTBOX_RELAY_ENABLED'],
  };

  const restore = (key: keyof typeof saved): void => {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    restore('NODE_ENV');
    restore('OUTBOX_RELAY_ENABLED');
  });

  it('uses the slice-2 relay settings', () => {
    const cfg: IOutboxConfig = outboxConfig();
    expect(cfg.relay).toMatchObject({
      pollIntervalMs: 1000,
      batchSize: 20,
      leaseMs: 30000,
      maxAttempts: 8,
      backoffBaseMs: 2000,
      backoffCapMs: 300000,
    });
  });

  it('enables the relay outside tests', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['OUTBOX_RELAY_ENABLED'];
    expect(outboxConfig().relay.enabled).toBe(true);
  });

  it('disables the relay under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['OUTBOX_RELAY_ENABLED'];
    expect(outboxConfig().relay.enabled).toBe(false);
  });

  it('OUTBOX_RELAY_ENABLED=true overrides NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['OUTBOX_RELAY_ENABLED'] = 'true';
    expect(outboxConfig().relay.enabled).toBe(true);
  });

  it('OUTBOX_RELAY_ENABLED=false disables the relay in production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['OUTBOX_RELAY_ENABLED'] = 'false';
    expect(outboxConfig().relay.enabled).toBe(false);
  });

  it('rejects a non-boolean OUTBOX_RELAY_ENABLED', () => {
    process.env['OUTBOX_RELAY_ENABLED'] = 'yes';
    expect(() => outboxConfig()).toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/config/outbox.config.spec.ts`
Expected: FAIL, `Cannot find module './outbox.config'`.

- [ ] **Step 4: Implement the config**

Create `apps/api/src/config/outbox.config.ts`:

```ts
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsIn, IsOptional } from 'class-validator';

export const OUTBOX_CFG = 'outbox';

export interface OutboxRelayConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
}

export interface IOutboxConfig {
  relay: OutboxRelayConfig;
}

export class OutboxConfigSchema {
  @IsOptional()
  @IsIn(['true', 'false'])
  OUTBOX_RELAY_ENABLED?: string;
}

/**
 * Relay settings for @nathapp/nestjs-outbox (Track 1 slice 2).
 * The relay polls unless running under Jest (NODE_ENV=test), where tests
 * drive it explicitly via OutboxRelay.dispatchPendingBatch().
 * OUTBOX_RELAY_ENABLED overrides the default in either direction.
 */
export const outboxConfig = registerAs(OUTBOX_CFG, (): IOutboxConfig => {
  validateUtil(process.env, OutboxConfigSchema);
  const override = process.env['OUTBOX_RELAY_ENABLED'];
  const enabled = override !== undefined ? override === 'true' : process.env['NODE_ENV'] !== 'test';
  return {
    relay: {
      enabled,
      pollIntervalMs: 1000,
      batchSize: 20,
      leaseMs: 30000,
      maxAttempts: 8,
      backoffBaseMs: 2000,
      backoffCapMs: 300000,
    },
  };
});
```

- [ ] **Step 5: Register it**

In `apps/api/src/config/env.validation.ts`, add after the `RAG_IN_MEMORY_ONLY` entry:

```ts
  OUTBOX_RELAY_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .optional(),
```

In `apps/api/src/app.module.ts`, add `import { outboxConfig } from './config/outbox.config';` and append `outboxConfig` to the `load` array: `load: [appConfig, authConfig, databaseConfig, ragConfig, vcsConfig, outboxConfig, ServerSecurityConfig],`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/config`
Expected: PASS (all config specs, including the 6 new ones).

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json bun.lock apps/api/src/config/outbox.config.ts apps/api/src/config/outbox.config.spec.ts apps/api/src/config/env.validation.ts apps/api/src/app.module.ts
git commit -m "feat(outbox): add @nathapp/nestjs-outbox and relay config"
```

---

### Task 2: `FanOutPublisher` replaces `OutboxFanOutRegistry` (M4)

The registry becomes the package's `IOutboxPublisher`. It throws one aggregate error when any handler fails and records `lastError`. The singleton `lastDispatchFailureCount` is deleted. The legacy `OutboxService` (deleted in Task 3) switches to `publish()` so this task ships green on the old schema; `lastError` already exists there.

**Files:**
- Create: `apps/api/src/outbox/fan-out-publisher.ts`, `apps/api/src/outbox/fan-out-publisher.spec.ts`, `apps/api/test/helpers/outbox-record.ts`
- Delete: `apps/api/src/outbox/outbox-fan-out-registry.ts`, `apps/api/src/outbox/outbox-fan-out-registry.spec.ts`
- Modify: `apps/api/src/outbox/prisma-outbox.repository.ts` (add `recordLastError`), `apps/api/src/outbox/outbox.service.ts` (`processEvent` → `publish`), `apps/api/src/outbox/outbox.module.ts`, `apps/api/src/outbox/outbox.module.spec.ts`
- Modify (type swap `OutboxFanOutRegistry` → `FanOutPublisher`): `src/webhook/webhook-outbox.subscriber.ts`, `src/memory/memory-outbox.subscriber.ts`, `src/entity-graph/entity-graph-outbox.subscriber.ts`, `src/code-intel/code-intel-outbox.subscriber.ts`, `src/rag/rag.module.ts` (two classes)
- Modify tests: the four `*-outbox.subscriber.spec.ts`, `src/outbox/outbox.service.spec.ts`, `src/outbox/outbox-service-full.spec.ts`, `test/integration/ast-index/code-commit-handler.integration.spec.ts`, `test/integration/entity-graph/outbox-fanout-entity-graph.integration.spec.ts`, `test/integration/memory/outbox-envelope.integration.spec.ts`, `test/integration/memory/outbox-fanout-extraction.integration.spec.ts`

**Interfaces:**
- Consumes: `OutboxRecord`, `IOutboxPublisher`, `OutboxStatus` from `@nathapp/nestjs-outbox` (Task 1).
- Produces:
  - `type OutboxHandlerFn = (payload: unknown) => void | Promise<void>`
  - `class OutboxFanOutError extends Error { readonly type: string; readonly failures: readonly string[] }`
  - `const OUTBOX_LAST_ERROR_MAX_LENGTH = 2000`
  - `class FanOutPublisher implements IOutboxPublisher` with `register(type: string, handler: OutboxHandlerFn): void`, `unregister(type: string, handler: OutboxHandlerFn): void`, `getHandlers(type: string): readonly OutboxHandlerFn[]`, `publish(record: OutboxRecord): Promise<void>`. Constructor: `(@Inject(PrismaOutboxRepository) lastErrors: Pick<PrismaOutboxRepository, 'recordLastError'>)`.
  - `PrismaOutboxRepository.recordLastError(id: string, message: string): Promise<void>`
  - Test helper `outboxRecord(type: string, payload: unknown, overrides?: Partial<OutboxRecord>): OutboxRecord` and `noopLastErrors: Pick<PrismaOutboxRepository, 'recordLastError'>`.

- [ ] **Step 1: Add the test helper**

Create `apps/api/test/helpers/outbox-record.ts`:

```ts
import { OutboxRecord, OutboxStatus } from '@nathapp/nestjs-outbox';
import type { PrismaOutboxRepository } from '../../src/outbox/prisma-outbox.repository';

/** A claimed outbox record, as the relay hands it to the publisher. */
export function outboxRecord(
  type: string,
  payload: unknown,
  overrides: Partial<OutboxRecord> = {},
): OutboxRecord {
  const now = new Date();
  return {
    id: 'outbox-test-record',
    type,
    payload,
    status: OutboxStatus.PROCESSING,
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    ...overrides,
  };
}

/** FanOutPublisher dependency for tests that do not assert lastError writes. */
export const noopLastErrors: Pick<PrismaOutboxRepository, 'recordLastError'> = {
  recordLastError: async (): Promise<void> => undefined,
};
```

- [ ] **Step 2: Write the failing publisher test**

Create `apps/api/src/outbox/fan-out-publisher.spec.ts`:

```ts
import { FanOutPublisher, OutboxFanOutError, OUTBOX_LAST_ERROR_MAX_LENGTH } from './fan-out-publisher';
import { outboxRecord } from '../../test/helpers/outbox-record';

describe('FanOutPublisher', () => {
  let recordLastError: jest.Mock;
  let publisher: FanOutPublisher;

  beforeEach(() => {
    recordLastError = jest.fn().mockResolvedValue(undefined);
    publisher = new FanOutPublisher({ recordLastError });
  });

  it('calls every handler for the record type with the payload, in registration order', async () => {
    const first = jest.fn();
    const second = jest.fn();
    publisher.register('ticket_event', first);
    publisher.register('ticket_event', second);

    await publisher.publish(outboxRecord('ticket_event', { id: 'e1' }));

    expect(first).toHaveBeenCalledWith({ id: 'e1' });
    expect(second).toHaveBeenCalledWith({ id: 'e1' });
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
    expect(recordLastError).not.toHaveBeenCalled();
  });

  it('ignores handlers registered for other types', async () => {
    const other = jest.fn();
    publisher.register('agent_event', other);

    await publisher.publish(outboxRecord('ticket_event', {}));

    expect(other).not.toHaveBeenCalled();
  });

  it('resolves when no handler is registered for the type', async () => {
    await expect(publisher.publish(outboxRecord('unknown_type', {}))).resolves.toBeUndefined();
  });

  it('runs the remaining handlers after one fails, then rejects with one aggregate error', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('boom'));
    const after = jest.fn();
    publisher.register('ticket_event', failing);
    publisher.register('ticket_event', after);

    const result = publisher.publish(outboxRecord('ticket_event', {}, { id: 'row-1' }));

    await expect(result).rejects.toBeInstanceOf(OutboxFanOutError);
    await expect(result).rejects.toThrow('1 fan-out handler(s) failed for ticket_event: boom');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('records lastError for the failed record before rejecting', async () => {
    publisher.register('ticket_event', () => {
      throw new Error('handler exploded');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}, { id: 'row-2' }))).rejects.toThrow();

    expect(recordLastError).toHaveBeenCalledWith('row-2', '1 fan-out handler(s) failed for ticket_event: handler exploded');
  });

  it('truncates lastError to OUTBOX_LAST_ERROR_MAX_LENGTH characters', async () => {
    publisher.register('ticket_event', () => {
      throw new Error('x'.repeat(10_000));
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}))).rejects.toThrow();

    const [, message] = recordLastError.mock.calls[0] as [string, string];
    expect(message.length).toBe(OUTBOX_LAST_ERROR_MAX_LENGTH);
  });

  it('still rejects with the handler failure when writing lastError fails', async () => {
    recordLastError.mockRejectedValue(new Error('db down'));
    publisher.register('ticket_event', () => {
      throw new Error('handler failed');
    });

    await expect(publisher.publish(outboxRecord('ticket_event', {}))).rejects.toThrow('handler failed');
  });

  it('M4: a concurrent failing publish does not affect a succeeding one', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    publisher.register('slow_ok', async () => {
      await gate;
    });
    publisher.register('fails', () => {
      throw new Error('nope');
    });

    const ok = publisher.publish(outboxRecord('slow_ok', {}, { id: 'ok' }));
    const bad = publisher.publish(outboxRecord('fails', {}, { id: 'bad' }));
    await expect(bad).rejects.toThrow('nope');
    release();

    await expect(ok).resolves.toBeUndefined();
    expect(recordLastError).toHaveBeenCalledTimes(1);
    expect(recordLastError).toHaveBeenCalledWith('bad', expect.any(String));
  });

  it('registers a given handler only once per type and unregisters it', async () => {
    const handler = jest.fn();
    publisher.register('ticket_event', handler);
    publisher.register('ticket_event', handler);
    expect(publisher.getHandlers('ticket_event')).toHaveLength(1);

    publisher.unregister('ticket_event', handler);

    expect(publisher.getHandlers('ticket_event')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/outbox/fan-out-publisher.spec.ts`
Expected: FAIL, `Cannot find module './fan-out-publisher'`.

- [ ] **Step 4: Add `recordLastError` to the repository**

In `apps/api/src/outbox/prisma-outbox.repository.ts`, add this method to `PrismaOutboxRepository`:

```ts
  /** Writes the latest fan-out failure for the admin view. A missing row is a no-op. */
  async recordLastError(id: string, message: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id },
      data: { lastError: message },
    });
  }
```

- [ ] **Step 5: Implement the publisher**

Create `apps/api/src/outbox/fan-out-publisher.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IOutboxPublisher, OutboxRecord } from '@nathapp/nestjs-outbox';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

export type OutboxHandlerFn = (payload: unknown) => void | Promise<void>;

export const OUTBOX_LAST_ERROR_MAX_LENGTH = 2000;

export class OutboxFanOutError extends Error {
  constructor(
    readonly type: string,
    readonly failures: readonly string[],
  ) {
    super(`${failures.length} fan-out handler(s) failed for ${type}: ${failures.join('; ')}`);
    this.name = 'OutboxFanOutError';
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The outbox publisher for @nathapp/nestjs-outbox. Consumers register
 * per-type handlers in onModuleInit. publish() runs every handler for the
 * record's type; if any fail it records lastError and throws one aggregate
 * error, so the relay retries the event (all handlers run again: consumers
 * must be idempotent).
 */
@Injectable()
export class FanOutPublisher implements IOutboxPublisher, OnModuleInit {
  private readonly logger = new Logger(FanOutPublisher.name);
  private handlers: ReadonlyMap<string, readonly OutboxHandlerFn[]> = new Map();

  constructor(
    @Inject(PrismaOutboxRepository)
    private readonly lastErrors: Pick<PrismaOutboxRepository, 'recordLastError'>,
  ) {}

  onModuleInit(): void {
    const total = [...this.handlers.values()].reduce((count, list) => count + list.length, 0);
    this.logger.log(`Registered ${total} handlers`);
  }

  register(type: string, handler: OutboxHandlerFn): void {
    const existing = this.getHandlers(type);
    if (existing.includes(handler)) return;
    this.handlers = new Map([...this.handlers, [type, [...existing, handler]]]);
  }

  unregister(type: string, handler: OutboxHandlerFn): void {
    const remaining = this.getHandlers(type).filter((h) => h !== handler);
    const next = new Map(this.handlers);
    if (remaining.length > 0) next.set(type, remaining);
    else next.delete(type);
    this.handlers = next;
  }

  getHandlers(type: string): readonly OutboxHandlerFn[] {
    return this.handlers.get(type) ?? [];
  }

  async publish(record: OutboxRecord): Promise<void> {
    const failures: string[] = [];
    for (const handler of this.getHandlers(record.type)) {
      try {
        await handler(record.payload);
      } catch (err) {
        const message = errorMessage(err);
        this.logger.error(`Handler for ${record.type} failed on outbox event ${record.id}: ${message}`);
        failures.push(message);
      }
    }
    if (failures.length === 0) return;

    const error = new OutboxFanOutError(record.type, failures);
    try {
      await this.lastErrors.recordLastError(record.id, error.message.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH));
    } catch (err) {
      this.logger.warn(`Could not record lastError for outbox event ${record.id}: ${errorMessage(err)}`);
    }
    throw error;
  }
}
```

The old `DEFAULT_HANDLERS` (a log-only `document_indexed` handler) is intentionally dropped: an event type with no handlers publishes successfully.

- [ ] **Step 6: Run the publisher test**

Run: `cd apps/api && bunx jest src/outbox/fan-out-publisher.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Switch the legacy service and the module**

In `apps/api/src/outbox/outbox.service.ts`:
- Replace the `OutboxFanOutRegistry` import and constructor parameter with `private readonly publisher: FanOutPublisher` (import from `./fan-out-publisher`), and add `import { OutboxStatus } from '@nathapp/nestjs-outbox';`.
- In `processPending`, change `await this.processEvent(event as unknown as Record<string, unknown>);` to `await this.processEvent(event);`.
- Replace `processEvent` with:

```ts
  async processEvent(event: OutboxEventData): Promise<void> {
    await this.publisher.publish({
      id: event.id,
      type: event.eventType,
      payload: JSON.parse(event.payload || '{}'),
      status: OutboxStatus.PROCESSING,
      attempts: event.attempts,
      createdAt: event.createdAt,
      nextAttemptAt: event.nextAttemptAt ?? new Date(),
    });
  }
```

In `apps/api/src/outbox/outbox.module.ts`, replace `OutboxFanOutRegistry` with `FanOutPublisher` in the import, `providers` and `exports`.

Delete `apps/api/src/outbox/outbox-fan-out-registry.ts` and `apps/api/src/outbox/outbox-fan-out-registry.spec.ts` (the behaviors they pinned are covered by `fan-out-publisher.spec.ts`; the failure-swallowing ones are intentionally reversed).

Rewrite `apps/api/src/outbox/outbox.module.spec.ts` as a DI smoke test for the new provider:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { FanOutPublisher } from './fan-out-publisher';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { noopLastErrors } from '../../test/helpers/outbox-record';

describe('FanOutPublisher (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves with only its repository dependency supplied', async () => {
    moduleRef = await Test.createTestingModule({
      providers: [FanOutPublisher, { provide: PrismaOutboxRepository, useValue: noopLastErrors }],
    }).compile();

    expect(moduleRef.get(FanOutPublisher)).toBeInstanceOf(FanOutPublisher);
  });
});
```

(Task 3 replaces this file with the full module spec.)

- [ ] **Step 8: Swap the subscriber type**

In each of these files, replace `import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';` with `import { FanOutPublisher } from '../outbox/fan-out-publisher';` and the constructor parameter type `OutboxFanOutRegistry` with `FanOutPublisher`. The `register(...)` calls are unchanged.
- `src/webhook/webhook-outbox.subscriber.ts`
- `src/memory/memory-outbox.subscriber.ts`
- `src/entity-graph/entity-graph-outbox.subscriber.ts`
- `src/code-intel/code-intel-outbox.subscriber.ts`
- `src/rag/rag.module.ts` (`LexicalIndexWarmup` and `EntityStoreWarmup` both take `outboxFanOutRegistry: OutboxFanOutRegistry`; keep the parameter names, change the type)

Verify nothing else references the old symbol:

Run: `cd apps/api && grep -rn "OutboxFanOutRegistry\|outbox-fan-out-registry\|consumeLastDispatchFailureCount" src test`
Expected: matches only in the test files updated in Step 9.

- [ ] **Step 9: Update the tests that built the registry**

Apply the same two mechanical substitutions in each file below:
1. `new OutboxFanOutRegistry()` → `new FanOutPublisher(noopLastErrors)`; a Nest provider `OutboxFanOutRegistry` → `FanOutPublisher` plus `{ provide: PrismaOutboxRepository, useValue: noopLastErrors }`. Import `noopLastErrors`/`outboxRecord` from `test/helpers/outbox-record` (relative path).
2. `x.dispatch({ eventType: T, payload: P })` → `x.publish(outboxRecord(T, P))`.

Also update the stale doc comment at `src/webhook/webhook-delivery.handler.spec.ts:25` that points at `src/outbox/outbox-fan-out-registry.spec.ts` (point it at `src/outbox/fan-out-publisher.spec.ts`).

Files: `src/webhook/webhook-outbox.subscriber.spec.ts`, `src/memory/memory-outbox.subscriber.spec.ts`, `src/entity-graph/entity-graph-outbox.subscriber.spec.ts`, `src/code-intel/code-intel-outbox.subscriber.spec.ts`, `test/integration/ast-index/code-commit-handler.integration.spec.ts`, `test/integration/entity-graph/outbox-fanout-entity-graph.integration.spec.ts`, `test/integration/memory/outbox-envelope.integration.spec.ts`, `test/integration/memory/outbox-fanout-extraction.integration.spec.ts`.

Behavior change to apply by hand: `dispatch()` swallowed handler errors, `publish()` rejects. Any assertion of the form "dispatch resolves even though the handler threw" becomes `await expect(x.publish(...)).rejects.toThrow(...)`.

In `src/outbox/outbox.service.spec.ts` and `src/outbox/outbox-service-full.spec.ts` (both deleted in Task 3, so keep edits minimal): replace the registry mock `{ dispatch, consumeLastDispatchFailureCount }` with `{ publish: jest.fn().mockResolvedValue(undefined) }`. A test that simulated a handler failure through `consumeLastDispatchFailureCount.mockReturnValue(1)` now uses `publish.mockRejectedValue(new Error('...'))`. Tests that asserted `dispatch` was called with `{ eventType, payload }` assert `publish` was called with `expect.objectContaining({ type, payload })`.

- [ ] **Step 10: Run the affected suites**

Run: `cd apps/api && bun run type-check && bunx jest src/outbox src/webhook src/memory src/entity-graph src/code-intel src/rag`
Expected: type-check clean; all PASS.

Run: `cd apps/api && bun run test:db:up && bun run test:integration`
Expected: PASS (same pass/skip counts as `main` plus nothing new failing).

- [ ] **Step 11: Commit**

```bash
git add -A apps/api/src apps/api/test
git commit -m "refactor(outbox): FanOutPublisher replaces the registry, aggregate failures (M4)"
```

---

### Task 3: Reshape `OutboxEvent`, add `PrismaOutboxStore`, cut over to the package relay

After this task the package relay processes the outbox. koda's `OutboxService` shrinks to a transitional `enqueue()` adapter plus admin reads so producers compile unchanged (Tasks 4-5 move them to `record()`, Task 6 deletes the adapter). The 5 s cron, in-loop backoff, per-row optimistic claim and stale-requeue are deleted.

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260926090000_outbox_nestjs_outbox/migration.sql`
- Create: `apps/api/test/integration/outbox/outbox-migration.integration.spec.ts`
- Create: `apps/api/src/outbox/prisma-outbox.store.ts`, `apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts`
- Create: `apps/api/src/outbox/outbox-core.module.ts`, `apps/api/src/outbox/outbox-admin.module.ts`, `apps/api/test/integration/outbox/outbox-relay.integration.spec.ts`
- Modify: `apps/api/src/outbox/outbox.module.ts`, `apps/api/src/outbox/outbox.module.spec.ts`, `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/outbox/outbox.service.spec.ts`, `apps/api/src/outbox/prisma-outbox.repository.ts`, `apps/api/src/outbox/prisma-outbox.repository.spec.ts`, `apps/api/src/outbox/domain/outbox-event.domain.ts`, `apps/api/src/outbox/admin.controller.spec.ts`, `apps/api/src/vcs/prisma-vcs.repository.ts`, `apps/api/src/app.module.ts`, `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts`, `apps/api/test/integration/outbox-event-schema/outbox-event-schema.validation.integration.spec.ts`, `apps/api/test/e2e/transaction-manager-wiring.e2e.spec.ts`
- Delete: `apps/api/src/outbox/outbox-processor.ts`, `apps/api/src/outbox/outbox-processor.spec.ts`, `apps/api/src/outbox/outbox-service-full.spec.ts`

**Interfaces:**
- Consumes: `FanOutPublisher`, `PrismaOutboxRepository.recordLastError` (Task 2); `outboxConfig`, `OUTBOX_CFG`, `IOutboxConfig` (Task 1).
- Produces:
  - `class PrismaOutboxStore implements IOutboxStore` — `save(record: OutboxRecord, client: unknown): Promise<void>`, `claimBatch(limit: number, leaseMs: number, now: Date, owner: string): Promise<OutboxRecord[]>`, `markPublished(id: string, publishedAt: Date, owner: string): Promise<void>`, `markRetry(id: string, attempts: number, nextAttemptAt: Date, owner: string): Promise<void>`, `markDead(id: string, attempts: number, owner: string): Promise<void>`.
  - `OutboxCoreModule` (exports `PrismaOutboxRepository`, `PrismaOutboxStore`, `FanOutPublisher`); koda `OutboxModule` (imports core + `NathappOutboxModule.registerAsync`, exports core). The package's `OutboxService` and `OutboxRelay` are global.
  - `OutboxAdminModule` (hosts `AdminController`).
  - `PrismaOutboxRepository.findByStatus(status: string, limit: number): Promise<OutboxEventDomain[]>`, `resetForRetry(id: string, now: Date): Promise<number>`, `recordLastError(id, message)`.
  - koda `OutboxService` (transitional): `enqueue(event: OutboxEventInput): Promise<void>`, `getPendingEvents(limit?)`, `getEventsByStatus(status, limit?)`, `retryEvent(eventId): Promise<void>`.
  - `OutboxEventDomain` fields: `id, projectId, type, eventId, payload, headers, status, attempts, nextAttemptAt: Date, leaseUntil, owner, lastError, publishedAt, createdAt, updatedAt`.

- [ ] **Step 1: Write the failing migration test**

`test/global-setup.ts` builds the test DB with `prisma db push`, which never runs migration SQL. This test runs the real migration files against a scratch schema so the data rewrite is exercised.

Create `apps/api/test/integration/outbox/outbox-migration.integration.spec.ts`:

```ts
/**
 * Track 1 slice 2: the OutboxEvent reshape migration rewrites legacy rows.
 * Applies the init migration and the slice-2 migration to a scratch schema.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- outbox-migration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const MIGRATIONS_DIR = join(__dirname, '../../../prisma/migrations');
const INIT = '20260925151610_init';
const SLICE_2 = '20260926090000_outbox_nestjs_outbox';
const SCHEMA = 'outbox_migration_test';

/** Migration SQL → statements. Comment lines are dropped first; no statement contains a literal ';'. */
function statements(migration: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

interface MigratedRow {
  id: string;
  type: string;
  status: string;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  leaseUntil: Date | null;
  owner: string | null;
}

describeIntegration('OutboxEvent slice-2 migration', () => {
  const baseUrl = process.env.DATABASE_URL as string;
  let admin: PrismaClient;
  let db: PrismaClient;
  const before = new Date();

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);

    db = new PrismaClient({ datasources: { db: { url: withSchema(baseUrl, SCHEMA) } } });
    for (const sql of statements(INIT)) {
      await db.$executeRawUnsafe(sql);
    }

    await db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', CURRENT_TIMESTAMP)`,
    );
    // Legacy shapes the old processor could leave behind.
    await db.$executeRawUnsafe(`
      INSERT INTO "OutboxEvent" ("id", "projectId", "eventType", "eventId", "payload", "status", "attempts", "nextAttemptAt", "processedAt", "updatedAt") VALUES
        ('done',    'p1', 'ticket_event', 'e1', '{}', 'completed',   1, NULL, '2026-09-01 00:00:00', CURRENT_TIMESTAMP),
        ('dead',    'p1', 'ticket_event', 'e2', '{}', 'dead_letter', 3, NULL, NULL,                  CURRENT_TIMESTAMP),
        ('failed',  'p1', 'code_commit',  'e3', '{}', 'failed',      1, '2099-01-01 00:00:00', NULL, CURRENT_TIMESTAMP),
        ('stuck',   'p1', 'ticket_event', 'e4', '{}', 'processing',  0, NULL, NULL,                  CURRENT_TIMESTAMP),
        ('waiting', 'p1', 'agent_event',  'e5', '{}', 'pending',     0, NULL, NULL,                  CURRENT_TIMESTAMP)
    `);

    for (const sql of statements(SLICE_2)) {
      await db.$executeRawUnsafe(sql);
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.$disconnect();
  });

  const row = async (id: string): Promise<MigratedRow> => {
    const rows = await db.$queryRawUnsafe<MigratedRow[]>(
      `SELECT "id", "type", "status", "nextAttemptAt", "publishedAt", "leaseUntil", "owner" FROM "OutboxEvent" WHERE "id" = $1`,
      id,
    );
    return rows[0];
  };

  it('renames eventType to type and processedAt to publishedAt, keeping values', async () => {
    const done = await row('done');
    expect(done.type).toBe('ticket_event');
    expect(done.publishedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });

  it('maps completed to published and dead_letter to dead', async () => {
    expect((await row('done')).status).toBe('published');
    expect((await row('dead')).status).toBe('dead');
  });

  it('requeues failed rows immediately, even with a far-future nextAttemptAt', async () => {
    const failed = await row('failed');
    expect(failed.status).toBe('pending');
    expect(failed.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000);
  });

  it('requeues lease-less processing rows so the new claim query can reach them', async () => {
    const stuck = await row('stuck');
    expect(stuck.status).toBe('pending');
    expect(stuck.leaseUntil).toBeNull();
    expect(stuck.owner).toBeNull();
    expect(stuck.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('backfills a null nextAttemptAt so pending rows stay claimable', async () => {
    const waiting = await row('waiting');
    expect(waiting.status).toBe('pending');
    expect(waiting.nextAttemptAt).not.toBeNull();
    expect(waiting.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('makes nextAttemptAt NOT NULL and adds headers, leaseUntil and owner', async () => {
    const columns = await db.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'OutboxEvent'`,
      SCHEMA,
    );
    const byName = new Map(columns.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.get('nextAttemptAt')).toBe('NO');
    expect(byName.has('headers')).toBe(true);
    expect(byName.has('leaseUntil')).toBe(true);
    expect(byName.has('owner')).toBe(true);
    expect(byName.has('eventType')).toBe(false);
    expect(byName.has('processedAt')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx jest test/integration/outbox/outbox-migration`
Expected: FAIL, `ENOENT … 20260926090000_outbox_nestjs_outbox/migration.sql`.

- [ ] **Step 3: Reshape the model**

In `apps/api/prisma/schema.prisma`, replace the `OutboxEvent` model with:

```prisma
model OutboxEvent {
  id            String    @id @default(cuid())
  projectId     String
  type          String    // ticket_event | agent_event | decision_event | document_indexed | graphify_import | code_commit | webhook_delivery
  eventId       String    // canonical record ID this outbox event originated from
  payload       String    @default("{}") // JSON stored as string
  headers       String?   // JSON stored as string
  status        String    @default("pending") // pending | processing | published | dead (@nathapp/nestjs-outbox OutboxStatus)
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  leaseUntil    DateTime?
  owner         String?
  lastError     String?
  publishedAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  project       Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@index([projectId, createdAt])
  @@index([status, nextAttemptAt])
}
```

`(status, createdAt)` stays: the admin list filters by status and orders by `createdAt`.

- [ ] **Step 4: Write the migration by hand**

Do **not** use `prisma migrate dev`: it would drop and re-add the renamed columns and lose their data.

Create `apps/api/prisma/migrations/20260926090000_outbox_nestjs_outbox/migration.sql` (no `;` inside comments: the migration test splits on it):

```sql
-- Track 1 slice 2: reshape OutboxEvent for @nathapp/nestjs-outbox

-- Renames keep existing values
ALTER TABLE "OutboxEvent" RENAME COLUMN "eventType" TO "type";
ALTER TABLE "OutboxEvent" RENAME COLUMN "processedAt" TO "publishedAt";

-- Lease and header columns
ALTER TABLE "OutboxEvent" ADD COLUMN "headers" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3), ADD COLUMN "owner" TEXT;

-- Status vocabulary: completed -> published, dead_letter -> dead
UPDATE "OutboxEvent" SET "status" = 'published' WHERE "status" = 'completed';
UPDATE "OutboxEvent" SET "status" = 'dead' WHERE "status" = 'dead_letter';

-- failed rows and lease-less processing rows from the old processor are retried now
UPDATE "OutboxEvent" SET "status" = 'pending', "nextAttemptAt" = CURRENT_TIMESTAMP WHERE "status" IN ('failed', 'processing');

-- nextAttemptAt becomes required
UPDATE "OutboxEvent" SET "nextAttemptAt" = "createdAt" WHERE "nextAttemptAt" IS NULL;
ALTER TABLE "OutboxEvent" ALTER COLUMN "nextAttemptAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "nextAttemptAt" SET NOT NULL;
```

Run: `cd apps/api && bunx prisma generate`
Expected: `Generated Prisma Client`.

- [ ] **Step 5: Run the migration test**

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/outbox/outbox-migration`
Expected: PASS (6 tests).

- [ ] **Step 6: Prove the migrations match the schema (no drift)**

Run:
```bash
cd apps/api
docker compose -f ../../docker-compose.test.yml exec -T postgres-test createdb -U koda koda_shadow 2>/dev/null || true
bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow --exit-code
```
Expected: `No difference detected.` and exit code 0. If it prints a diff, fix `migration.sql` (not the schema) until it is clean.

- [ ] **Step 7: Write the failing store tests**

Create `apps/api/test/integration/outbox/prisma-outbox-store.integration.spec.ts`:

```ts
/**
 * PrismaOutboxStore on real Postgres (Track 1 slice 2).
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- prisma-outbox-store
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { OutboxService as NathappOutboxService, OutboxStatus } from '@nathapp/nestjs-outbox';
import { PrismaOutboxStore } from '../../../src/outbox/prisma-outbox.store';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('PrismaOutboxStore', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let txManager: ITransactionManager;
  let store: PrismaOutboxStore;
  let outbox: NathappOutboxService;
  let projectId: string;

  const t0 = new Date('2026-09-26T10:00:00.000Z');
  const at = (ms: number): Date => new Date(t0.getTime() + ms);

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [PrismaOutboxStore],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    txManager = module.get(TRANSACTION_MANAGER);
    store = module.get(PrismaOutboxStore);
    outbox = new NathappOutboxService(store, txManager);
    const project = await prisma.client.project.create({ data: { name: 'Outbox', slug: 'outbox-store', key: 'OBX' } });
    projectId = project.id;
  });

  beforeEach(async () => {
    await prisma.client.outboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  /** Inserts a pending row directly, due at `due`. */
  const seed = async (id: string, due: Date, overrides: Record<string, unknown> = {}): Promise<void> => {
    await prisma.client.outboxEvent.create({
      data: { id, projectId, type: 'ticket_event', eventId: id, payload: '{"n":1}', nextAttemptAt: due, createdAt: due, ...overrides },
    });
  };

  describe('save (via the package OutboxService.record)', () => {
    it('writes projectId and eventId columns from metadata, payload as JSON text', async () => {
      await txManager.run(() =>
        outbox.record({ type: 'ticket_event', payload: { a: 1 }, metadata: { projectId, eventId: 'evt-1' } }),
      );
      const rows = await prisma.client.outboxEvent.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ projectId, eventId: 'evt-1', type: 'ticket_event', payload: '{"a":1}', status: 'pending', attempts: 0 });
    });

    it('a rolled-back transaction leaves no outbox row', async () => {
      await expect(
        txManager.run(async () => {
          await outbox.record({ type: 'ticket_event', payload: {}, metadata: { projectId, eventId: 'evt-rb' } });
          throw new Error('business write failed');
        }),
      ).rejects.toThrow('business write failed');
      expect(await prisma.client.outboxEvent.count()).toBe(0);
    });

    it('rejects a record without metadata.projectId', async () => {
      await expect(outbox.record({ type: 'ticket_event', payload: {} })).rejects.toBeInstanceOf(ValidationAppException);
      expect(await prisma.client.outboxEvent.count()).toBe(0);
    });

    it('falls back to the record id when metadata.eventId is absent', async () => {
      const record = await outbox.record({ type: 'ticket_event', payload: {}, metadata: { projectId } });
      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.eventId).toBe(record.id);
    });

    it('stores headers as JSON text', async () => {
      const record = await outbox.record({ type: 't', payload: {}, headers: { trace: 'abc' }, metadata: { projectId } });
      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.headers).toBe('{"trace":"abc"}');
    });
  });

  describe('claimBatch', () => {
    it('claims due pending rows oldest-due first, up to the limit, and leases them', async () => {
      await seed('b', at(-2000));
      await seed('a', at(-3000));
      await seed('c', at(-1000));
      await seed('future', at(60_000));

      const claimed = await store.claimBatch(2, 30_000, t0, 'owner-1');

      expect(claimed.map((r) => r.id)).toEqual(['a', 'b']);
      expect(claimed[0]).toMatchObject({ status: OutboxStatus.PROCESSING, owner: 'owner-1', payload: { n: 1 } });
      expect(claimed[0].leaseUntil).toEqual(at(30_000));
      expect(claimed[0].metadata).toEqual({ projectId, eventId: 'a' });
    });

    it('never returns the same row to two concurrent claimers', async () => {
      for (let i = 0; i < 10; i += 1) await seed(`r${i}`, at(-1000 - i));

      const [one, two] = await Promise.all([
        store.claimBatch(10, 30_000, t0, 'owner-a'),
        store.claimBatch(10, 30_000, t0, 'owner-b'),
      ]);

      const ids = [...one, ...two].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(10);
    });

    it('does not reclaim a row whose lease is still live', async () => {
      await seed('leased', at(-1000));
      await store.claimBatch(10, 30_000, t0, 'owner-a');

      expect(await store.claimBatch(10, 30_000, at(10_000), 'owner-b')).toHaveLength(0);
    });

    it('reclaims a row whose lease expired', async () => {
      await seed('expired', at(-1000));
      await store.claimBatch(10, 1_000, t0, 'owner-a');

      const reclaimed = await store.claimBatch(10, 30_000, at(5_000), 'owner-b');

      expect(reclaimed.map((r) => r.id)).toEqual(['expired']);
      expect(reclaimed[0].owner).toBe('owner-b');
    });

    it('never claims published or dead rows', async () => {
      await seed('pub', at(-1000), { status: 'published' });
      await seed('dead', at(-1000), { status: 'dead' });

      expect(await store.claimBatch(10, 30_000, t0, 'owner-a')).toHaveLength(0);
    });

    it('hands over a row with unparseable payload as the raw string instead of throwing', async () => {
      await seed('bad-json', at(-1000), { payload: 'not-json{' });

      const claimed = await store.claimBatch(10, 30_000, t0, 'owner-a');

      expect(claimed).toHaveLength(1);
      expect(claimed[0].payload).toBe('not-json{');
    });
  });

  describe('state transitions are owner-checked', () => {
    it('markPublished by a stale owner is a no-op, by the current owner publishes', async () => {
      await seed('race', at(-1000));
      await store.claimBatch(10, 1_000, t0, 'stale');
      await store.claimBatch(10, 30_000, at(5_000), 'current');

      await store.markPublished('race', at(6_000), 'stale');
      let row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'race' } });
      expect(row).toMatchObject({ status: 'processing', owner: 'current' });

      await store.markPublished('race', at(7_000), 'current');
      row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'race' } });
      expect(row).toMatchObject({ status: 'published', owner: null, leaseUntil: null, publishedAt: at(7_000) });
    });

    it('markRetry requeues with backoff, keeps lastError, and the row is not claimable before nextAttemptAt', async () => {
      await seed('retry', at(-1000), { lastError: 'handler failed' });
      await store.claimBatch(10, 30_000, t0, 'owner-a');

      await store.markRetry('retry', 1, at(4_000), 'owner-a');

      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'retry' } });
      expect(row).toMatchObject({ status: 'pending', attempts: 1, owner: null, leaseUntil: null, lastError: 'handler failed', nextAttemptAt: at(4_000) });
      expect(await store.claimBatch(10, 30_000, at(3_999), 'owner-b')).toHaveLength(0);
      expect(await store.claimBatch(10, 30_000, at(4_000), 'owner-b')).toHaveLength(1);
    });

    it('markDead moves the row to dead with the final attempt count', async () => {
      await seed('doomed', at(-1000));
      await store.claimBatch(10, 30_000, t0, 'owner-a');

      await store.markDead('doomed', 8, 'owner-a');

      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'doomed' } });
      expect(row).toMatchObject({ status: 'dead', attempts: 8, owner: null, leaseUntil: null });
    });

    it('markRetry and markDead by a stale owner are no-ops', async () => {
      await seed('guarded', at(-1000));
      await store.claimBatch(10, 30_000, t0, 'current');

      await store.markRetry('guarded', 1, at(4_000), 'someone-else');
      await store.markDead('guarded', 8, 'someone-else');

      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'guarded' } });
      expect(row).toMatchObject({ status: 'processing', owner: 'current', attempts: 0 });
    });
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/outbox/prisma-outbox-store`
Expected: FAIL, `Cannot find module '../../../src/outbox/prisma-outbox.store'`.

- [ ] **Step 9: Implement the store**

Create `apps/api/src/outbox/prisma-outbox.store.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { IOutboxStore, OutboxRecord, OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxEvent as OutboxEventModel, Prisma, PrismaClient } from '@prisma/client';

/**
 * IOutboxStore on Prisma/Postgres for @nathapp/nestjs-outbox.
 *
 * save() writes through the client the package passes in: the active
 * transaction client inside txManager.run, the root client outside it (in
 * which case the row commits on its own). claimBatch() is one UPDATE ...
 * FOR UPDATE SKIP LOCKED statement (Prisma has no SKIP LOCKED). Every state
 * write is guarded by owner, so a relay whose lease expired cannot overwrite
 * a newer claim.
 */
@Injectable()
export class PrismaOutboxStore implements IOutboxStore {
  private readonly logger = new Logger(PrismaOutboxStore.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async save(record: OutboxRecord, client: unknown): Promise<void> {
    const projectId = record.metadata?.['projectId'];
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new ValidationAppException({ projectId: 'outbox record metadata.projectId is required' }, 'outbox');
    }
    const eventId = record.metadata?.['eventId'];
    const db = (client ?? this.prisma.client) as PrismaClient;
    await db.outboxEvent.create({
      data: {
        id: record.id,
        projectId,
        type: record.type,
        eventId: typeof eventId === 'string' && eventId.length > 0 ? eventId : record.id,
        payload: JSON.stringify(record.payload ?? null),
        headers: record.headers ? JSON.stringify(record.headers) : null,
        status: record.status,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        createdAt: record.createdAt,
      },
    });
  }

  async claimBatch(limit: number, leaseMs: number, now: Date, owner: string): Promise<OutboxRecord[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.prisma.client.$queryRaw<OutboxEventModel[]>(Prisma.sql`
      UPDATE "OutboxEvent"
      SET "status" = 'processing', "owner" = ${owner}, "leaseUntil" = ${leaseUntil}, "updatedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "OutboxEvent"
        WHERE ("status" = 'pending' AND "nextAttemptAt" <= ${now})
           OR ("status" = 'processing' AND "leaseUntil" < ${now})
        ORDER BY "nextAttemptAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
    // RETURNING order is unspecified.
    return [...rows]
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .map((row) => this.toRecord(row));
  }

  async markPublished(id: string, publishedAt: Date, owner: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, owner, status: OutboxStatus.PROCESSING },
      data: { status: OutboxStatus.PUBLISHED, publishedAt, owner: null, leaseUntil: null, lastError: null },
    });
  }

  async markRetry(id: string, attempts: number, nextAttemptAt: Date, owner: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, owner, status: OutboxStatus.PROCESSING },
      data: { status: OutboxStatus.PENDING, attempts, nextAttemptAt, owner: null, leaseUntil: null },
    });
  }

  async markDead(id: string, attempts: number, owner: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, owner, status: OutboxStatus.PROCESSING },
      data: { status: OutboxStatus.DEAD, attempts, owner: null, leaseUntil: null },
    });
  }

  private toRecord(row: OutboxEventModel): OutboxRecord {
    return {
      id: row.id,
      type: row.type,
      payload: this.parseJson(row.id, row.payload),
      status: row.status as OutboxStatus,
      attempts: row.attempts,
      createdAt: row.createdAt,
      nextAttemptAt: row.nextAttemptAt,
      leaseUntil: row.leaseUntil ?? undefined,
      owner: row.owner ?? undefined,
      publishedAt: row.publishedAt ?? undefined,
      headers: row.headers ? (this.parseJson(row.id, row.headers) as Record<string, string>) : undefined,
      metadata: { projectId: row.projectId, eventId: row.eventId },
    };
  }

  /** A malformed row must not fail the whole claim: hand the raw text on and let its handlers fail. */
  private parseJson(id: string, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.logger.warn(`Outbox event ${id} has unparseable JSON; passing it on as raw text`);
      return text;
    }
  }
}
```

- [ ] **Step 10: Run the store tests**

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/outbox/prisma-outbox-store`
Expected: PASS (15 tests). If the `nextAttemptAt` boundary tests fail by exactly the server's UTC offset, the test Postgres is not running in UTC; see Global Constraints.

- [ ] **Step 11: Trim the repository and domain to admin concerns**

Replace `apps/api/src/outbox/domain/outbox-event.domain.ts` with:

```ts
export interface OutboxEventDomain {
  id: string;
  projectId: string;
  type: string;
  eventId: string;
  payload: string;
  headers: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  owner: string | null;
  lastError: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Transitional producer input for OutboxService.enqueue() (deleted in Task 6). */
export interface OutboxEventInput {
  projectId: string;
  eventType: string;
  eventId: string;
  payload: unknown;
}
```

(`OUTBOX_REPOSITORY` had no injector outside `outbox.module.ts`; `OUTBOX_BACKOFF_MS` belonged to the deleted in-loop retry.)

Rewrite `apps/api/src/outbox/prisma-outbox.repository.ts` so it keeps the `AbstractPrismaRepository` base and constructor, updates `toDomain`/`toPersistenceCreate`/`toPersistenceUpdate` to the new fields (`type`, `headers`, `leaseUntil`, `owner`, `publishedAt`; `nextAttemptAt` is non-null), deletes `enqueue`, `findPending`, `claimForProcessing`, `markCompleted`, `markFailed`, `markDeadLetter`, `retryEvent`, `incrementAttemptsAndRequeue`, `requeueStaleProcessing`, keeps `recordLastError` (Task 2), and has exactly these query methods:

```ts
  async findByStatus(status: string, limit: number): Promise<OutboxEventDomain[]> {
    const models = await this.prisma.client.outboxEvent.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return models.map((m) => this.toDomain(m));
  }

  /** Admin retry: back to pending, due now, lease and error cleared. Returns rows changed. */
  async resetForRetry(id: string, now: Date): Promise<number> {
    const result = await this.prisma.client.outboxEvent.updateMany({
      where: { id },
      data: { status: 'pending', attempts: 0, nextAttemptAt: now, owner: null, leaseUntil: null, lastError: null },
    });
    return result.count;
  }
```

Rewrite `apps/api/src/outbox/prisma-outbox.repository.spec.ts` (unit, mocked Prisma, same style as today) to cover: `findByStatus` passes `{ where: { status }, orderBy: { createdAt: 'asc' }, take }`; `resetForRetry` sends the data object above and returns `count`; `recordLastError` uses `updateMany({ where: { id }, data: { lastError } })`.

- [ ] **Step 12: Shrink koda's `OutboxService` to the transitional adapter**

Replace `apps/api/src/outbox/outbox.service.ts` with:

```ts
import { Injectable } from '@nestjs/common';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { OutboxEventDomain, OutboxEventInput } from './domain/outbox-event.domain';

export type { OutboxEventInput };

export type OutboxEventData = OutboxEventDomain;

const clampLimit = (limit: number): number => Math.max(Math.floor(limit), 0);

/**
 * Transitional (Track 1 slice 2). Producers still call enqueue(), which records
 * through @nathapp/nestjs-outbox. Tasks 4-5 move every producer to the
 * package's record() inside its write's transaction. Task 6 replaces the admin
 * methods with OutboxAdminService and deletes this class.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly outbox: NathappOutboxService,
    private readonly outboxRepo: PrismaOutboxRepository,
  ) {}

  async enqueue(event: OutboxEventInput): Promise<void> {
    await this.outbox.record({
      type: event.eventType,
      payload: event.payload,
      metadata: { projectId: event.projectId, eventId: event.eventId },
    });
  }

  async getPendingEvents(limit = 100): Promise<OutboxEventData[]> {
    return this.outboxRepo.findByStatus('pending', clampLimit(limit));
  }

  async getEventsByStatus(status: string, limit = 100): Promise<OutboxEventData[]> {
    return this.outboxRepo.findByStatus(status, clampLimit(limit));
  }

  async retryEvent(eventId: string): Promise<void> {
    await this.outboxRepo.resetForRetry(eventId, new Date());
  }
}
```

Rewrite `apps/api/src/outbox/outbox.service.spec.ts` to cover exactly these four methods with mocks: `enqueue` calls `record` with `{ type, payload, metadata: { projectId, eventId } }`; the two list methods call `findByStatus` with the clamped limit; `retryEvent` calls `resetForRetry(eventId, expect.any(Date))`.

Delete `apps/api/src/outbox/outbox-processor.ts`, `apps/api/src/outbox/outbox-processor.spec.ts`, `apps/api/src/outbox/outbox-service-full.spec.ts`.

In `apps/api/src/outbox/admin.controller.spec.ts`, replace status literals `'completed'` → `'published'` and `'dead_letter'` → `'dead'`, and `eventType` → `type` in fixture objects. No behavior change in this task.

In `apps/api/src/vcs/prisma-vcs.repository.ts`, `findPendingOutboxEvents`: change `eventType: query.eventType,` to `type: query.eventType,` (the query DTO keeps its field name).

- [ ] **Step 13: Wire the package**

Create `apps/api/src/outbox/outbox-core.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { FanOutPublisher } from './fan-out-publisher';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { PrismaOutboxStore } from './prisma-outbox.store';

/**
 * The outbox adapters koda supplies to @nathapp/nestjs-outbox. A separate
 * module so NathappOutboxModule.registerAsync can inject them from `imports`.
 * PrismaService and TRANSACTION_MANAGER come from the global PrismaModule.forRoot.
 */
@Module({
  providers: [PrismaOutboxRepository, PrismaOutboxStore, FanOutPublisher],
  exports: [PrismaOutboxRepository, PrismaOutboxStore, FanOutPublisher],
})
export class OutboxCoreModule {}
```

Replace `apps/api/src/outbox/outbox.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxModule as NathappOutboxModule, OutboxModuleOptions } from '@nathapp/nestjs-outbox';
import { IOutboxConfig, OUTBOX_CFG } from '../config/outbox.config';
import { FanOutPublisher } from './fan-out-publisher';
import { OutboxCoreModule } from './outbox-core.module';
import { OutboxService } from './outbox.service';
import { PrismaOutboxStore } from './prisma-outbox.store';

// Consumers (memory, entity-graph, code-intel, webhook, rag) import this module
// and register their handlers on FanOutPublisher in onModuleInit. It does not
// import them back (that would recreate the ESM temporal-dead-zone cycle).
// The package module is global: its OutboxService (record) and OutboxRelay are
// injectable everywhere.
@Module({
  imports: [
    OutboxCoreModule,
    NathappOutboxModule.registerAsync({
      imports: [OutboxCoreModule],
      inject: [PrismaOutboxStore, FanOutPublisher, ConfigService],
      useFactory: (store: PrismaOutboxStore, publisher: FanOutPublisher, config: ConfigService): OutboxModuleOptions => {
        const outbox = config.get<IOutboxConfig>(OUTBOX_CFG);
        if (!outbox) {
          throw new Error('OutboxModule: outbox config not loaded — ensure outboxConfig is in ConfigModule.forRoot load array');
        }
        return { store, publisher, relay: outbox.relay };
      },
    }),
  ],
  providers: [OutboxService],
  exports: [OutboxCoreModule, OutboxService],
})
export class OutboxModule {}
```

Create `apps/api/src/outbox/outbox-admin.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { OutboxModule } from './outbox.module';

/** Admin HTTP surface for the outbox, kept out of the domain module so OutboxModule compiles without auth wiring. */
@Module({
  imports: [OutboxModule],
  controllers: [AdminController],
})
export class OutboxAdminModule {}
```

In `apps/api/src/app.module.ts`, import `OutboxAdminModule` from `./outbox/outbox-admin.module` and add it right after `OutboxModule` in `imports`.

In `apps/api/test/e2e/transaction-manager-wiring.e2e.spec.ts`, the `PrismaOutboxRepository` resolution check stays valid (it is still an `AbstractPrismaRepository`); only fix it if it fails.

- [ ] **Step 14: Replace the module spec (DB-free)**

Replace `apps/api/src/outbox/outbox.module.spec.ts` with:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import {
  InMemoryOutboxStore,
  OUTBOX_MODULE_OPTIONS,
  OUTBOX_PUBLISHER,
  OUTBOX_STORE,
  OutboxModuleOptions,
  OutboxRelay,
  OutboxService as NathappOutboxService,
} from '@nathapp/nestjs-outbox';
import { outboxConfig } from '../config/outbox.config';
import { FanOutPublisher } from './fan-out-publisher';
import { OutboxModule } from './outbox.module';
import { PrismaOutboxStore } from './prisma-outbox.store';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: {} } },
    {
      provide: TRANSACTION_MANAGER,
      useValue: { run: <T>(fn: () => Promise<T>) => fn(), getClient: () => ({}), isInTransaction: () => false },
    },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER],
})
class FakePrismaModule {}

describe('OutboxModule (DI wiring, no database)', () => {
  const saved = process.env['OUTBOX_RELAY_ENABLED'];
  let moduleRef: TestingModule;

  const compile = async (): Promise<TestingModule> =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [outboxConfig] }), FakePrismaModule, OutboxModule],
    }).compile();

  afterEach(async () => {
    await moduleRef?.close();
    if (saved === undefined) delete process.env['OUTBOX_RELAY_ENABLED'];
    else process.env['OUTBOX_RELAY_ENABLED'] = saved;
  });

  it('resolves PrismaOutboxStore as the store, never the in-memory fallback', async () => {
    moduleRef = await compile();
    const store = moduleRef.get(OUTBOX_STORE);
    expect(store).toBeInstanceOf(PrismaOutboxStore);
    expect(store).not.toBeInstanceOf(InMemoryOutboxStore);
  });

  it('uses the shared FanOutPublisher instance as the relay publisher', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(OUTBOX_PUBLISHER)).toBe(moduleRef.get(FanOutPublisher));
  });

  it('passes the configured relay options, enabled outside tests', async () => {
    process.env['OUTBOX_RELAY_ENABLED'] = 'true';
    moduleRef = await compile();
    const options = moduleRef.get<OutboxModuleOptions>(OUTBOX_MODULE_OPTIONS);
    expect(options.relay).toEqual(outboxConfig().relay);
    expect(options.relay?.enabled).toBe(true);
  });

  it('exposes the package OutboxService and OutboxRelay', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(NathappOutboxService)).toBeDefined();
    expect(moduleRef.get(OutboxRelay)).toBeDefined();
  });
});
```

Run: `cd apps/api && bunx jest src/outbox`
Expected: PASS. (`compile()` does not run `onApplicationBootstrap`, so the relay interval never starts.)

- [ ] **Step 15: End-to-end relay test**

Create `apps/api/test/integration/outbox/outbox-relay.integration.spec.ts`:

```ts
/**
 * record() -> OutboxRelay -> FanOutPublisher -> handler, on real Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- outbox-relay
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxRelay, OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { outboxConfig } from '../../../src/config/outbox.config';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { OutboxModule } from '../../../src/outbox/outbox.module';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('outbox relay end to end', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let txManager: ITransactionManager;
  let outbox: NathappOutboxService;
  let relay: OutboxRelay;
  let publisher: FanOutPublisher;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [outboxConfig] }),
        PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { datasources: { db: { url: DATABASE_URL } } } }),
        OutboxModule,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    txManager = module.get(TRANSACTION_MANAGER);
    outbox = module.get(NathappOutboxService);
    relay = module.get(OutboxRelay);
    publisher = module.get(FanOutPublisher);
    projectId = (await prisma.client.project.create({ data: { name: 'Relay', slug: 'relay', key: 'RLY' } })).id;
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  it('delivers a committed record to its handler and marks it published', async () => {
    const handler = jest.fn();
    publisher.register('relay_ok', handler);

    const record = await txManager.run(() =>
      outbox.record({ type: 'relay_ok', payload: { hello: 'world' }, metadata: { projectId, eventId: 'ok-1' } }),
    );
    await relay.dispatchPendingBatch();

    expect(handler).toHaveBeenCalledWith({ hello: 'world' });
    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ status: 'published', owner: null, lastError: null });
    expect(row.publishedAt).not.toBeNull();
  });

  it('schedules a retry with backoff and records lastError when a handler fails', async () => {
    publisher.register('relay_fail', () => {
      throw new Error('downstream unavailable');
    });

    const before = Date.now();
    const record = await outbox.record({ type: 'relay_fail', payload: {}, metadata: { projectId, eventId: 'fail-1' } });
    await relay.dispatchPendingBatch();

    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ status: 'pending', attempts: 1, owner: null });
    expect(row.lastError).toContain('downstream unavailable');
    // backoffBaseMs 2000 for the first retry
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 2000);

    // Not due yet: a second cycle leaves it alone.
    await relay.dispatchPendingBatch();
    const again = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(again.attempts).toBe(1);
  });

  it('moves the record to dead after maxAttempts', async () => {
    publisher.register('relay_dead', () => {
      throw new Error('always fails');
    });
    const record = await outbox.record({ type: 'relay_dead', payload: {}, metadata: { projectId, eventId: 'dead-1' } });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await prisma.client.outboxEvent.update({ where: { id: record.id }, data: { nextAttemptAt: new Date(0) } });
      await relay.dispatchPendingBatch();
    }

    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ status: 'dead', attempts: 8 });
  });
});
```

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/outbox`
Expected: PASS (migration, store, relay suites).

- [ ] **Step 16: Fix the remaining integration suites that used the old schema/service**

- `test/integration/outbox-event-schema/outbox-event-schema.validation.integration.spec.ts` pins the old column set (`eventType`, `processedAt`, `dead_letter`). Its AC1/AC2 intent is now covered by `outbox-migration.integration.spec.ts` and `prisma-outbox-store.integration.spec.ts`: delete the file (and its now-empty directory). Its AC3 (other event tables unaltered) is covered by the migration diff in Step 6.
- `test/integration/memory/outbox-envelope.integration.spec.ts`: it constructs the old `OutboxService(outboxRepo, fanOutRegistry)` and drives it with `processPending()`. Build the outbox pieces directly instead:

```ts
const store = new PrismaOutboxStore(prismaService);
const publisher = new FanOutPublisher(new PrismaOutboxRepository(txManager, prismaService));
const packageOutbox = new NathappOutboxService(store, txManager);
outboxService = new OutboxService(packageOutbox, new PrismaOutboxRepository(txManager, prismaService));
relay = new OutboxRelay({ store, publisher, relay: { enabled: false } }, store, publisher);
```

and replace every `await outboxService.processPending();` with `await relay.dispatchPendingBatch();`. The `waitForOutboxRow` helper's `where` changes from `eventType` to `type`. The subscriber gets `publisher` in place of the old registry.

Run: `cd apps/api && bun run test:integration`
Expected: PASS, no new skips.

- [ ] **Step 17: Full verification**

Run: `cd apps/api && bun run type-check && bun run lint && bun run test`
Expected: all green; `bun run test` with the test DB stopped (`bun run test:db:down`) still passes.

Run: `cd apps/api && grep -rn "OutboxProcessor\|processPending\|OUTBOX_BACKOFF_MS\|dead_letter\|'completed'" src | grep -v "\.spec\.ts"`
Expected: no outbox-related matches (ticket/other domains may legitimately use the word `completed`; inspect any hit).

- [ ] **Step 18: Commit**

```bash
git add -A apps/api
git commit -m "feat(outbox): Prisma store and package relay replace the hand-rolled processor (M4)"
```

---

### Task 4: Ticket producers record inside the write's transaction

`tickets.service.ts` and `ticket-transitions.service.ts` currently emit ticket events and webhook rows fire-and-forget after the write commits. They move inside the write's `txManager.run`, call the package's `record()` directly, and their failures now fail (and roll back) the request.

**Files:**
- Modify: `apps/api/src/tickets/tickets.service.ts`, `apps/api/src/tickets/tickets.service.spec.ts`
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`, `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts`
- Modify: `apps/api/src/webhook/webhook-dispatcher.service.ts`, `apps/api/src/webhook/webhook-dispatcher.service.spec.ts`
- Create: `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts`
- Modify: `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts`, `test/integration/tickets/*.integration.spec.ts` and `test/integration/agent-permissions/tickets-agent-permissions.integration.spec.ts` (constructor/mocks only)

**Interfaces:**
- Consumes: package `OutboxService.record(event: OutboxEventInput): Promise<OutboxRecord>` (global via Task 3), `TRANSACTION_MANAGER`.
- Produces: `TicketsService` constructor `(ticketRepo, txManager, ticketEventService, outbox: NathappOutboxService, transitionsService)`. `TicketTransitionsService` keeps its positional constructor; the `outboxService` slot's type becomes the package `OutboxService`. `WebhookDispatcherService.dispatch(projectId, event, payload): Promise<void>` must be called inside the caller's transaction.

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/tickets/tickets.service.spec.ts`:
- Replace `const mockOutboxService = { enqueue: … }` with `const mockOutbox = { record: jest.fn().mockResolvedValue(undefined) };`, provide it under `NathappOutboxService` (`import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox'`) instead of koda's `OutboxService`, and replace every `mockOutboxService.enqueue` assertion with the `record` shape: `{ type: 'ticket_event', payload: expect.objectContaining({ action, ticketId, projectId }), metadata: { projectId, eventId: <event id> } }`.
- Remove the "allow the fire-and-forget void promise to resolve" waits.
- Make the txManager mock track whether it is inside `run`:

```ts
let inTx = false;
const mockTxManager = {
  run: jest.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
    inTx = true;
    try {
      return await fn();
    } finally {
      inTx = false;
    }
  }),
  getClient: jest.fn(),
  isInTransaction: jest.fn(() => inTx),
};
```

- Add these tests (adapt fixture names to the ones already in the file):

```ts
it('create() records the TICKET_CREATED event inside the ticket-create transaction', async () => {
  mockOutbox.record.mockImplementation(async () => {
    expect(inTx).toBe(true);
  });
  await service.create('koda', createDto, mockUserPrincipal);
  expect(mockOutbox.record).toHaveBeenCalledTimes(1);
});

it('create() fails when the outbox record fails (no silent drop)', async () => {
  mockOutbox.record.mockRejectedValue(new Error('outbox down'));
  await expect(service.create('koda', createDto, mockUserPrincipal)).rejects.toThrow('outbox down');
});

it('update(), softDelete() and assign() record inside their transactions', async () => {
  const seen: boolean[] = [];
  mockOutbox.record.mockImplementation(async () => {
    seen.push(inTx);
  });
  await service.update('koda', 'KODA-1', { title: 'New' }, mockUserPrincipal);
  await service.softDelete('koda', 'KODA-1', mockUserPrincipal);
  await service.assign('koda', 'KODA-1', { userId: 'user-1' }, mockUserPrincipal);
  expect(seen).toEqual([true, true, true]);
});
```

Invert any existing test asserting that an emit failure is non-fatal: it now expects the call to reject.

In `ticket-transitions.service.spec.ts`, change the `buildService` override type to `outboxService?: { record: jest.Mock }` with default `{ record: jest.fn().mockResolvedValue(undefined) }`, change the `enqueue` assertions to the `record` shape, provide a `webhookDispatcher` mock `{ dispatch: jest.fn().mockResolvedValue(undefined) }` where the tests assert webhooks, and add:

```ts
it('records the status_changed event and STATUS_CHANGE webhooks inside the transition transaction', async () => {
  const { service, outboxService, webhookDispatcher, txManager } = buildService();
  let depth = 0;
  txManager.run.mockImplementation(async (fn: () => Promise<unknown>) => {
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  });
  const depthAtRecord: number[] = [];
  outboxService.record.mockImplementation(async () => {
    depthAtRecord.push(depth);
  });
  webhookDispatcher.dispatch.mockImplementation(async () => {
    depthAtRecord.push(depth);
  });

  await service.start('koda', 'KODA-1', principal);

  expect(depthAtRecord.length).toBeGreaterThanOrEqual(2);
  expect(depthAtRecord.every((d) => d === 1)).toBe(true);
});

it('fails the transition when recording its outbox rows fails', async () => {
  const { service, outboxService } = buildService();
  outboxService.record.mockRejectedValue(new Error('outbox down'));
  await expect(service.start('koda', 'KODA-1', principal)).rejects.toThrow('outbox down');
});
```

Use the same VERIFIED ticket fixture as the existing "H13: start() enqueues a status_changed ticket_event" test (`start()` is VERIFIED → IN_PROGRESS and needs no CASL factory, unlike `executeTransitionPublic`, which fails closed without one). (Extend `buildService` to return `txManager` and `webhookDispatcher` if it does not already; keep the existing positional constructor order.)

In `apps/api/src/webhook/webhook-dispatcher.service.spec.ts`, switch the outbox mock to `{ record: jest.fn() }`, update assertions to `{ type: 'webhook_delivery', payload: { webhookId, event, payload }, metadata: { projectId, eventId: expect.any(String) } }`, and add:

```ts
it('records one row per matching webhook, sequentially', async () => {
  const order: string[] = [];
  outbox.record.mockImplementation(async (input: { payload: { webhookId: string } }) => {
    order.push(`start:${input.payload.webhookId}`);
    await Promise.resolve();
    order.push(`end:${input.payload.webhookId}`);
  });
  webhookRepo.findActiveByProject.mockResolvedValue([
    { id: 'w1', events: '["STATUS_CHANGE"]' },
    { id: 'w2', events: '["STATUS_CHANGE"]' },
  ]);

  await service.dispatch('p1', 'STATUS_CHANGE', {});

  expect(order).toEqual(['start:w1', 'end:w1', 'start:w2', 'end:w2']);
});

it('skips a webhook whose events column is not valid JSON instead of throwing', async () => {
  webhookRepo.findActiveByProject.mockResolvedValue([
    { id: 'broken', events: 'not-json' },
    { id: 'ok', events: '["STATUS_CHANGE"]' },
  ]);

  await expect(service.dispatch('p1', 'STATUS_CHANGE', {})).resolves.toBeUndefined();

  expect(outbox.record).toHaveBeenCalledTimes(1);
  expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ webhookId: 'ok' }) }));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bunx jest src/tickets src/webhook/webhook-dispatcher.service.spec.ts`
Expected: FAIL (services still inject koda's `OutboxService` and emit after commit).

- [ ] **Step 3: Implement `tickets.service.ts`**

- Replace `import { OutboxService } from '../outbox/outbox.service';` with `import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';` and the constructor parameter with `private readonly outbox: NathappOutboxService`.
- Replace `emitTicketEvent` with (no try/catch, no `void`):

```ts
  /**
   * Writes the TicketEvent row and its ticket_event outbox row. Must be called
   * inside the business write's txManager.run so all three commit or roll back
   * together (outside run() the outbox row would commit on its own).
   */
  private async recordTicketEvent(
    ticketId: string,
    projectId: string,
    action: string,
    principal: KodaPrincipal,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const actorType = isUserPrincipal(principal) ? 'user' : 'agent';
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action,
      actorId: principal.id,
      actorType,
      source: 'internal',
      data: extra,
    });
    await this.outbox.record({
      type: 'ticket_event',
      // H13: consumers switch on action/id/timestamp — record the full event envelope
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data: extra }),
      metadata: { projectId, eventId: event.id },
    });
  }
```

- `create()`: inside the `runWithTicketNumberRetry` work function, after `createTicket(...)`, `await this.recordTicketEvent(created.id, project.id, 'TICKET_CREATED', principal, { type: created.type, title: created.title });` then `return created;`. Delete the `void this.emitTicketEvent(...)` after it. A number conflict retries the whole transaction, event included.
- `applyUpdate()`: look up `project` before the write, then:

```ts
    const updated = await this.txManager.run(async () => {
      const row = await this.ticketRepo.updateTicket(ticket.id, updateData);
      if (project?.id) {
        await this.recordTicketEvent(ticket.id, project.id, 'TICKET_UPDATED', principal, { ...updateData });
      }
      return row;
    });
```

- `softDelete()`: same shape around `softDeleteTicket` with `'TICKET_DELETED'`.
- `assign()`: wrap `assignTicket` and, when `principal` is set, `recordTicketEvent(ticket.id, project.id, 'assigned', principal, { assignedTo: assignInput.userId ?? assignInput.agentId ?? null })` in one `txManager.run`. Remove the "Fire-and-forget; never fails the request" comment.

- [ ] **Step 4: Implement the dispatcher**

Replace `apps/api/src/webhook/webhook-dispatcher.service.ts` with:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { PrismaWebhookRepository } from './prisma-webhook.repository';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly webhookRepo: PrismaWebhookRepository,
    private readonly outbox: NathappOutboxService,
  ) {}

  /**
   * Records one webhook_delivery outbox row per active webhook subscribed to
   * `event`. Call inside the triggering write's txManager.run so the rows
   * commit with it. Sequential: Prisma interactive transactions must not run
   * queries in parallel.
   */
  async dispatch(projectId: string, event: string, payload: object): Promise<void> {
    const webhooks = await this.webhookRepo.findActiveByProject(projectId);
    for (const webhook of webhooks) {
      if (!this.subscribesTo(webhook, event)) continue;
      await this.outbox.record({
        type: 'webhook_delivery',
        payload: { webhookId: webhook.id, event, payload },
        metadata: { projectId, eventId: randomUUID() },
      });
    }
  }

  /** A malformed events column must not fail the triggering write: skip and log it. */
  private subscribesTo(webhook: { id: string; events: string }, event: string): boolean {
    try {
      const events = JSON.parse(webhook.events) as unknown;
      return Array.isArray(events) && events.includes(event);
    } catch {
      this.logger.warn(`Webhook ${webhook.id} has malformed events JSON; skipping`);
      return false;
    }
  }
}
```

- [ ] **Step 5: Implement the transitions**

In `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`:
- Change the `OutboxService` import to `import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';` and the parameter to `@Optional() private readonly outboxService?: NathappOutboxService` (same position).
- Replace `emitStatusChangedEvent` with an awaited method (no IIFE, no catch):

```ts
  /**
   * H13: records a status_changed ticket_event (full envelope) for the memory
   * and entity-graph consumers. Called inside the transition transaction.
   */
  private async recordStatusChangedEvent(
    projectId: string,
    ticketId: string,
    fromStatus: string,
    toStatus: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    if (!this.ticketEventService || !this.outboxService) return;
    const actorType = isUserPrincipal(principal) ? 'user' : 'agent';
    const data = { fromStatus, newStatus: toStatus };
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action: 'status_changed',
      actorId: principal.id,
      actorType,
      source: 'internal',
      data,
    });
    await this.outboxService.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }
```

- Replace `dispatchStatusChangeWebhook` with `private async recordStatusChangeWebhooks(projectId, projectKey, ticket, fromStatus, toStatus): Promise<void>` that `await`s `this.webhookDispatcher.dispatch(...)` with the same payload (keep the BUG-15 `ref` comment) and has no `.catch`.
- In both `close()` and `executeTransitionInternal()`, call both methods **inside** the `txManager.run` callback, after `createTicketActivity(...)` and before the `return`:

```ts
      await this.recordStatusChangeWebhooks(project.id, project.key, updatedTicket as unknown as TicketDomain, ticket.status, toStatus);
      await this.recordStatusChangedEvent(project.id, ticket.id, ticket.status, toStatus, principal);
```

(`close()` uses `TicketStatus.CLOSED` for `toStatus`.) Delete the two post-commit calls. `autoIndexTicket` and `createPrForTicket` stay after the commit: they are not outbox writes.

- [ ] **Step 6: Run the unit tests**

Run: `cd apps/api && bunx jest src/tickets src/webhook`
Expected: PASS.

- [ ] **Step 7: Write the atomicity integration test**

Create `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts`:

```ts
/**
 * Producers record outbox rows atomically with their business writes (Track 1 slice 2).
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- producer-atomicity
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { outboxConfig } from '../../../src/config/outbox.config';
import { OutboxModule } from '../../../src/outbox/outbox.module';
import { PrismaOutboxStore } from '../../../src/outbox/prisma-outbox.store';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TICKET_REPOSITORY } from '../../../src/tickets/domain/ticket.domain';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { PrismaEventsRepository } from '../../../src/events/prisma-events.repository';
import { WebhookDispatcherService } from '../../../src/webhook/webhook-dispatcher.service';
import { PrismaWebhookRepository } from '../../../src/webhook/prisma-webhook.repository';
import { TicketStatus, TicketType } from '../../../src/common/enums';
import { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('producers record outbox rows atomically', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let tickets: TicketsService;
  let transitions: TicketTransitionsService;
  let store: PrismaOutboxStore;
  let principal: KodaPrincipal;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [outboxConfig] }),
        PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { datasources: { db: { url: DATABASE_URL } } } }),
        OutboxModule,
      ],
      providers: [
        TicketsService,
        TicketTransitionsService,
        PrismaTicketsRepository,
        { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
        TicketEventService,
        PrismaEventsRepository,
        WebhookDispatcherService,
        PrismaWebhookRepository,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    tickets = module.get(TicketsService);
    transitions = module.get(TicketTransitionsService);
    store = module.get(PrismaOutboxStore);

    const project = await prisma.client.project.create({ data: { name: 'Atomic', slug: 'atomic', key: 'ATM' } });
    projectId = project.id;
    const user = await prisma.client.user.create({
      data: { email: 'atomic@koda.test', name: 'Atomic', passwordHash: 'x', role: 'ADMIN' },
    });
    principal = { id: user.id, type: 'user', role: 'ADMIN' } as unknown as KodaPrincipal;
    await prisma.client.webhook.create({
      data: { projectId, url: 'https://example.test/hook', secret: 's', events: '["STATUS_CHANGE"]' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  it('ticket create commits the ticket, its TicketEvent and exactly one ticket_event row', async () => {
    const created = await tickets.create('atomic', { type: TicketType.BUG, title: 'One' }, principal);

    const rows = await prisma.client.outboxEvent.findMany({ where: { type: 'ticket_event' } });
    const events = await prisma.client.ticketEvent.findMany({ where: { ticketId: created.id } });
    expect(events).toHaveLength(1);
    expect(rows.filter((r) => r.eventId === events[0].id)).toHaveLength(1);
    expect(rows[0].projectId).toBe(projectId);
  });

  it('ticket create rolls back the ticket and its TicketEvent when the outbox write fails', async () => {
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('outbox down'));
    const ticketsBefore = await prisma.client.ticket.count();
    const eventsBefore = await prisma.client.ticketEvent.count();

    await expect(tickets.create('atomic', { type: TicketType.BUG, title: 'Two' }, principal)).rejects.toThrow('outbox down');

    expect(await prisma.client.ticket.count()).toBe(ticketsBefore);
    expect(await prisma.client.ticketEvent.count()).toBe(eventsBefore);
  });

  it('a transition records its status_changed event and webhook row in the same commit', async () => {
    const created = await tickets.create('atomic', { type: TicketType.BUG, title: 'Three' }, principal);
    await prisma.client.ticket.update({ where: { id: created.id }, data: { status: TicketStatus.VERIFIED } });
    await prisma.client.outboxEvent.deleteMany({});

    await transitions.start('atomic', created.id, principal);

    const rows = await prisma.client.outboxEvent.findMany({});
    expect(rows.map((r) => r.type).sort()).toEqual(['ticket_event', 'webhook_delivery']);
  });

  it('a transition that fails to record rolls back the status change and writes no rows', async () => {
    const created = await tickets.create('atomic', { type: TicketType.BUG, title: 'Four' }, principal);
    await prisma.client.ticket.update({ where: { id: created.id }, data: { status: TicketStatus.VERIFIED } });
    await prisma.client.outboxEvent.deleteMany({});
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('outbox down'));

    await expect(transitions.start('atomic', created.id, principal)).rejects.toThrow('outbox down');

    const ticket = await prisma.client.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(ticket.status).toBe(TicketStatus.VERIFIED);
    expect(await prisma.client.outboxEvent.count()).toBe(0);
  });
});
```

`start()` is VERIFIED → IN_PROGRESS with no comment and no CASL check, so the tests put the ticket in VERIFIED directly. Copy the principal shape from `test/integration/tickets/ticket-transition-race.integration.spec.ts` if the cast above does not type-check. `TicketTransitionsService`'s optional dependencies (rag, vcs, CASL) are absent here, as in the race test; the webhook row still appears because `WebhookDispatcherService` is provided.

- [ ] **Step 8: Run it, then the whole integration suite**

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/outbox/producer-atomicity`
Expected: PASS (4 tests).

Update the remaining suites that construct `TicketsService`/`TicketTransitionsService` or mock koda's `OutboxService` for them (`test/integration/memory/outbox-envelope.integration.spec.ts`, `test/integration/tickets/ticket-tenancy.integration.spec.ts`, `test/integration/tickets/tickets-status-update.integration.spec.ts`, `test/integration/agent-permissions/tickets-agent-permissions.integration.spec.ts`): pass the package `OutboxService` (`packageOutbox` in the envelope test) or a `{ record: jest.fn() }` mock. In the envelope test, emissions are no longer fire-and-forget, so its `waitForOutboxRow` polling can become a direct query.

Run: `cd apps/api && bun run type-check && bun run test && bun run test:integration`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add -A apps/api
git commit -m "fix(tickets): record ticket events and webhook rows inside the write transaction"
```

---

### Task 5: Domain writer and VCS webhook record through the package

**Files:**
- Modify: `apps/api/src/koda-domain-writer/koda-domain-writer.service.ts`, `apps/api/src/koda-domain-writer/koda-domain-writer.service.spec.ts`, `apps/api/test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts`, `apps/api/test/integration/events/event-write-operations.integration.spec.ts`
- Modify: `apps/api/src/vcs/vcs-webhook.service.ts`, `apps/api/src/vcs/vcs-webhook.service.spec.ts`
- Modify: `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` (add domain-writer cases)

**Interfaces:**
- Consumes: package `OutboxService.record`, `TRANSACTION_MANAGER`.
- Produces: `KodaDomainWriter` constructor gains `@Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager` as the **last** parameter. `VcsWebhookService` keeps its constructor; the `outboxService` slot's type becomes the package `OutboxService`. After this task, `grep -rn "\.enqueue(" apps/api/src` returns nothing.

Two sites deliberately record outside a shared transaction, with a comment at each:
- `vcs-webhook.service.ts` push handling: the `code_commit` outbox row is the handler's only write, so there is nothing to be atomic with.
- `KodaDomainWriter.importGraphify`: the import writes the vector store and Prisma, which cannot share one Prisma transaction (and a large import would exceed the interactive-transaction timeout). The row is recorded after the import succeeds.

- [ ] **Step 1: Write the failing unit tests**

In `koda-domain-writer.service.spec.ts`: provide `{ provide: NathappOutboxService, useValue: { record: jest.fn().mockResolvedValue(undefined) } }` instead of koda's `OutboxService`, provide `TRANSACTION_MANAGER` with the depth-tracking mock from Task 4 Step 1, move every `enqueue` assertion to the `record` shape (`{ type, payload, metadata: { projectId, eventId } }`), and add:

```ts
it.each([
  ['writeTicketEvent', () => writer.writeTicketEvent(ticketEventInput)],
  ['writeAgentAction', () => writer.writeAgentAction(agentActionInput)],
  ['writeDecisionEvent', () => writer.writeDecisionEvent(decisionInput)],
  ['indexDocument', () => writer.indexDocument(indexInput)],
])('%s creates the event row and records the outbox row in one transaction', async (_name, call) => {
  const depthAtWrite: number[] = [];
  eventCreateMocks.forEach((m) => m.mockImplementation(async () => { depthAtWrite.push(depth); return { id: 'evt-1', action: 'a', timestamp: new Date() }; }));
  outbox.record.mockImplementation(async () => { depthAtWrite.push(depth); });

  await call();

  expect(depthAtWrite).toEqual([1, 1]);
});

it('indexDocument indexes into RAG only after the transaction commits', async () => {
  ragService.indexDocument.mockImplementation(async () => { expect(depth).toBe(0); });
  await writer.indexDocument(indexInput);
  expect(ragService.indexDocument).toHaveBeenCalled();
});
```

(`eventCreateMocks` = the `create` mocks of the three event services; reuse the file's existing input fixtures under whatever names it already uses.)

In `vcs-webhook.service.spec.ts`: the shared-state outbox fake gets a `record` method in place of `enqueue`, storing `{ type, eventId: metadata.eventId, projectId: metadata.projectId, status: 'pending', createdAt }` so the DB dedupe path keeps working; update assertions accordingly.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bunx jest src/koda-domain-writer src/vcs/vcs-webhook.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the domain writer**

In `koda-domain-writer.service.ts`: import `{ OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox'` and `{ ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data'`; swap the constructor's `outboxService: OutboxService` for `outbox: NathappOutboxService` (same position) and append `@Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager` as the last parameter (add `Inject` to the `@nestjs/common` import).

For `writeTicketEvent`, keep the validation/authorization prelude as is, then:

```ts
    return this.txManager.run(async () => {
      const event = await this.ticketEventService.create(data);
      await this.outbox.record({
        type: 'ticket_event',
        // H13: consumers switch on action/id/timestamp — record the full event envelope
        payload: buildTicketEventOutboxPayload({
          event,
          ticketId: data.ticketId,
          projectId: data.projectId,
          actorId: data.actorId,
          actorType: data.actorType,
          data: data.data,
        }),
        metadata: { projectId: data.projectId, eventId: event.id },
      });
      return {
        canonicalId: event.id,
        provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source, event.id),
      };
    });
```

Apply the same shape to `writeAgentAction` (`agent_event`, `buildAgentEventOutboxPayload`) and `writeDecisionEvent` (`decision_event`, same payload object as today). In `indexDocument`, wrap only the `ticketEventService.create` + `record('document_indexed')` in `txManager.run` (returning the event), and keep the `ragService.indexDocument` try/catch after the commit.

In `importGraphify`, replace the `enqueue` with:

```ts
    // The import spans the vector store and Prisma, which cannot share one Prisma
    // transaction; the event is recorded once the import has succeeded.
    await this.outbox.record({
      type: 'graphify_import',
      payload: { projectId: data.projectId, nodeCount: data.nodes.length, linkCount: data.links.length },
      metadata: { projectId: data.projectId, eventId: `${data.projectId}:${Date.now()}` },
    });
```

- [ ] **Step 4: Implement the VCS webhook**

In `vcs-webhook.service.ts`: change the `OutboxService` import to the package alias and the parameter type (`@Optional() private readonly outboxService?: NathappOutboxService`). Replace the `enqueue` call with:

```ts
        // The code_commit row is this handler's only write: there is no business
        // write to share a transaction with.
        await this.outboxService.record({
          type: 'code_commit',
          payload: eventPayload,
          metadata: { projectId: connection.projectId, eventId: commitHash },
        });
```

Update the error message text `'OutboxService not available for push handling'` only if a test pins it; otherwise leave it.

- [ ] **Step 5: Add the domain-writer atomicity case**

In `producer-atomicity.integration.spec.ts`, add `KodaDomainWriter` and its dependencies to the testing module (`PrismaKodaDomainWriterRepository`, `AgentEventService`, `DecisionEventService`, plus `{ provide: RagService, useValue: { indexDocument: jest.fn(), importGraphify: jest.fn() } }` and `{ provide: AgentAuthProvider, useValue: { loadAgentRoles: jest.fn().mockResolvedValue(['AGENT']) } }`), seed an `Agent` row, and add:

```ts
it('writeAgentAction rolls back the AgentEvent when the outbox write fails', async () => {
  jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('outbox down'));
  const before = await prisma.client.agentEvent.count();

  await expect(writer.writeAgentAction(agentActionInput)).rejects.toThrow('outbox down');

  expect(await prisma.client.agentEvent.count()).toBe(before);
});

it('writeAgentAction commits the AgentEvent and one agent_event row keyed by its id', async () => {
  const result = await writer.writeAgentAction(agentActionInput);

  const rows = await prisma.client.outboxEvent.findMany({ where: { eventId: result.canonicalId } });
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe('agent_event');
});
```

(`agentActionInput` = `{ projectId, agentId, actorId: agentId, action: 'decision_made', source: 'api', data: {} }` using the seeded agent.)

In `test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts`, replace the koda `OutboxService` mock with `{ provide: NathappOutboxService, useValue: { record: jest.fn().mockResolvedValue(undefined) } }` and add a pass-through `TRANSACTION_MANAGER` provider (`run: (fn) => fn()`, `getClient`, `isInTransaction: () => false`).

Apply the same change to `apps/api/test/integration/events/event-write-operations.integration.spec.ts` (mocked Prisma, not DB-backed): delete the `import { OutboxService } from '../../../src/outbox/outbox.service';` line (line 28; the file is deleted in Task 6), replace `const mockOutboxService = { enqueue: jest.fn(), processPending: jest.fn() }` with `const mockOutbox = { record: jest.fn().mockResolvedValue(undefined) }`, swap the provider `{ provide: OutboxService, useValue: mockOutboxService }` for `{ provide: NathappOutboxService, useValue: mockOutbox }` plus the same pass-through `TRANSACTION_MANAGER` provider, and change the seven `mockOutboxService.enqueue.mockResolvedValue(...)` lines (~583-888) to `mockOutbox.record.mockResolvedValue(...)`; any assertion on `enqueue` arguments moves to the `record` shape `{ type, payload, metadata: { projectId, eventId } }`.

- [ ] **Step 6: Verify and prove no producer still uses the adapter**

Run: `cd apps/api && bun run type-check && bun run test && bun run test:integration`
Expected: all PASS.

Run: `cd apps/api && grep -rn "\.enqueue(" src test | grep -v node_modules`
Expected: only `src/outbox/outbox.service.ts` (the adapter itself) and its spec.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api
git commit -m "fix(outbox): domain writer and VCS webhook record through the package"
```

---

### Task 6: Admin surface on the new statuses; delete the adapter

**Files:**
- Create: `apps/api/src/outbox/outbox-admin.service.ts`, `apps/api/src/outbox/outbox-admin.service.spec.ts`, `apps/api/src/outbox/dto/outbox-list-query.dto.ts`, `apps/api/src/i18n/en/outbox.json`, `apps/api/src/i18n/zh/outbox.json`
- Modify: `apps/api/src/outbox/admin.controller.ts`, `apps/api/src/outbox/admin.controller.spec.ts`, `apps/api/src/outbox/outbox-admin.module.ts`, `apps/api/src/outbox/outbox.module.ts`, `apps/api/src/outbox/prisma-outbox.repository.ts` (+ spec), `apps/cli/src/commands/admin.ts`, `openapi.json` and `apps/cli/src/generated/**` (regenerated)
- Delete: `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/outbox/outbox.service.spec.ts`, `OutboxEventInput` from `domain/outbox-event.domain.ts`

**Interfaces:**
- Consumes: `PrismaOutboxRepository` (Task 3), `OutboxStatus`.
- Produces: `OutboxAdminService.list(status?: OutboxStatus, limit?: number): Promise<OutboxEventDomain[]>`, `OutboxAdminService.retry(eventId: string): Promise<void>` (404 when missing, 409 when `processing`/`published`); `PrismaOutboxRepository.findById(id): Promise<OutboxEventDomain | null>`; `resetForRetry(id, now)` now only resets rows whose status is `dead` or `pending`.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/src/outbox/outbox-admin.service.spec.ts`:

```ts
import { HttpException, HttpStatus } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxAdminService } from './outbox-admin.service';

describe('OutboxAdminService', () => {
  const repo = {
    findByStatus: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    resetForRetry: jest.fn().mockResolvedValue(1),
  };
  const service = new OutboxAdminService(repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('lists pending events by default, 100 at most', async () => {
    await service.list();
    expect(repo.findByStatus).toHaveBeenCalledWith(OutboxStatus.PENDING, 100);
  });

  it('lists the requested status', async () => {
    await service.list(OutboxStatus.DEAD);
    expect(repo.findByStatus).toHaveBeenCalledWith(OutboxStatus.DEAD, 100);
  });

  it.each([OutboxStatus.DEAD, OutboxStatus.PENDING])('retries a %s event', async (status) => {
    repo.findById.mockResolvedValue({ id: 'e1', status });
    await service.retry('e1');
    expect(repo.resetForRetry).toHaveBeenCalledWith('e1', expect.any(Date));
  });

  it('404s an unknown event', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.retry('missing')).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.resetForRetry).not.toHaveBeenCalled();
  });

  it.each([OutboxStatus.PROCESSING, OutboxStatus.PUBLISHED])('409s a %s event (no double delivery)', async (status) => {
    repo.findById.mockResolvedValue({ id: 'e1', status });
    const result = service.retry('e1');
    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    expect(repo.resetForRetry).not.toHaveBeenCalled();
  });

  it('409s when the row changed status between the read and the reset', async () => {
    repo.findById.mockResolvedValue({ id: 'e1', status: OutboxStatus.DEAD });
    repo.resetForRetry.mockResolvedValueOnce(0);
    await expect(service.retry('e1')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/outbox/outbox-admin.service.spec.ts`
Expected: FAIL, `Cannot find module './outbox-admin.service'`.

- [ ] **Step 3: Implement**

Repository: add `findById(id)` (`findUnique` → `toDomain` or `null`) and change `resetForRetry`'s `where` to `{ id, status: { in: ['dead', 'pending'] } }` (update its spec accordingly).

Create `apps/api/src/outbox/outbox-admin.service.ts`:

```ts
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxEventDomain } from './domain/outbox-event.domain';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

const LIST_LIMIT = 100;
const RETRYABLE: readonly string[] = [OutboxStatus.DEAD, OutboxStatus.PENDING];

@Injectable()
export class OutboxAdminService {
  constructor(private readonly outboxRepo: PrismaOutboxRepository) {}

  async list(status: OutboxStatus = OutboxStatus.PENDING, limit = LIST_LIMIT): Promise<OutboxEventDomain[]> {
    return this.outboxRepo.findByStatus(status, limit);
  }

  /**
   * Resets a dead (or stuck pending) event to pending, due now. Rows that are
   * processing or published are refused: resetting an in-flight row would clear
   * its owner and deliver it twice.
   */
  async retry(eventId: string): Promise<void> {
    const event = await this.outboxRepo.findById(eventId);
    if (!event) {
      throw new NotFoundAppException({}, 'outbox');
    }
    if (!RETRYABLE.includes(event.status)) {
      throw new HttpException(`Outbox event is ${event.status}; only dead or pending events can be retried`, HttpStatus.CONFLICT);
    }
    const changed = await this.outboxRepo.resetForRetry(eventId, new Date());
    if (changed === 0) {
      throw new HttpException('Outbox event changed state concurrently; retry the request', HttpStatus.CONFLICT);
    }
  }
}
```

Create `apps/api/src/outbox/dto/outbox-list-query.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { OutboxStatus } from '@nathapp/nestjs-outbox';

export class OutboxListQueryDto {
  @ApiPropertyOptional({ enum: OutboxStatus, default: OutboxStatus.PENDING })
  @IsOptional()
  @IsEnum(OutboxStatus)
  status?: OutboxStatus;
}
```

Create `apps/api/src/i18n/en/outbox.json`:

```json
{
  "notFound": "Outbox event not found",
  "404": "Outbox event not found"
}
```

and `apps/api/src/i18n/zh/outbox.json`:

```json
{
  "notFound": "未找到发件箱事件",
  "404": "未找到发件箱事件"
}
```

In `admin.controller.ts`: inject `OutboxAdminService` instead of `OutboxService`; `getOutbox(@Principal() _principal, @Query() query: OutboxListQueryDto)` returns `{ items, total: items.length }` from `this.outboxAdmin.list(query.status)`; `retryOutboxEvent` calls `this.outboxAdmin.retry(eventId)`; update the `@ApiOperation` summary to "Retry a dead outbox event" and add `@ApiResponse({ status: 409, description: 'Event is processing or already published' })` and `@ApiResponse({ status: 400, description: 'Unknown status' })` on the list.

`outbox-admin.module.ts`: add `providers: [OutboxAdminService]`. `outbox.module.ts`: remove `OutboxService` from `providers` and `exports` and delete its import.

Delete `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/outbox/outbox.service.spec.ts`, and the `OutboxEventInput` interface from `domain/outbox-event.domain.ts`.

Update `admin.controller.spec.ts`: mock `OutboxAdminService` (`list`, `retry`), assert the controller passes `query.status` through and returns `{ items, total }`, and that a 404/409 from the service propagates.

In `apps/cli/src/commands/admin.ts`, change the list option help to `'Filter by status (pending, processing, published, dead)'` and the retry description to `'Retry a dead outbox event'`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && bunx jest src/outbox`
Expected: PASS.

Add one integration assertion to `test/integration/outbox/outbox-relay.integration.spec.ts`:

```ts
it('admin retry resets a dead event so the relay delivers it again', async () => {
  const admin = new OutboxAdminService(module.get(PrismaOutboxRepository));
  const handler = jest.fn();
  publisher.register('relay_revive', handler);
  const record = await outbox.record({ type: 'relay_revive', payload: {}, metadata: { projectId, eventId: 'revive-1' } });
  await prisma.client.outboxEvent.update({ where: { id: record.id }, data: { status: 'dead', attempts: 8, lastError: 'old' } });

  await admin.retry(record.id);
  await relay.dispatchPendingBatch();

  expect(handler).toHaveBeenCalledTimes(1);
  const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
  expect(row).toMatchObject({ status: 'published', attempts: 0, lastError: null });
});
```

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/outbox`
Expected: PASS.

- [ ] **Step 5: Regenerate the contract and the CLI client**

Run: `bun run generate` (repo root)
Expected: `openapi.json` shows the `status` query enum on `GET /admin/outbox` and the new 409 response; `apps/cli/src/generated/` updates.

Run: `cd apps/cli && bun run type-check && bun run test && bun run lint`
Expected: PASS (`admin.spec.ts` may need the retry description string updated).

- [ ] **Step 6: Verify the old vocabulary is gone**

Run: `grep -rn "dead_letter\|OutboxFanOutRegistry\|outbox.service'\|OUTBOX_BACKOFF_MS\|\.enqueue(\|processPending" apps/api/src apps/api/test apps/cli/src --include='*.ts' | grep -v generated`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api apps/cli openapi.json
git commit -m "feat(outbox): admin list/retry on package statuses, drop the enqueue adapter"
```

---

### Task 7: Replaying a memory fact is a no-op

The relay retries a whole event when any of its handlers fails, so every handler must tolerate running twice. The idempotency audit of the current handlers:

| Event type → handler | Side effect | Replay-safe? | Basis |
|---|---|---|---|
| `webhook_delivery` → `WebhookDeliveryHandler` | external POST | at-least-once (by design) | one row per webhook, so another handler's failure never re-sends it; stable `X-Koda-Delivery-Id` lets receivers dedupe |
| `ticket_event`, `agent_event` → `MemoryOutboxSubscriber` | `MemoryItem` supersede + create | **no** | a replay supersedes an identical active row and creates a new one |
| `ticket_event`, `graphify_import` → `EntityGraphOutboxSubscriber` | `EntityNode`/`EntityLink` upsert | yes | upsert on unique keys |
| `code_commit` → `CodeIntelOutboxSubscriber` | `Symbol` upsert | yes | upsert on deterministic id |
| `document_indexed`, `graphify_import`, `ticket_event` → `rag.module.ts` warmups | in-memory index | yes | keyed overwrite |

This task fixes the one gap.

**Files:**
- Modify: `apps/api/src/memory/prisma-memory-item.repository.ts`
- Test: `apps/api/test/integration/memory/memory-upsert-replay.integration.spec.ts` (create)

**Interfaces:**
- Consumes: `PrismaMemoryItemRepository.upsert(item: MemoryItemInput): Promise<MemoryItem>` (unchanged signature).
- Produces: `upsert` returns the existing active item unchanged when it already states the same fact from the same source.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/memory/memory-upsert-replay.integration.spec.ts`:

```ts
/**
 * Outbox replays re-run MemoryOutboxSubscriber: an identical fact must be a no-op.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- memory-upsert-replay
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { MemoryKind } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaMemoryItemRepository.upsert replay', () => {
  let prismaService: PrismaService<PrismaClient>;
  let repo: PrismaMemoryItemRepository;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: process.env.DATABASE_URL } } } });
    await prismaService.onModuleInit();
    const prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaMemoryItemRepository(txManager, prismaService);
    projectId = (await prisma.project.create({ data: { name: 'Mem', slug: 'mem-replay', key: 'MEM' } })).id;
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
  });

  const fact = (object: string, sourceId = 'evt-1') => ({
    projectId,
    kind: Object.values(MemoryKind)[0] as MemoryKind,
    subject: 'KODA-1',
    predicate: 'assigned_to',
    object,
    sourceType: 'ticket_event',
    sourceId,
    confidence: 0.8,
    ttlAt: null,
  });

  it('a replay of the same fact from the same source keeps one row and the same id', async () => {
    const first = await repo.upsert(fact('alice'));
    const replay = await repo.upsert(fact('alice'));

    expect(replay.id).toBe(first.id);
    const rows = await prismaService.client.memoryItem.findMany({ where: { projectId, subject: 'KODA-1' } });
    expect(rows).toHaveLength(1);
  });

  it('a changed fact still supersedes the active one', async () => {
    const before = await repo.upsert(fact('alice'));
    const changed = await repo.upsert(fact('bob', 'evt-2'));

    expect(changed.id).not.toBe(before.id);
    const old = await prismaService.client.memoryItem.findUniqueOrThrow({ where: { id: before.id } });
    expect(old.status).toBe('superseded');
  });
});
```

(If `MemoryItemInput` requires fields not listed, copy them from `memory-outbox.subscriber.ts`'s `persistExtractedItems`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/memory/memory-upsert-replay`
Expected: FAIL on the first test (`replay.id` differs, two rows).

- [ ] **Step 3: Implement the no-op**

In `prisma-memory-item.repository.ts` `upsert`, right after `existingActive` is read and before the supersede `update`:

```ts
        // Outbox replays re-run this handler: restating the same fact from the
        // same source is a no-op instead of superseding an identical row.
        if (
          existingActive &&
          existingActive.object === (item.object ?? null) &&
          existingActive.sourceType === item.sourceType &&
          existingActive.sourceId === item.sourceId
        ) {
          return this.toDomain(existingActive);
        }
```

- [ ] **Step 4: Run the memory suites**

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/memory && bunx jest src/memory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/memory/prisma-memory-item.repository.ts apps/api/test/integration/memory/memory-upsert-replay.integration.spec.ts
git commit -m "fix(memory): replaying an identical fact is a no-op"
```

---

### Task 8: Docs and final verification

**Files:**
- Modify: `docs/architecture.md` (lines ~159, ~228, ~250-256), `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` (status line), `docs/20260925-review-whole-repo.md` (M4 status, if that doc tracks fix status like the 09-14 review did)

- [ ] **Step 1: Update the architecture doc**

In `docs/architecture.md`:
- The `OutboxModule` bullet: "durable outbox on `@nathapp/nestjs-outbox` (`PrismaOutboxStore`, `FanOutPublisher`); relay polls every 1 s with leases and capped exponential backoff (2 s base, 5 min cap, 8 attempts → `dead`); fan-out handlers for ticket_event / agent_event / decision_event / document_indexed / graphify_import / code_commit / webhook_delivery".
- The write-path diagram line `→ OutboxService.enqueue()  (non-fatal)` becomes `→ OutboxService.record()  (same transaction as the write)`.
- Replace "The outbox processor (`OutboxProcessor`) runs on a schedule and fans out to:" with "The outbox relay (`OutboxRelay`, from `@nathapp/nestjs-outbox`) claims due rows and publishes them through `FanOutPublisher` to:". Add a sentence: "A handler failure retries the whole event, so every handler must be idempotent. Admin: `GET /admin/outbox?status=pending|processing|published|dead`, `POST /admin/outbox/:id/retry` (dead or pending only). `OUTBOX_RELAY_ENABLED` overrides the default (on, except under `NODE_ENV=test`)."

In the spec, change the Status line to note "Slice 1 merged (#133); Slice 2 implemented on `feat/track1-outbox`".

If `docs/20260925-review-whole-repo.md` has a fix-status column or section (as `docs/20260914-review-whole-repo.md` did after PR #127), mark M4 fixed by this branch; otherwise leave it.

- [ ] **Step 2: Full verification from a clean state**

Run:
```bash
bun run lint && bun run type-check
cd apps/api && bun run test:db:down && bun run test && bun run test:db:up && bun run test:integration
cd ../cli && bun run test
cd ../.. && bash scripts/smoke-test-cli.sh
```
Expected: lint and type-check clean across all packages; API unit suite passes with the DB stopped; integration + e2e suites pass; CLI tests pass; CLI smoke test passes (it runs `prisma migrate reset`, which applies the new migration).

Run the drift check again (Task 3 Step 6).
Expected: `No difference detected.`

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: outbox on @nathapp/nestjs-outbox (Track 1 slice 2)"
```

- [ ] **Step 4: Hand-off**

Report to the user: commits on `feat/track1-outbox`, test evidence (unit/integration counts, smoke), and the operational note for `koda-local`: the migration requeues any `failed`/`processing` rows as due immediately, so the first relay cycles after deploy may deliver a backlog. Do not push or open the PR without explicit approval.

Out-of-scope observations to list in the PR body (not fixed here):
- `document_indexed` rows carry no `projectId` in their payload, so the lexical-index handler in `rag.module.ts` never fires for them (pre-existing).
- `graphify_import` rows carry only counts, so `EntityGraphOutboxSubscriber.handleGraphifyImport` receives no nodes or links (pre-existing).
- Retried events can apply out of order (an older retried `status_changed` or `code_commit` can overwrite newer state); handlers have no staleness guard (pre-existing, made no worse).
