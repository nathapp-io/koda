# Track 1 Slice 5 — SSE Live Ticket Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people looking at the same project see each other's ticket changes (create, edit, transition, assign, comment, delete) on the board and ticket detail within a couple of seconds, without reloading, through the Nuxt proxy; and the web e2e suite is green again and runs in CI.

**Architecture:** A new `TicketLiveSubscriber` hangs off the existing outbox fan-out for `ticket_event` and republishes a content-free `LiveEvent` onto an in-process `ProjectEventBus`. `GET /projects/:slug/events` (Nest `@Sse`) subscribes a member's stream to that bus, sends `ready` immediately, re-validates access every heartbeat (named `ping` event), and closes at token expiry, on revocation, or on membership loss. The web gets a dedicated abort-aware Nitro proxy route for the stream, a framework-free `EventSource` client core wrapped by a `useProjectEvents` composable, and silent (no `pending` flash) refetches on the board and ticket detail. Comment create gains a transaction and a `COMMENT_ADDED` ticket event. The e2e suite stops logging in per test (session cache) and gains a CI job.

**Tech Stack:** NestJS 11.1.28 (`@Sse`, rxjs `Observable`) on Fastify in production / Express in integration tests, Prisma 6 on Postgres 16, `@nathapp/nestjs-*` 3.3.0 (outbox, auth, common, throttler), Jest + supertest + Node `fetch` streaming; Nuxt 3.21 / Nitro 2.13 / h3 1.15 web, Jest (node env) for web unit and source-level tests, Playwright (chromium) for e2e; GitHub Actions; Bun 1.3.11.

**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md`, section "Slice 5 — SSE live ticket updates" (re-designed 2026-09-26, spec-review corrections `53d1848d`). Read it before starting. It records the verified facts this plan relies on.

**Branch:** `feat/track1-sse` (already created off `main` @ `bba91e23`; holds only the spec commits). Push with `git push -u origin feat/track1-sse` only when the user approves.

## Global Constraints

- `LiveEvent` (verbatim from the spec): `{ id, type: 'ticket', action, projectId, ticketId, actorId, at }`, `action ∈ created | updated | transitioned | assigned | commented | deleted`. No ticket content and no ref. `id` is the `ticket_event` envelope `id` (the `TicketEvent` row id); it is stable across outbox retries.
- Action mapping: `TICKET_CREATED→created`, `TICKET_UPDATED→updated`, `status_changed→transitioned`, `assigned→assigned`, `COMMENT_ADDED→commented`, `TICKET_DELETED→deleted`. Unknown actions are dropped.
- Live events are an outbox subscriber only. No code publishes to the bus except `TicketLiveSubscriber`. The subscriber never throws.
- SSE wire format: event name = `ready` (on connect), `ping` (heartbeat), `ticket` (a `LiveEvent`; the event name is `LiveEvent.type`). `data` is JSON. The browser client listens to `ticket` only.
- Stream access: user principals only (agents 403), `assertProjectMembership` (403), max 5 concurrent streams per user (429 via `ThrottleAppException`), `@SkipThrottle()`, `@ApiExcludeEndpoint()`.
- Heartbeat `LIVE_HEARTBEAT_MS` (default `25000`, digits only, minimum `100`). Each heartbeat re-validates with `JwtAuthProvider.getPrincipal(jwtPayload)` (`revoked` covers `tokenVersion` and `disabled`, 60 s cache) and `ProjectsService.assertProjectMembership` (live query); failure closes the stream. The stream also closes at the token's `exp`.
- Comment create: one transaction for the comment row, the `TicketEvent` row (`action: 'COMMENT_ADDED'`, `data: { commentId }`) and the `ticket_event` outbox row. Comments created inside a transition keep emitting only `status_changed`.
- Web live refetches never call `useAsyncData` `refresh()`. Fetch with `$api` and assign to the data ref (board: `reloadLoaded()`; detail: ticket data ref and `useNuxtData('comments-<slug>-<ref>')`).
- Web client: dedupe by `id` (last 200); `resync` after any reopen that followed an error; on a terminal failure (`readyState === 2`) call `useAuth().refresh()` then reopen with backoff 1 s, 2 s, 4 s … capped at 30 s; stop after 5 consecutive terminal failures or when the refresh fails.
- The login throttle (5/min per IP, `auth.controller.ts`) is not changed. E2E fixes live in the tests.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok` for JSON endpoints, `AppException` subclasses with i18n prefixes (`src/i18n/{en,zh}/<prefix>.json`, both languages), `registerAs` config validated with class-validator **and** the Joi schema in `env.validation.ts` (keep the two rules equivalent), no `process.env` outside config files and test harnesses, no `console.log` in the API.
- `bun run test` (unit) passes with **no database running**. DB-backed tests live in `apps/api/test/integration/`, gated by `KODA_DB_TESTS === '1'`; run with `cd apps/api && bun run test:db:up && bun run test:integration` (PG16 on port 5433). Under Jest `NODE_ENV=test`, so the outbox relay does not poll: integration tests call `app.get(OutboxRelay).dispatchPendingBatch()`.
- Jest shares `process.env` across files (`maxWorkers: 1`); any test that sets an env var restores it.
- Never hand-edit `openapi.json` or `apps/cli/src/generated/`. This slice adds no documented endpoint, so no regeneration is needed; if `bun run generate` shows a diff, stop and investigate.
- Code style (user rules): no emojis in code/comments/docs, immutable updates (spread, not mutation), files under 400 lines where practical, functions under 50 lines.
- Do not push, open a PR, or touch `projects/koda/deployments/koda-local` without the user's explicit approval at that moment.
- Git: the rtk hook rewrites git commands. If one misbehaves, prefix it with `RTK_DISABLED=1`.

## Review Focus

1. **A closed browser tab behind the Nuxt proxy.** h3 `proxyRequest` never aborts upstream, so without the dedicated route each closed tab would keep an API stream (and a cap slot) alive until the 6th tab gets 429. Expected: closing the tab ends the API stream. Pinned in Task 5 (unit: the upstream `fetch` signal aborts when the client request closes) and Task 9 (e2e: the board is opened and left 6 times in one context, then a transition still arrives live).
2. **A member removed (or a user disabled) while their board is open.** Expected: the stream closes within one heartbeat (plus the 60 s auth cache for disable), and the browser does not retry forever. Pinned in Task 4 (integration: removal closes the stream) and Task 6 (unit: 5 consecutive terminal failures stop reconnecting; a failed auth refresh stops immediately).
3. **An event from another project.** Expected: never delivered to this project's stream. Pinned in Task 1 (unit: bus isolation) and Task 4 (integration: a ticket created in project B produces nothing on project A's stream).
4. **A crafted slug on the proxy route** (`..%2F..%2Fadmin%2Fusers`, `a/b`). Expected: 400 without calling the API. Pinned in Task 5 (unit: `buildLiveUpstreamUrl` rejects anything outside `^[a-z0-9]+(-[a-z0-9]+)*$`, the project slug rule from `create-project.dto.ts`).
5. **An open edit form on ticket detail when someone else changes the ticket.** A `refresh()` would flip `pending`, swap the page for `LoadingState` and unmount the form. Expected: the ticket data updates in place and the edit form stays open. Pinned in Task 7 (source-level test: no live handler calls `refresh(`; the live path assigns `ticketData.value`).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/live/live-event.ts` | `LiveEvent`, `LiveTicketAction`, `TICKET_ACTION_TO_LIVE`, `toLiveEvent()` | 1 |
| `apps/api/src/live/project-event-bus.ts` (+ spec) | in-process `projectId → callbacks` bus | 1 |
| `apps/api/src/live/ticket-live.subscriber.ts` (+ spec) | `ticket_event` fan-out handler → bus | 1 |
| `apps/api/src/live/live.module.ts` (+ spec) | wiring (grows in Task 3) | 1, 3 |
| `apps/api/src/app.module.ts` | imports `LiveModule`; loads `liveConfig` | 1, 3 |
| `apps/api/src/comments/comments.service.ts` (+ spec) | transactional create + `COMMENT_ADDED` event | 2 |
| `apps/api/src/comments/comments.module.ts` | imports `EventsModule` | 2 |
| `apps/api/src/memory/extraction.service.spec.ts` | pin: `COMMENT_ADDED` extracts nothing | 2 |
| `apps/api/src/entity-graph/entity-graph.service.spec.ts` | pin: `COMMENT_ADDED` writes no node | 2 |
| `apps/api/test/integration/comments/comment-event.integration.spec.ts` | comment + event + outbox commit together | 2 |
| `apps/api/src/config/live.config.ts` (+ spec), `env.validation.ts`, `config-bridge.module.ts` | `LIVE_HEARTBEAT_MS` → `LIVE_CFG` | 3 |
| `apps/api/src/auth/auth.module.ts` | export `kodaTokenExtractor` and `JwtAuthProvider` | 3 |
| `apps/api/src/live/jwt-payload.ts` (+ spec) | `decodeJwtPayload()`, `tokenExpiryMs()` | 3 |
| `apps/api/src/live/live-stream-registry.ts` (+ spec) | per-user concurrent stream cap | 3 |
| `apps/api/src/live/live-stream.ts` (+ spec) | `createLiveStream()` Observable: ready, events, heartbeat, expiry, teardown | 3 |
| `apps/api/src/live/live.controller.ts` (+ spec) | `GET /projects/:slug/events` | 3 |
| `apps/api/src/i18n/{en,zh}/live.json` | 403 / 429 messages | 3 |
| `apps/api/.env.example` | `LIVE_HEARTBEAT_MS` | 3 |
| `apps/api/test/helpers/sse-client.ts` | streaming SSE reader for integration tests | 4 |
| `apps/api/test/integration/live/live-stream.integration.spec.ts` | stream over HTTP on PG | 4 |
| `apps/web/server/utils/live-proxy.ts` | `buildLiveUpstreamUrl()`, `LIVE_STREAM_HEADERS`, `proxyLiveStream()` | 5 |
| `apps/web/server/api/projects/[slug]/events.get.ts` | Nitro route using `proxyLiveStream` | 5 |
| `apps/web/tests/server/live-proxy.spec.ts` | proxy unit tests | 5 |
| `apps/web/lib/project-event-stream.ts` | framework-free `EventSource` client core | 6 |
| `apps/web/composables/useProjectEvents.ts` | Nuxt lifecycle wrapper | 6 |
| `apps/web/tests/lib/project-event-stream.spec.ts`, `apps/web/tests/composables/useProjectEvents.spec.ts` | client tests | 6 |
| `apps/web/lib/debounce.ts` (+ `tests/lib/debounce.spec.ts`) | `createDebouncer()` | 7 |
| `apps/web/composables/useTicketBoardPages.ts` (+ spec) | `reloadLoaded()` | 7 |
| `apps/web/pages/[project]/index.vue` | board live wiring | 7 |
| `apps/web/pages/[project]/tickets/[ref].vue` | detail live wiring + deleted notice | 7 |
| `apps/web/components/TicketBoard.vue` | `data-testid="board-column-<STATUS>"` | 7 |
| `apps/web/i18n/locales/{en,zh}.json`, `apps/web/tests/i18n/live-locale-parity.spec.ts` | `tickets.live.deleted` | 7 |
| `apps/web/tests/pages/live-wiring.spec.ts` | source-level wiring pins | 7 |
| `apps/web/tests/e2e/fixtures/session.ts` | cached login per worker, 429 back-off | 8 |
| `apps/web/tests/e2e/fixtures/api-client.ts`, `page-helpers.ts` | use the session cache | 8 |
| `apps/web/tests/e2e/auth.spec.ts`, `ticket-detail-operations.e2e.spec.ts` | fresh sessions for logout/refresh; no `networkidle` on stream pages | 8 |
| `apps/web/playwright.config.ts` | `E2E_WEB_MODE=build` | 8 |
| `apps/web/tests/e2e/live-board.spec.ts` | two-context live proof | 9 |
| `.github/workflows/ci.yml` | `e2e` job | 9 |
| `docs/architecture.md`, spec status line | docs | 10 |

---

### Task 1: Live event pipeline (types, bus, subscriber)

**Files:**
- Create: `apps/api/src/live/live-event.ts`
- Create: `apps/api/src/live/project-event-bus.ts`, `apps/api/src/live/project-event-bus.spec.ts`
- Create: `apps/api/src/live/ticket-live.subscriber.ts`, `apps/api/src/live/ticket-live.subscriber.spec.ts`
- Create: `apps/api/src/live/live.module.ts`, `apps/api/src/live/live.module.spec.ts`
- Modify: `apps/api/src/app.module.ts` (import `LiveModule`)

**Interfaces:**
- Consumes: `FanOutPublisher.register(type: string, handler: (payload: unknown) => void | Promise<void>)` from `src/outbox/fan-out-publisher.ts`; `OutboxModule` (exports `OutboxCoreModule`, which exports `FanOutPublisher`).
- Produces:
  - `type LiveTicketAction = 'created' | 'updated' | 'transitioned' | 'assigned' | 'commented' | 'deleted'`
  - `interface LiveEvent { id: string; type: 'ticket'; action: LiveTicketAction; projectId: string; ticketId: string; actorId: string; at: string }`
  - `const TICKET_ACTION_TO_LIVE: Readonly<Record<string, LiveTicketAction>>`
  - `function toLiveEvent(payload: unknown): LiveEvent | null`
  - `type LiveListener = (event: LiveEvent) => void`
  - `class ProjectEventBus { subscribe(projectId: string, listener: LiveListener): () => void; publish(event: LiveEvent): void; listenerCount(projectId: string): number }`
  - `class TicketLiveSubscriber implements OnModuleInit`
  - `class LiveModule` (Task 3 adds the controller and more providers)

- [ ] **Step 1: Write the failing bus test**

`apps/api/src/live/project-event-bus.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { ProjectEventBus } from './project-event-bus';
import type { LiveEvent } from './live-event';

const event = (projectId: string, id = 'evt-1'): LiveEvent => ({
  id,
  type: 'ticket',
  action: 'created',
  projectId,
  ticketId: 't1',
  actorId: 'u1',
  at: '2026-09-26T00:00:00.000Z',
});

describe('ProjectEventBus', () => {
  it('delivers an event to every listener of its project', () => {
    const bus = new ProjectEventBus();
    const a = jest.fn();
    const b = jest.fn();
    bus.subscribe('p1', a);
    bus.subscribe('p1', b);

    bus.publish(event('p1'));

    expect(a).toHaveBeenCalledWith(event('p1'));
    expect(b).toHaveBeenCalledWith(event('p1'));
  });

  it('never delivers an event to another project', () => {
    const bus = new ProjectEventBus();
    const other = jest.fn();
    bus.subscribe('p2', other);

    bus.publish(event('p1'));

    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and forgets empty projects', () => {
    const bus = new ProjectEventBus();
    const listener = jest.fn();
    const unsubscribe = bus.subscribe('p1', listener);

    unsubscribe();
    bus.publish(event('p1'));

    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount('p1')).toBe(0);
  });

  it('unsubscribe is idempotent and leaves other listeners alone', () => {
    const bus = new ProjectEventBus();
    const keep = jest.fn();
    const unsubscribe = bus.subscribe('p1', jest.fn());
    bus.subscribe('p1', keep);

    unsubscribe();
    unsubscribe();
    bus.publish(event('p1'));

    expect(keep).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('p1')).toBe(1);
  });

  it('isolates a throwing listener: the others still run and publish does not throw', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bus = new ProjectEventBus();
    const after = jest.fn();
    bus.subscribe('p1', () => {
      throw new Error('boom');
    });
    bus.subscribe('p1', after);

    expect(() => bus.publish(event('p1'))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('the same listener function subscribed twice gets two independent subscriptions', () => {
    const bus = new ProjectEventBus();
    const listener = jest.fn();
    const first = bus.subscribe('p1', listener);
    bus.subscribe('p1', listener);

    first();
    bus.publish(event('p1'));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
```

The last test matters: two browser tabs of the same user register separate closures today, but a subscription must be identified by its registration, not by function identity.

- [ ] **Step 2: Write the failing subscriber test**

`apps/api/src/live/ticket-live.subscriber.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';
import { toLiveEvent } from './live-event';

const envelope = (action: string, overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  type: 'ticket_event',
  action,
  timestamp: '2026-09-26T01:02:03.000Z',
  ticketId: 't1',
  projectId: 'p1',
  actorId: 'u1',
  actorType: 'user',
  data: { title: 'secret title' },
  ...overrides,
});

describe('toLiveEvent', () => {
  it.each([
    ['TICKET_CREATED', 'created'],
    ['TICKET_UPDATED', 'updated'],
    ['status_changed', 'transitioned'],
    ['assigned', 'assigned'],
    ['COMMENT_ADDED', 'commented'],
    ['TICKET_DELETED', 'deleted'],
  ])('maps %s to %s', (action, live) => {
    expect(toLiveEvent(envelope(action))).toEqual({
      id: 'evt-1',
      type: 'ticket',
      action: live,
      projectId: 'p1',
      ticketId: 't1',
      actorId: 'u1',
      at: '2026-09-26T01:02:03.000Z',
    });
  });

  it('carries no ticket content', () => {
    expect(JSON.stringify(toLiveEvent(envelope('TICKET_CREATED')))).not.toContain('secret title');
  });

  it.each([
    ['an unknown action', envelope('label_added')],
    ['a missing ticketId', envelope('TICKET_CREATED', { ticketId: undefined })],
    ['a missing projectId', envelope('TICKET_CREATED', { projectId: undefined })],
    ['a missing id', envelope('TICKET_CREATED', { id: undefined })],
    ['a non-object payload', 'not-an-object'],
    ['null', null],
  ])('returns null for %s', (_label, payload) => {
    expect(toLiveEvent(payload)).toBeNull();
  });
});

describe('TicketLiveSubscriber', () => {
  it('registers on ticket_event and publishes mapped events to the bus', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const bus = new ProjectEventBus();
    const listener = jest.fn();
    bus.subscribe('p1', listener);
    new TicketLiveSubscriber(registry, bus).onModuleInit();

    await registry.publish(outboxRecord('ticket_event', envelope('status_changed')));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1', action: 'transitioned' }));
  });

  it('drops unknown actions silently', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const bus = new ProjectEventBus();
    const listener = jest.fn();
    bus.subscribe('p1', listener);
    new TicketLiveSubscriber(registry, bus).onModuleInit();

    await registry.publish(outboxRecord('ticket_event', envelope('label_added')));

    expect(listener).not.toHaveBeenCalled();
  });

  it('never throws, so it can never cause an outbox retry', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = new FanOutPublisher(noopLastErrors);
    const bus = { publish: jest.fn(() => { throw new Error('bus down'); }) } as unknown as ProjectEventBus;
    new TicketLiveSubscriber(registry, bus).onModuleInit();

    await expect(registry.publish(outboxRecord('ticket_event', envelope('TICKET_CREATED')))).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/live`
Expected: FAIL with "Cannot find module './project-event-bus'" (and the same for the other new files).

- [ ] **Step 4: Implement `live-event.ts`**

```ts
/**
 * Track 1 Slice 5: the content-free live event pushed to browsers over SSE.
 * `type` is a union with one member today; fleet S2 adds members.
 * `id` is the ticket_event envelope id (the TicketEvent row id), stable
 * across outbox retries, so clients can drop duplicate deliveries.
 */
export type LiveTicketAction = 'created' | 'updated' | 'transitioned' | 'assigned' | 'commented' | 'deleted';

export interface LiveEvent {
  id: string;
  type: 'ticket';
  action: LiveTicketAction;
  projectId: string;
  ticketId: string;
  actorId: string;
  at: string;
}

export const TICKET_ACTION_TO_LIVE: Readonly<Record<string, LiveTicketAction>> = Object.freeze({
  TICKET_CREATED: 'created',
  TICKET_UPDATED: 'updated',
  status_changed: 'transitioned',
  assigned: 'assigned',
  COMMENT_ADDED: 'commented',
  TICKET_DELETED: 'deleted',
});

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Maps a ticket_event outbox envelope to a LiveEvent; null when it cannot or should not be sent. */
export function toLiveEvent(payload: unknown): LiveEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const action = typeof p['action'] === 'string' ? TICKET_ACTION_TO_LIVE[p['action']] : undefined;
  if (!action) return null;
  const { id, projectId, ticketId, actorId, timestamp } = p;
  if (!isNonEmptyString(id) || !isNonEmptyString(projectId) || !isNonEmptyString(ticketId)) return null;
  return {
    id,
    type: 'ticket',
    action,
    projectId,
    ticketId,
    actorId: isNonEmptyString(actorId) ? actorId : '',
    at: isNonEmptyString(timestamp) ? timestamp : new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Implement `project-event-bus.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { LiveEvent } from './live-event';

export type LiveListener = (event: LiveEvent) => void;

interface Subscription {
  readonly listener: LiveListener;
}

/**
 * In-process fan-out of live events to open SSE streams, keyed by project.
 * Single API instance by design (spec constraint: no Redis). publish() never
 * throws: a failing listener is logged and skipped.
 */
@Injectable()
export class ProjectEventBus {
  private readonly logger = new Logger(ProjectEventBus.name);
  private subscriptions: ReadonlyMap<string, readonly Subscription[]> = new Map();

  subscribe(projectId: string, listener: LiveListener): () => void {
    const subscription: Subscription = { listener };
    this.subscriptions = new Map([...this.subscriptions, [projectId, [...this.forProject(projectId), subscription]]]);
    return () => this.remove(projectId, subscription);
  }

  publish(event: LiveEvent): void {
    for (const { listener } of this.forProject(event.projectId)) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(`Live listener failed for project ${event.projectId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  listenerCount(projectId: string): number {
    return this.forProject(projectId).length;
  }

  private forProject(projectId: string): readonly Subscription[] {
    return this.subscriptions.get(projectId) ?? [];
  }

  private remove(projectId: string, subscription: Subscription): void {
    const remaining = this.forProject(projectId).filter((s) => s !== subscription);
    const next = new Map(this.subscriptions);
    if (remaining.length > 0) next.set(projectId, remaining);
    else next.delete(projectId);
    this.subscriptions = next;
  }
}
```

- [ ] **Step 6: Implement `ticket-live.subscriber.ts`**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { ProjectEventBus } from './project-event-bus';
import { toLiveEvent } from './live-event';

/**
 * ticket_event fan-out handler that republishes a content-free LiveEvent to
 * the in-process bus. Never throws, so it never causes an outbox retry
 * (a sibling handler's failure can still cause a re-delivery; clients dedupe
 * on the event id).
 */
@Injectable()
export class TicketLiveSubscriber implements OnModuleInit {
  private readonly logger = new Logger(TicketLiveSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly bus: ProjectEventBus,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent);
  }

  private readonly handleTicketEvent = (payload: unknown): void => {
    try {
      const event = toLiveEvent(payload);
      if (event) this.bus.publish(event);
    } catch (err) {
      this.logger.warn(`Live ticket event dropped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
```

- [ ] **Step 7: Implement `live.module.ts` and wire it into `AppModule`**

```ts
import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';

@Module({
  imports: [OutboxModule],
  providers: [ProjectEventBus, TicketLiveSubscriber],
  exports: [ProjectEventBus],
})
export class LiveModule {}
```

In `apps/api/src/app.module.ts` add `import { LiveModule } from './live/live.module';` next to the other feature imports and add `LiveModule,` to the `imports` array directly after `OutboxAdminModule,`.

- [ ] **Step 8: Write the module wiring test**

Module DI tests are unit tests that compile the real module without a database (`.nax/mono/apps/api/context.md`, "Module registration / DI tests must be unit-level"). `GlobalStubsModule` supplies Prisma, the transaction manager, and a real `ConfigModule` with `outboxConfig` loaded.

`apps/api/src/live/live.module.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { LiveModule } from './live.module';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';

describe('LiveModule (DI wiring, no database)', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, LiveModule] }).compile();
  });

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves the bus and the subscriber', () => {
    expect(moduleRef.get(ProjectEventBus)).toBeInstanceOf(ProjectEventBus);
    expect(moduleRef.get(TicketLiveSubscriber)).toBeInstanceOf(TicketLiveSubscriber);
  });

  it('registers the live handler on ticket_event at init', async () => {
    await moduleRef.init();
    const handlers = moduleRef.get(FanOutPublisher).getHandlers('ticket_event');
    expect(handlers.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd apps/api && bunx jest src/live`
Expected: PASS (3 suites). If `moduleRef.init()` starts the outbox relay timer, it does not: `.env.test` has no `NODE_ENV` override and Jest sets `NODE_ENV=test`, so the relay is disabled.

Run: `cd apps/api && bun run type-check`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/live apps/api/src/app.module.ts
git commit -m "feat(api): live event bus and ticket_event live subscriber (Track 1 Slice 5)"
```

---

### Task 2: `COMMENT_ADDED` ticket event from comment create

**Files:**
- Modify: `apps/api/src/comments/comments.service.ts` (constructor, `create`)
- Modify: `apps/api/src/comments/comments.module.ts` (import `EventsModule`)
- Modify: `apps/api/src/comments/comments.service.spec.ts` (providers, new tests)
- Modify: `apps/api/src/memory/extraction.service.spec.ts` (pin)
- Modify: `apps/api/src/entity-graph/entity-graph.service.spec.ts` (pin)
- Create: `apps/api/test/integration/comments/comment-event.integration.spec.ts`

**Interfaces:**
- Consumes: `TicketEventService.create(data: WriteTicketEventInput): Promise<TicketEventDomain>` (`src/events/ticket-event.service.ts`, exported by `EventsModule`); `OutboxService` from `@nathapp/nestjs-outbox` (global module, injectable everywhere; alias it `NathappOutboxService` as `tickets.service.ts` does); `buildTicketEventOutboxPayload` (`src/events/outbox-envelope.util.ts`); `ITransactionManager`, `TRANSACTION_MANAGER` (`@nathapp/nestjs-data`).
- Produces: `COMMENT_ADDED` ticket events with `data: { commentId }`, consumed by Task 1's mapping (`commented`).

Why the code is inlined rather than calling `TicketsService.recordTicketEvent`: that method is private, and importing `TicketsModule` into `CommentsModule` would drag the whole ticket graph (RAG, VCS, webhooks) into comments. The two calls below mirror it exactly.

- [ ] **Step 1: Update the spec's testing module and write the failing tests**

In `apps/api/src/comments/comments.service.spec.ts`:

1. Add imports at the top:

```ts
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../events/ticket-event.service';
```

2. Next to the other mocks (above the `beforeEach` that builds the module, around line 150), add:

```ts
  const callOrder: string[] = [];
  const mockTxManager = {
    run: jest.fn(async <T>(fn: () => Promise<T>) => {
      callOrder.push('tx:start');
      const result = await fn();
      callOrder.push('tx:end');
      return result;
    }),
  };
  const mockTicketEventService = {
    create: jest.fn(async () => {
      callOrder.push('ticketEvent');
      return { id: 'tev-1', action: 'COMMENT_ADDED', timestamp: new Date('2026-09-26T00:00:00.000Z') };
    }),
  };
  const mockOutbox = {
    record: jest.fn(async () => {
      callOrder.push('outbox');
    }),
  };
```

3. Extend the providers of the existing `Test.createTestingModule` (line ~161):

```ts
      providers: [
        CommentsService,
        { provide: COMMENT_REPOSITORY, useValue: mockCommentRepo },
        { provide: KodaCaslAbilityFactory, useValue: { createForUser: jest.fn().mockResolvedValue({ can: mockCaslCan }) } },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
        { provide: TicketEventService, useValue: mockTicketEventService },
        { provide: NathappOutboxService, useValue: mockOutbox },
      ],
```

4. In the existing `afterEach`, after `jest.clearAllMocks();`, add `callOrder.length = 0;` (test-local bookkeeping array; resetting it between tests is the point).

5. Add a new `describe` block inside the top-level describe:

```ts
  describe('create — COMMENT_ADDED ticket event', () => {
    beforeEach(() => {
      mockCommentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockCommentRepo.findTicketScoped.mockResolvedValue(mockTicket);
      mockCommentRepo.create.mockImplementation(async () => {
        callOrder.push('comment');
        return mockComment;
      });
    });

    it('writes the comment, the TicketEvent and the outbox row inside one transaction', async () => {
      await service.create('koda', 'KODA-1', { body: 'hello', type: 'GENERAL' }, mockUserPrincipal);

      expect(callOrder).toEqual(['tx:start', 'comment', 'ticketEvent', 'outbox', 'tx:end']);
    });

    it('records COMMENT_ADDED with only the comment id as data', async () => {
      await service.create('koda', 'KODA-1', { body: 'secret body', type: 'GENERAL' }, mockUserPrincipal);

      expect(mockTicketEventService.create).toHaveBeenCalledWith({
        ticketId: mockTicket.id,
        projectId: mockProject.id,
        action: 'COMMENT_ADDED',
        actorId: mockUserPrincipal.id,
        actorType: 'user',
        source: 'internal',
        data: { commentId: mockComment.id },
      });
      const recorded = mockOutbox.record.mock.calls[0][0] as { type: string; payload: Record<string, unknown>; metadata: Record<string, unknown> };
      expect(recorded.type).toBe('ticket_event');
      expect(recorded.payload).toEqual(expect.objectContaining({
        id: 'tev-1',
        type: 'ticket_event',
        action: 'COMMENT_ADDED',
        ticketId: mockTicket.id,
        projectId: mockProject.id,
        data: { commentId: mockComment.id },
      }));
      expect(JSON.stringify(recorded.payload)).not.toContain('secret body');
      expect(recorded.metadata).toEqual({ projectId: mockProject.id, eventId: 'tev-1' });
    });

    it('marks agent authors as actorType agent', async () => {
      await service.create('koda', 'KODA-1', { body: 'hi', type: 'GENERAL' }, mockAgentPrincipal);

      expect(mockTicketEventService.create).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'agent-123', actorType: 'agent' }));
    });

    it('propagates an event-write failure so the transaction rolls back', async () => {
      mockTicketEventService.create.mockRejectedValueOnce(new Error('db down'));

      await expect(service.create('koda', 'KODA-1', { body: 'hi', type: 'GENERAL' }, mockUserPrincipal)).rejects.toThrow('db down');
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('does not open a transaction when validation fails', async () => {
      await expect(service.create('koda', 'KODA-1', { body: '   ', type: 'GENERAL' }, mockUserPrincipal)).rejects.toBeDefined();
      expect(mockTxManager.run).not.toHaveBeenCalled();
    });
  });
```

If `mockComment`, `mockProject`, `mockTicket`, `mockUserPrincipal` or `mockAgentPrincipal` are named differently in the file, use the file's names (they exist at the top of the spec as of `bba91e23`).

- [ ] **Step 2: Add the handler pins**

In `apps/api/src/memory/extraction.service.spec.ts`, inside the top-level `describe('ExtractionService', …)`:

```ts
  it('Slice 5: extracts nothing from a COMMENT_ADDED ticket event', () => {
    const items = service.extractFromEvent({
      type: 'ticket_event',
      id: 'evt-comment',
      ticketId: 'ticket-1',
      projectId: 'project-123',
      actorId: 'user-1',
      action: 'COMMENT_ADDED',
      data: { commentId: 'comment-1' },
      timestamp: new Date(),
    } as Parameters<ExtractionService['extractFromEvent']>[0]);

    expect(items).toEqual([]);
  });
```

In `apps/api/src/entity-graph/entity-graph.service.spec.ts`, inside `describe('onTicketEvent', …)`:

```ts
    it('Slice 5: COMMENT_ADDED writes no entity node', async () => {
      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-comment',
        ticketId: 'ticket-comment',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'COMMENT_ADDED',
        data: { commentId: 'comment-1' },
        timestamp: new Date(),
      });

      expect(await entityStore.findNodeByEntityId('project-123', 'ticket-comment')).toBeNull();
    });
```

These pin current behavior (both already no-op on an unknown action; see the spec's verified facts). They should pass immediately; that is expected for a pin.

- [ ] **Step 3: Run the tests to verify the comment tests fail**

Run: `cd apps/api && bunx jest src/comments/comments.service.spec.ts src/memory/extraction.service.spec.ts src/entity-graph/entity-graph.service.spec.ts`
Expected: the new `create — COMMENT_ADDED ticket event` tests FAIL (no transaction, no event calls); the two pins PASS; all pre-existing tests PASS.

- [ ] **Step 4: Implement the transactional create**

In `apps/api/src/comments/comments.service.ts`:

Add imports:

```ts
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../events/outbox-envelope.util';
```

Replace the constructor:

```ts
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly commentRepo: PrismaCommentRepository,
    private readonly caslAbilityFactory: KodaCaslAbilityFactory,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly ticketEventService: TicketEventService,
    private readonly outbox: NathappOutboxService,
  ) {}
```

Add a private method (mirrors `TicketsService.recordTicketEvent`):

```ts
  /**
   * Slice 5: writes the COMMENT_ADDED TicketEvent row and its ticket_event
   * outbox row. Must run inside the comment's txManager.run so all three
   * commit or roll back together. Carries the comment id, never its body.
   */
  private async recordCommentAdded(
    ticketId: string,
    projectId: string,
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    const actorType = isUserPrincipal(principal) ? 'user' : 'agent';
    const data = { commentId };
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action: 'COMMENT_ADDED',
      actorId: principal.id,
      actorType,
      source: 'internal',
      data,
    });
    await this.outbox.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }
```

In `create`, change `const { ticket } = await this.resolveTicketByRef(...)` to `const { project, ticket } = await this.resolveTicketByRef(projectSlug, ticketRef);` and wrap the insert:

```ts
    const comment = await this.txManager.run(async () => {
      // id/createdAt/updatedAt are DB-generated; toPersistenceCreate strips them.
      const created = await this.commentRepo.create({
        id: '',
        ticketId: ticket.id,
        body: createCommentDto.body,
        type: createCommentDto.type as CommentType,
        authorUserId: isUserPrincipal(principal) ? principal.id : null,
        authorAgentId: isUserPrincipal(principal) ? null : principal.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await this.recordCommentAdded(ticket.id, project.id, created.id, principal);
      return created;
    });

    return CommentResponseDto.from(comment);
```

(The existing `if (!createCommentDto.type) { createCommentDto.type = CommentType.GENERAL; }` mutation predates this slice; leave it.)

In `apps/api/src/comments/comments.module.ts` add `import { EventsModule } from '../events/events.module';` and change `imports: [AuthModule]` to `imports: [AuthModule, EventsModule]`.

- [ ] **Step 5: Find other constructions of `CommentsService`**

Run: `cd apps/api && grep -rn "new CommentsService(\|CommentsService," src test | grep -v "comments.service.ts"`
Expected: only DI registrations and the controller spec's mock. If any test constructs `CommentsService` positionally or builds a testing module with the real `CommentsService` but without the three new providers, add the same three providers there (`TRANSACTION_MANAGER`, `TicketEventService`, `NathappOutboxService` mocks).

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `cd apps/api && bunx jest src/comments src/memory/extraction.service.spec.ts src/entity-graph/entity-graph.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the integration test**

`apps/api/test/integration/comments/comment-event.integration.spec.ts`:

```ts
/**
 * Slice 5 — comment create records COMMENT_ADDED (TicketEvent + outbox row) atomically, on real Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/comments/comment-event
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('comment create → COMMENT_ADDED (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get(PrismaService).client as PrismaClient;
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    token = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Comments', slug: 'comments', key: 'CMT' }).expect(201);
    await request(server).post('/api/projects/comments/tickets').set({ Authorization: `Bearer ${token}` })
      .send({ type: 'BUG', title: 'Commented ticket' }).expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes the comment, a COMMENT_ADDED TicketEvent and a ticket_event outbox row', async () => {
    const res = await request(server).post('/api/projects/comments/tickets/CMT-1/comments')
      .set({ Authorization: `Bearer ${token}` })
      .send({ body: 'first comment', type: 'GENERAL' }).expect(201);
    const commentId = data<{ id: string }>(res).id;

    const events = await prisma.ticketEvent.findMany({ where: { action: 'COMMENT_ADDED' } });
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].data))).toEqual({ commentId });

    const outbox = await prisma.outboxEvent.findMany({ where: { type: 'ticket_event', eventId: events[0].id } });
    expect(outbox).toHaveLength(1);
    const payload = JSON.parse(String(outbox[0].payload)) as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({ id: events[0].id, action: 'COMMENT_ADDED' }));
    expect(outbox[0].payload).not.toContain('first comment');
  });

  it('a comment created by a transition emits only status_changed', async () => {
    const before = await prisma.ticketEvent.count({ where: { action: 'COMMENT_ADDED' } });

    await request(server).post('/api/projects/comments/tickets/CMT-1/verify')
      .set({ Authorization: `Bearer ${token}` })
      .send({ body: 'verified with a comment' }).expect(200);

    expect(await prisma.ticketEvent.count({ where: { action: 'COMMENT_ADDED' } })).toBe(before);
    expect(await prisma.ticketEvent.count({ where: { action: 'status_changed' } })).toBe(1);
  });
});
```

Before running, confirm the Prisma model and field names this test uses: `grep -n "model TicketEvent\|model OutboxEvent" -A20 apps/api/prisma/schema.prisma`. If `TicketEvent.data` is a `Json` column rather than a JSON string, drop the `JSON.parse(String(...))` and compare the value directly; if the delegate is named differently (for example `ticketEvent` vs `ticketEvents`), use the schema's name. Keep the assertions' meaning.

- [ ] **Step 8: Run the integration test**

Run: `cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/comments/comment-event`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/comments apps/api/src/memory/extraction.service.spec.ts apps/api/src/entity-graph/entity-graph.service.spec.ts apps/api/test/integration/comments
git commit -m "feat(api): comment create emits COMMENT_ADDED ticket event in one transaction"
```

---

### Task 3: `GET /projects/:slug/events` stream endpoint

**Files:**
- Create: `apps/api/src/config/live.config.ts`, `apps/api/src/config/live.config.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts` (Joi rule), `apps/api/src/config/config-bridge.module.ts` (`LIVE_CFG`), `apps/api/src/app.module.ts` (`load: [..., liveConfig]`)
- Modify: `apps/api/src/common/test-helpers/global-stubs.module.ts` (`LIVE_CFG` stub)
- Modify: `apps/api/src/auth/auth.module.ts` (export `kodaTokenExtractor`, export `JwtAuthProvider`)
- Create: `apps/api/src/live/jwt-payload.ts`, `apps/api/src/live/jwt-payload.spec.ts`
- Create: `apps/api/src/live/live-stream-registry.ts`, `apps/api/src/live/live-stream-registry.spec.ts`
- Create: `apps/api/src/live/live-stream.ts`, `apps/api/src/live/live-stream.spec.ts`
- Create: `apps/api/src/live/live.controller.ts`, `apps/api/src/live/live.controller.spec.ts`
- Modify: `apps/api/src/live/live.module.ts`, `apps/api/src/live/live.module.spec.ts`
- Create: `apps/api/src/i18n/en/live.json`, `apps/api/src/i18n/zh/live.json`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Consumes: Task 1 `ProjectEventBus.subscribe(projectId, listener): () => void`, `LiveEvent`; `ProjectAccessService.findProjectIdBySlug(slug): Promise<string>` and `.assertProjectMembership(projectId, principal): Promise<void>` (`src/projects/project-access.service.ts`, exported by `ProjectAccessModule` from `src/projects/project-access.module.ts`); `JwtAuthProvider.getPrincipal(jwtPayload: Record<string, unknown>): Promise<UserPrincipal>` (`revoked` is true for a stale `tokenVersion`, a disabled or missing user).
- Produces:
  - `LIVE_CFG = 'live'`, `interface ILiveConfig { heartbeatMs: number; maxStreamsPerUser: number }`, `liveConfig`
  - `export const kodaTokenExtractor: (req: unknown) => string | null` from `src/auth/auth.module.ts`
  - `decodeJwtPayload(token: string | null): Record<string, unknown> | null`, `tokenExpiryMs(payload: Record<string, unknown>): number | null`
  - `class LiveStreamRegistry { tryAcquire(userId: string, limit: number): boolean; release(userId: string): void; activeFor(userId: string): number }`
  - `interface LiveStreamOptions { projectId: string; heartbeatMs: number; expiresAtMs: number | null; now: () => number; subscribe: (projectId: string, listener: (event: LiveEvent) => void) => () => void; stillAllowed: () => Promise<boolean>; onClose: () => void }`
  - `createLiveStream(options: LiveStreamOptions): Observable<MessageEvent>`
  - SSE events: `ready` (data `{}`), `ping` (data `{}`), `ticket` (data `LiveEvent`, SSE `id` = `LiveEvent.id`)

- [ ] **Step 1: Write the failing config test**

`apps/api/src/config/live.config.spec.ts`:

```ts
import { liveConfig } from './live.config';

describe('liveConfig', () => {
  const saved = process.env['LIVE_HEARTBEAT_MS'];

  afterEach(() => {
    if (saved === undefined) delete process.env['LIVE_HEARTBEAT_MS'];
    else process.env['LIVE_HEARTBEAT_MS'] = saved;
  });

  it('defaults to a 25 s heartbeat and 5 streams per user', () => {
    delete process.env['LIVE_HEARTBEAT_MS'];
    expect(liveConfig()).toEqual({ heartbeatMs: 25000, maxStreamsPerUser: 5 });
  });

  it('reads LIVE_HEARTBEAT_MS', () => {
    process.env['LIVE_HEARTBEAT_MS'] = '300';
    expect(liveConfig().heartbeatMs).toBe(300);
  });

  it('never goes below 100 ms', () => {
    process.env['LIVE_HEARTBEAT_MS'] = '5';
    expect(liveConfig().heartbeatMs).toBe(100);
  });

  it('rejects a non-numeric value', () => {
    process.env['LIVE_HEARTBEAT_MS'] = '25s';
    expect(() => liveConfig()).toThrow();
  });
});
```

Also add inside `describe('env validation', …)` in `apps/api/src/config/env.validation.spec.ts` (it already defines `REQUIRED`):

```ts
  it('rejects LIVE_HEARTBEAT_MS below 100 and accepts 100', () => {
    expect(() => validate({ ...REQUIRED, LIVE_HEARTBEAT_MS: '99' })).toThrow();
    expect(() => validate({ ...REQUIRED, LIVE_HEARTBEAT_MS: '100' })).not.toThrow();
  });
```

- [ ] **Step 2: Write the failing JWT payload and registry tests**

`apps/api/src/live/jwt-payload.spec.ts`:

```ts
import { decodeJwtPayload, tokenExpiryMs } from './jwt-payload';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: unknown): string => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

describe('decodeJwtPayload', () => {
  it('decodes the payload segment', () => {
    expect(decodeJwtPayload(token({ sub: 'u1', exp: 1700000000 }))).toEqual({ sub: 'u1', exp: 1700000000 });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['two segments', 'a.b'],
    ['a non-JSON payload', 'a.bm90LWpzb24.c'],
    ['an array payload', token([1, 2])],
    ['a primitive payload', token(42)],
  ])('returns null for %s', (_label, value) => {
    expect(decodeJwtPayload(value as string | null)).toBeNull();
  });
});

describe('tokenExpiryMs', () => {
  it('converts exp seconds to milliseconds', () => {
    expect(tokenExpiryMs({ exp: 1700000000 })).toBe(1700000000000);
  });

  it('returns null without a numeric exp', () => {
    expect(tokenExpiryMs({})).toBeNull();
    expect(tokenExpiryMs({ exp: '1700000000' })).toBeNull();
  });
});
```

`apps/api/src/live/live-stream-registry.spec.ts`:

```ts
import { LiveStreamRegistry } from './live-stream-registry';

describe('LiveStreamRegistry', () => {
  it('admits up to the limit per user and refuses the next', () => {
    const registry = new LiveStreamRegistry();
    for (let i = 0; i < 5; i += 1) expect(registry.tryAcquire('u1', 5)).toBe(true);
    expect(registry.tryAcquire('u1', 5)).toBe(false);
    expect(registry.activeFor('u1')).toBe(5);
  });

  it('counts users independently', () => {
    const registry = new LiveStreamRegistry();
    for (let i = 0; i < 5; i += 1) registry.tryAcquire('u1', 5);
    expect(registry.tryAcquire('u2', 5)).toBe(true);
  });

  it('release frees a slot and never goes below zero', () => {
    const registry = new LiveStreamRegistry();
    for (let i = 0; i < 5; i += 1) registry.tryAcquire('u1', 5);
    registry.release('u1');
    expect(registry.tryAcquire('u1', 5)).toBe(true);
    registry.release('ghost');
    registry.release('ghost');
    expect(registry.activeFor('ghost')).toBe(0);
  });
});
```

- [ ] **Step 3: Write the failing stream test**

`apps/api/src/live/live-stream.spec.ts`:

```ts
import type { MessageEvent } from '@nestjs/common';
import { createLiveStream, LiveStreamOptions } from './live-stream';
import type { LiveEvent } from './live-event';

const liveEvent: LiveEvent = {
  id: 'evt-1', type: 'ticket', action: 'transitioned', projectId: 'p1', ticketId: 't1', actorId: 'u1', at: '2026-09-26T00:00:00.000Z',
};

function setup(overrides: Partial<LiveStreamOptions> = {}) {
  let listener: ((event: LiveEvent) => void) | null = null;
  const unsubscribe = jest.fn();
  const options: LiveStreamOptions = {
    projectId: 'p1',
    heartbeatMs: 1000,
    expiresAtMs: null,
    now: () => 0,
    subscribe: jest.fn((_projectId, l) => {
      listener = l;
      return unsubscribe;
    }),
    stillAllowed: jest.fn().mockResolvedValue(true),
    onClose: jest.fn(),
    ...overrides,
  };
  const messages: MessageEvent[] = [];
  let completed = false;
  const subscription = createLiveStream(options).subscribe({
    next: (m) => messages.push(m),
    complete: () => {
      completed = true;
    },
  });
  return {
    options,
    messages,
    unsubscribe,
    subscription,
    emit: (event: LiveEvent) => listener?.(event),
    isCompleted: () => completed,
  };
}

describe('createLiveStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends ready first, then subscribes to the project', () => {
    const s = setup();
    expect(s.messages[0]).toEqual({ type: 'ready', data: {} });
    expect(s.options.subscribe).toHaveBeenCalledWith('p1', expect.any(Function));
    s.subscription.unsubscribe();
  });

  it('forwards bus events as named ticket events carrying the event id', () => {
    const s = setup();
    s.emit(liveEvent);
    expect(s.messages[1]).toEqual({ type: 'ticket', id: 'evt-1', data: liveEvent });
    s.subscription.unsubscribe();
  });

  it('pings on each heartbeat while access holds', async () => {
    const s = setup();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.messages.filter((m) => m.type === 'ping')).toHaveLength(2);
    expect(s.options.stillAllowed).toHaveBeenCalledTimes(2);
    s.subscription.unsubscribe();
  });

  it('completes on the first heartbeat that loses access, and pings no more', async () => {
    const stillAllowed = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const s = setup({ stillAllowed });
    await jest.advanceTimersByTimeAsync(2000);
    expect(s.isCompleted()).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(s.messages.filter((m) => m.type === 'ping')).toHaveLength(1);
  });

  it('treats a failing access check as lost access', async () => {
    const s = setup({ stillAllowed: jest.fn().mockRejectedValue(new Error('db down')) });
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.isCompleted()).toBe(true);
  });

  it('completes at token expiry', async () => {
    const s = setup({ expiresAtMs: 1500, now: () => 0, heartbeatMs: 60_000 });
    await jest.advanceTimersByTimeAsync(1499);
    expect(s.isCompleted()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(s.isCompleted()).toBe(true);
  });

  it('completes right after ready when the token is already expired', async () => {
    const s = setup({ expiresAtMs: 10, now: () => 20 });
    await jest.advanceTimersByTimeAsync(0);
    expect(s.messages[0].type).toBe('ready');
    expect(s.isCompleted()).toBe(true);
  });

  it('tears down exactly once on client close: bus unsubscribed, timers cleared, onClose called', async () => {
    const s = setup();
    s.subscription.unsubscribe();
    s.subscription.unsubscribe();
    await jest.advanceTimersByTimeAsync(5000);
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.options.onClose).toHaveBeenCalledTimes(1);
    expect(s.options.stillAllowed).not.toHaveBeenCalled();
  });

  it('tears down exactly once when the server closes the stream', async () => {
    const s = setup({ stillAllowed: jest.fn().mockResolvedValue(false) });
    await jest.advanceTimersByTimeAsync(1000);
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.options.onClose).toHaveBeenCalledTimes(1);
  });

  it('skips a heartbeat while the previous access check is still running', async () => {
    let resolveCheck: (value: boolean) => void = () => undefined;
    const stillAllowed = jest.fn(() => new Promise<boolean>((resolve) => { resolveCheck = resolve; }));
    const s = setup({ stillAllowed });
    await jest.advanceTimersByTimeAsync(3000);
    expect(stillAllowed).toHaveBeenCalledTimes(1);
    resolveCheck(true);
    s.subscription.unsubscribe();
  });
});
```

`jest.advanceTimersByTimeAsync` needs Jest 29.5 or later. Check with `cd apps/api && bunx jest --version`. If it is older, replace each `await jest.advanceTimersByTimeAsync(n)` with `jest.advanceTimersByTime(n); await Promise.resolve(); await Promise.resolve();`.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd apps/api && bunx jest src/config/live.config.spec.ts src/config/env.validation.spec.ts src/live`
Expected: FAIL with "Cannot find module" for `./live.config`, `./jwt-payload`, `./live-stream-registry`, `./live-stream`; the env-validation test FAILS (the rule does not exist yet, so `'99'` is accepted).

- [ ] **Step 5: Implement the config**

`apps/api/src/config/live.config.ts`:

```ts
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const LIVE_CFG = 'live';
export const DEFAULT_LIVE_HEARTBEAT_MS = 25_000;
export const MIN_LIVE_HEARTBEAT_MS = 100;
export const MAX_LIVE_STREAMS_PER_USER = 5;

export interface ILiveConfig {
  heartbeatMs: number;
  maxStreamsPerUser: number;
}

export class LiveConfigSchema {
  // Digits-only to match the Joi `LIVE_HEARTBEAT_MS` rule in env.validation.ts.
  @IsOptional()
  @Matches(/^\d+$/)
  LIVE_HEARTBEAT_MS?: string;
}

/**
 * Track 1 Slice 5 SSE settings. The heartbeat both keeps the stream alive and
 * paces access re-validation; tests shorten it to observe revocation quickly.
 */
export const liveConfig = registerAs(LIVE_CFG, (): ILiveConfig => {
  validateUtil(process.env, LiveConfigSchema);
  const raw = process.env['LIVE_HEARTBEAT_MS'];
  const parsed = raw !== undefined ? parseInt(raw, 10) : DEFAULT_LIVE_HEARTBEAT_MS;
  return {
    heartbeatMs: Math.max(MIN_LIVE_HEARTBEAT_MS, parsed),
    maxStreamsPerUser: MAX_LIVE_STREAMS_PER_USER,
  };
});
```

In `apps/api/src/config/env.validation.ts`, add next to the outbox rules:

```ts
  LIVE_HEARTBEAT_MS: Joi.number()
    .integer()
    .min(100)
    .optional(),
```

In `apps/api/src/config/config-bridge.module.ts`, add `import { LIVE_CFG, ILiveConfig } from './live.config';`, a provider

```ts
    {
      provide: LIVE_CFG,
      useFactory: (cs: ConfigService) => {
        const cfg = cs.get<ILiveConfig>('live');
        if (!cfg) throw new Error('ConfigBridgeModule: live config not loaded — ensure liveConfig is in ConfigModule.forRoot load array');
        return cfg;
      },
      inject: [ConfigService],
    },
```

and add `LIVE_CFG` to `exports`. In `apps/api/src/app.module.ts` import `liveConfig` from `./config/live.config` and append it to the `ConfigModule.forRoot` `load` array.

In `apps/api/src/common/test-helpers/global-stubs.module.ts` add `import { LIVE_CFG, ILiveConfig } from '../../config/live.config';`, `export const mockLiveConfig: ILiveConfig = { heartbeatMs: 25000, maxStreamsPerUser: 5 };`, the provider `{ provide: LIVE_CFG, useValue: mockLiveConfig }` and `LIVE_CFG` in `exports`.

In `apps/api/.env.example`, after the outbox variables, add:

```
# Live updates (SSE): heartbeat and access re-check interval in ms (min 100)
LIVE_HEARTBEAT_MS=25000
```

- [ ] **Step 6: Implement `jwt-payload.ts` and `live-stream-registry.ts`**

`apps/api/src/live/jwt-payload.ts`:

```ts
/**
 * Reads claims from a JWT the auth guard has ALREADY verified. This does not
 * verify signatures and must never be used to authenticate.
 */
export function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function tokenExpiryMs(payload: Record<string, unknown>): number | null {
  const exp = payload['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}
```

`apps/api/src/live/live-stream-registry.ts`:

```ts
import { Injectable } from '@nestjs/common';

/** Per-user count of open live streams (single API instance, in memory). */
@Injectable()
export class LiveStreamRegistry {
  private counts: ReadonlyMap<string, number> = new Map();

  tryAcquire(userId: string, limit: number): boolean {
    const current = this.activeFor(userId);
    if (current >= limit) return false;
    this.counts = new Map([...this.counts, [userId, current + 1]]);
    return true;
  }

  release(userId: string): void {
    const current = this.activeFor(userId);
    const next = new Map(this.counts);
    if (current <= 1) next.delete(userId);
    else next.set(userId, current - 1);
    this.counts = next;
  }

  activeFor(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }
}
```

- [ ] **Step 7: Implement `live-stream.ts`**

```ts
import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { LiveEvent } from './live-event';

export interface LiveStreamOptions {
  projectId: string;
  heartbeatMs: number;
  expiresAtMs: number | null;
  now: () => number;
  subscribe: (projectId: string, listener: (event: LiveEvent) => void) => () => void;
  stillAllowed: () => Promise<boolean>;
  onClose: () => void;
}

/**
 * One member's live stream. Sends `ready` at once (Nest writes no response
 * headers until the first message), forwards bus events as `ticket` events,
 * re-checks access on every heartbeat (`ping` when it holds), and completes on
 * lost access or token expiry. Teardown runs once, on client close or
 * completion.
 */
export function createLiveStream(options: LiveStreamOptions): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let done = false;
    let checking = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      subscriber.complete();
    };

    subscriber.next({ type: 'ready', data: {} });
    const unsubscribe = options.subscribe(options.projectId, (event) => {
      if (!done) subscriber.next({ type: event.type, id: event.id, data: event });
    });

    const heartbeat = setInterval(() => {
      if (done || checking) return;
      checking = true;
      options
        .stillAllowed()
        .catch(() => false)
        .then((allowed) => {
          checking = false;
          if (done) return;
          if (allowed) subscriber.next({ type: 'ping', data: {} });
          else finish();
        });
    }, options.heartbeatMs);

    const expiry = options.expiresAtMs === null ? null : setTimeout(finish, Math.max(0, options.expiresAtMs - options.now()));

    return () => {
      done = true;
      clearInterval(heartbeat);
      if (expiry !== null) clearTimeout(expiry);
      unsubscribe();
      options.onClose();
    };
  });
}
```

(RxJS runs the teardown function once, whether the subscriber unsubscribes or the Observable completes, so `onClose` and the bus unsubscribe run exactly once.)

- [ ] **Step 8: Run the unit tests to verify they pass**

Run: `cd apps/api && bunx jest src/config/live.config.spec.ts src/config/env.validation.spec.ts src/live`
Expected: PASS.

- [ ] **Step 9: Write the failing controller test**

`apps/api/src/live/live.controller.spec.ts`:

```ts
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { firstValueFrom, take, toArray } from 'rxjs';
import type { ProjectAccessService } from '../projects/project-access.service';
import type { JwtAuthProvider } from '../auth/jwt-auth.provider';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { LiveController } from './live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwtFor = (payload: Record<string, unknown>): string => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

const user: KodaPrincipal = {
  actorType: 'user', id: 'u1', sub: 'u1', role: 'MEMBER', email: 'u1@koda.test',
  name: 'u1', blacklisted: false, revoked: false, authorities: [],
};
const agent: KodaPrincipal = {
  actorType: 'agent', id: 'a1', sub: 'a1', slug: 'bot', status: 'ACTIVE', agentRoles: [], capabilities: [],
  name: 'bot', blacklisted: false, revoked: false, authorities: [],
};

function setup(overrides: { membership?: jest.Mock; revoked?: boolean } = {}) {
  const access = {
    findProjectIdBySlug: jest.fn().mockResolvedValue('p1'),
    assertProjectMembership: overrides.membership ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as ProjectAccessService;
  const jwtAuth = {
    getPrincipal: jest.fn().mockResolvedValue({ ...user, revoked: overrides.revoked ?? false }),
  } as unknown as JwtAuthProvider;
  const bus = new ProjectEventBus();
  const streams = new LiveStreamRegistry();
  const controller = new LiveController(access, bus, streams, jwtAuth, { heartbeatMs: 25000, maxStreamsPerUser: 5 });
  const req = { headers: { authorization: `Bearer ${jwtFor({ sub: 'u1', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 900 })}` } };
  return { controller, access, jwtAuth, bus, streams, req };
}

describe('LiveController', () => {
  it('refuses agent principals with 403', async () => {
    const { controller, req } = setup();
    await expect(controller.events('proj', agent, req)).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('propagates the membership refusal and takes no stream slot', async () => {
    const denied = jest.fn().mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    const { controller, streams, req } = setup({ membership: denied });
    await expect(controller.events('proj', user, req)).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(streams.activeFor('u1')).toBe(0);
  });

  it('refuses a 6th concurrent stream with 429', async () => {
    const { controller, streams, req } = setup();
    for (let i = 0; i < 5; i += 1) streams.tryAcquire('u1', 5);
    await expect(controller.events('proj', user, req)).rejects.toBeInstanceOf(ThrottleAppException);
  });

  it('streams ready then the project events, and releases the slot on close', async () => {
    const { controller, bus, streams, req } = setup();
    const stream = await controller.events('proj', user, req);
    expect(streams.activeFor('u1')).toBe(1);

    const firstTwo = firstValueFrom(stream.pipe(take(2), toArray()));
    bus.publish({ id: 'evt-1', type: 'ticket', action: 'created', projectId: 'p1', ticketId: 't1', actorId: 'u2', at: 'x' });
    const messages = await firstTwo;

    expect(messages.map((m) => m.type)).toEqual(['ready', 'ticket']);
    expect(streams.activeFor('u1')).toBe(0);
  });

  it('re-validates with the fresh principal: a revoked user loses access', async () => {
    jest.useFakeTimers();
    const { controller, jwtAuth, req } = setup({ revoked: true });
    const stream = await controller.events('proj', user, req);
    let completed = false;
    const sub = stream.subscribe({ complete: () => { completed = true; } });

    await jest.advanceTimersByTimeAsync(25000);

    expect(jwtAuth.getPrincipal).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1', tokenVersion: 0 }));
    expect(completed).toBe(true);
    sub.unsubscribe();
    jest.useRealTimers();
  });

  it('re-validates membership live: removal loses access', async () => {
    jest.useFakeTimers();
    const membership = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    const { controller, req } = setup({ membership });
    const stream = await controller.events('proj', user, req);
    let completed = false;
    const sub = stream.subscribe({ complete: () => { completed = true; } });

    await jest.advanceTimersByTimeAsync(25000);

    expect(completed).toBe(true);
    sub.unsubscribe();
    jest.useRealTimers();
  });

  it('skips the global throttler', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', LiveController.prototype.events)).toBe(true);
  });
});
```

(`THROTTLER:SKIP` is `THROTTLER_SKIP` in `@nestjs/throttler` 6.5 `throttler.constants.js`; `@SkipThrottle()` appends the throttler name, `default`.)

- [ ] **Step 10: Run the controller test to verify it fails**

Run: `cd apps/api && bunx jest src/live/live.controller.spec.ts`
Expected: FAIL with "Cannot find module './live.controller'".

- [ ] **Step 11: Export the token extractor and the JWT provider**

In `apps/api/src/auth/auth.module.ts`:
- change `const kodaTokenExtractor: JwtFromRequestFunction = (req: unknown): string | null => {` to `export const kodaTokenExtractor: JwtFromRequestFunction = (req: unknown): string | null => {`;
- add `JwtAuthProvider` to the `exports` array: `exports: [AuthService, CombinedAuthGuard, AgentAuthProvider, KodaCaslAbilityFactory, KodaJwtRefreshStrategyProvider, JwtAuthProvider],`.

- [ ] **Step 12: Implement the controller, i18n and module**

`apps/api/src/live/live.controller.ts`:

```ts
import { Controller, Inject, MessageEvent, Param, Req, Sse } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { ForbiddenAppException, ThrottleAppException } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { kodaTokenExtractor } from '../auth/auth.module';
import { JwtAuthProvider } from '../auth/jwt-auth.provider';
import { isUserPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { ILiveConfig, LIVE_CFG } from '../config/live.config';
import { ProjectAccessService } from '../projects/project-access.service';
import { decodeJwtPayload, tokenExpiryMs } from './jwt-payload';
import { createLiveStream } from './live-stream';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';

/**
 * Track 1 Slice 5: browser live updates for one project over SSE.
 * Browser-only (agents refused), so it is excluded from openapi.json.
 */
@ApiTags('live')
@Controller('projects/:slug/events')
export class LiveController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly bus: ProjectEventBus,
    private readonly streams: LiveStreamRegistry,
    private readonly jwtAuth: JwtAuthProvider,
    @Inject(LIVE_CFG) private readonly config: ILiveConfig,
  ) {}

  @Sse()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async events(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
    @Req() req: unknown,
  ): Promise<Observable<MessageEvent>> {
    if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'live');
    const projectId = await this.access.findProjectIdBySlug(slug);
    await this.access.assertProjectMembership(projectId, principal);
    const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
    if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
    if (!this.streams.tryAcquire(principal.id, this.config.maxStreamsPerUser)) {
      throw new ThrottleAppException({}, 'live');
    }
    return createLiveStream({
      projectId,
      heartbeatMs: this.config.heartbeatMs,
      expiresAtMs: tokenExpiryMs(jwtPayload),
      now: Date.now,
      subscribe: (id, listener) => this.bus.subscribe(id, listener),
      stillAllowed: () => this.stillAllowed(projectId, jwtPayload),
      onClose: () => this.streams.release(principal.id),
    });
  }

  /** tokenVersion and disabled via the 60 s auth-state cache; membership live. */
  private async stillAllowed(projectId: string, jwtPayload: Record<string, unknown>): Promise<boolean> {
    const fresh = await this.jwtAuth.getPrincipal(jwtPayload);
    if (fresh.revoked) return false;
    try {
      await this.access.assertProjectMembership(projectId, fresh);
      return true;
    } catch {
      return false;
    }
  }
}
```

`apps/api/src/i18n/en/live.json`:

```json
{
  "40003": "Live updates are available to signed-in project members only",
  "429": "Too many open live connections"
}
```

`apps/api/src/i18n/zh/live.json`:

```json
{
  "40003": "实时更新仅对已登录的项目成员开放",
  "429": "打开的实时连接过多"
}
```

Replace `apps/api/src/live/live.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectAccessModule } from '../projects/project-access.module';
import { LiveController } from './live.controller';
import { LiveStreamRegistry } from './live-stream-registry';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';

@Module({
  imports: [OutboxModule, AuthModule, ProjectAccessModule],
  controllers: [LiveController],
  providers: [ProjectEventBus, TicketLiveSubscriber, LiveStreamRegistry],
  exports: [ProjectEventBus],
})
export class LiveModule {}
```

`ProjectAccessModule` (`src/projects/project-access.module.ts`) exports `ProjectAccessService`; it is lighter than `ProjectsModule`, which drags RAG, code-intel and agents in.

Add to `apps/api/src/live/live.module.spec.ts`:

```ts
  it('resolves the controller and the stream registry', () => {
    expect(moduleRef.get(LiveController)).toBeInstanceOf(LiveController);
    expect(moduleRef.get(LiveStreamRegistry)).toBeInstanceOf(LiveStreamRegistry);
  });
```

with `import { LiveController } from './live.controller';` and `import { LiveStreamRegistry } from './live-stream-registry';`.

- [ ] **Step 13: Run the unit suite**

Run: `cd apps/api && bunx jest src/live src/config src/auth`
Expected: PASS.

Run: `cd apps/api && bun run test && bun run lint && bun run type-check`
Expected: all green with no database running.

Run from the repo root: `bun run generate && git status --short openapi.json apps/cli`
Expected: no change to `openapi.json` (the endpoint is excluded). If `openapi.json` changed, the `@ApiExcludeEndpoint()` is missing or ineffective; fix before committing.

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/config apps/api/src/common/test-helpers/global-stubs.module.ts apps/api/src/auth/auth.module.ts apps/api/src/live apps/api/src/i18n apps/api/src/app.module.ts apps/api/.env.example
git commit -m "feat(api): GET /projects/:slug/events SSE stream with heartbeat re-validation"
```

---

### Task 4: Live stream over HTTP on Postgres (integration)

**Files:**
- Create: `apps/api/test/helpers/sse-client.ts`
- Create: `apps/api/test/integration/live/live-stream.integration.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (the whole API side), `bootHttpApp`, `data`, `loginToken`, `TEST_PASSWORD` (`test/helpers/http-app.ts`), `resetDb` (`test/helpers/reset-db.ts`), `OutboxRelay` from `@nathapp/nestjs-outbox`, `LiveStreamRegistry`.
- Produces: `openSse(url: string, token: string): Promise<SseConnection>` with `interface SseMessage { event: string; id?: string; data: string }` and `interface SseConnection { status: number; body: string; next(predicate: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>; closed: Promise<void>; isClosed(): boolean; close(): void }`.

This task has no production code: it proves Tasks 1-3 end to end. If a test fails, fix the production code in the owning task's files, not the test.

- [ ] **Step 1: Write the SSE test client**

`apps/api/test/helpers/sse-client.ts`:

```ts
/**
 * Minimal streaming SSE reader for integration tests (supertest buffers the
 * whole response, which never ends for a live stream).
 */
export interface SseMessage {
  event: string;
  id?: string;
  data: string;
}

export interface SseConnection {
  status: number;
  body: string;
  next(predicate: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  closed: Promise<void>;
  isClosed(): boolean;
  close(): void;
}

interface Waiter {
  predicate: (m: SseMessage) => boolean;
  resolve: (m: SseMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseBlock(block: string): SseMessage | null {
  const fields = block.split('\n').reduce<Record<string, string>>((acc, line) => {
    const idx = line.indexOf(':');
    if (idx <= 0) return acc;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).replace(/^ /, '');
    return { ...acc, [key]: key === 'data' && acc['data'] !== undefined ? `${acc['data']}\n${value}` : value };
  }, {});
  if (fields['data'] === undefined && fields['event'] === undefined) return null;
  return { event: fields['event'] ?? 'message', id: fields['id'], data: fields['data'] ?? '' };
}

export async function openSse(url: string, token: string): Promise<SseConnection> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text();
    return {
      status: res.status,
      body,
      next: () => Promise.reject(new Error(`stream not open (${res.status})`)),
      closed: Promise.resolve(),
      isClosed: () => true,
      close: () => undefined,
    };
  }

  let inbox: SseMessage[] = [];
  let waiters: Waiter[] = [];
  let ended = false;

  const deliver = (message: SseMessage): void => {
    const waiter = waiters.find((w) => w.predicate(message));
    if (!waiter) {
      inbox = [...inbox, message];
      return;
    }
    clearTimeout(waiter.timer);
    waiters = waiters.filter((w) => w !== waiter);
    waiter.resolve(message);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const closed = (async (): Promise<void> => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const message = parseBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (message) deliver(message);
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted by close()
    } finally {
      ended = true;
      waiters.forEach((w) => {
        clearTimeout(w.timer);
        w.reject(new Error('stream closed'));
      });
      waiters = [];
    }
  })();

  return {
    status: res.status,
    body: '',
    next(predicate, timeoutMs = 3000) {
      const queued = inbox.find(predicate);
      if (queued) {
        inbox = inbox.filter((m) => m !== queued);
        return Promise.resolve(queued);
      }
      if (ended) return Promise.reject(new Error('stream closed'));
      return new Promise<SseMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w.timer !== timer);
          reject(new Error(`no matching SSE message within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters = [...waiters, { predicate, resolve, reject, timer }];
      });
    },
    closed,
    isClosed: () => ended,
    close: () => controller.abort(),
  };
}
```

- [ ] **Step 2: Write the integration test**

`apps/api/test/integration/live/live-stream.integration.spec.ts`:

```ts
/**
 * Slice 5 — GET /projects/:slug/events over real HTTP on Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/live
 */
import type { AddressInfo } from 'net';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { LiveStreamRegistry } from '../../../src/live/live-stream-registry';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { openSse, SseConnection, SseMessage } from '../../helpers/sse-client';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const HEARTBEAT_MS = 300;
const isTicket = (m: SseMessage): boolean => m.event === 'ticket';
const parsed = (m: SseMessage): Record<string, unknown> => JSON.parse(m.data) as Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(25);
  }
}

describeIntegration('GET /projects/:slug/events (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let baseUrl: string;
  let relay: OutboxRelay;
  let registry: LiveStreamRegistry;
  let prisma: PrismaClient;
  let openStreams: SseConnection[] = [];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  const stream = async (who: string, slug = 'live'): Promise<SseConnection> => {
    const conn = await openSse(`${baseUrl}/api/projects/${slug}/events`, tokens[who]);
    openStreams = [...openStreams, conn];
    return conn;
  };
  const dispatch = (): Promise<unknown> => relay.dispatchPendingBatch();

  beforeAll(async () => {
    await resetDb();
    const saved = process.env.LIVE_HEARTBEAT_MS;
    process.env.LIVE_HEARTBEAT_MS = String(HEARTBEAT_MS);
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      if (saved === undefined) delete process.env.LIVE_HEARTBEAT_MS;
      else process.env.LIVE_HEARTBEAT_MS = saved;
    }
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay = app.get(OutboxRelay);
    registry = app.get(LiveStreamRegistry);
    prisma = app.get(PrismaService).client as PrismaClient;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Live', slug: 'live', key: 'LIV' }).expect(201);
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Other', slug: 'other', key: 'OTH' }).expect(201);

    for (const who of ['dev', 'capper', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
    for (const who of ['dev', 'capper']) {
      await request(server).post('/api/projects/live/members').set(auth('root'))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' }).expect(201);
    }

    const agent = await request(server).post('/api/agents').set(auth('root'))
      .send({ name: 'Live Bot', slug: 'live-bot' }).expect(201);
    tokens.agent = data<{ apiKey: string }>(agent).apiKey;
  });

  afterEach(async () => {
    openStreams.forEach((conn) => conn.close());
    openStreams = [];
    await waitFor(() => registry.activeFor(ids.dev) === 0 && registry.activeFor(ids.capper) === 0);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a member gets ready, then created and transitioned events carrying the TicketEvent id', async () => {
    const conn = await stream('dev');
    expect(conn.status).toBe(200);
    await conn.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/live/tickets').set(auth('root')).send({ type: 'BUG', title: 'Live one' }).expect(201);
    await request(server).post('/api/projects/live/tickets/LIV-1/verify').set(auth('root')).send({ body: 'ok' }).expect(200);
    await dispatch();

    const created = parsed(await conn.next(isTicket));
    const transitioned = parsed(await conn.next(isTicket));
    expect(created).toEqual(expect.objectContaining({ type: 'ticket', action: 'created' }));
    expect(transitioned).toEqual(expect.objectContaining({ type: 'ticket', action: 'transitioned', ticketId: created.ticketId }));
    expect(created).not.toHaveProperty('title');

    const row = await prisma.ticketEvent.findFirst({ where: { action: 'status_changed', ticketId: String(created.ticketId) } });
    expect(transitioned.id).toBe(row?.id);
  });

  it('never delivers another project\'s events', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/other/tickets').set(auth('root')).send({ type: 'BUG', title: 'Elsewhere' }).expect(201);
    await dispatch();
    await request(server).post('/api/projects/live/tickets').set(auth('root')).send({ type: 'BUG', title: 'Here' }).expect(201);
    await dispatch();

    const first = parsed(await conn.next(isTicket));
    const liveProject = await prisma.project.findUnique({ where: { slug: 'live' } });
    expect(first.projectId).toBe(liveProject?.id);
  });

  it('a comment arrives as commented', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ready');

    await request(server).post('/api/projects/live/tickets/LIV-1/comments').set(auth('root'))
      .send({ body: 'hello live', type: 'GENERAL' }).expect(201);
    await dispatch();

    expect(parsed(await conn.next(isTicket))).toEqual(expect.objectContaining({ action: 'commented' }));
  });

  it('refuses a non-member (403), an agent (403) and no token (401)', async () => {
    expect((await stream('outsider')).status).toBe(403);
    expect((await stream('agent')).status).toBe(403);
    const anonymous = await fetch(`${baseUrl}/api/projects/live/events`);
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();
  });

  it('caps a user at 5 streams and frees a slot when one closes', async () => {
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => stream('capper')));
    await Promise.all(five.map((c) => c.next((m) => m.event === 'ready')));

    const sixth = await stream('capper');
    expect(sixth.status).toBe(429);

    five[0].close();
    await waitFor(() => registry.activeFor(ids.capper) === 4);
    const again = await stream('capper');
    expect(again.status).toBe(200);
  });

  it('pings on the heartbeat', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ping', HEARTBEAT_MS * 4);
  });

  it('removing the member closes their stream within one heartbeat', async () => {
    const conn = await stream('dev');
    await conn.next((m) => m.event === 'ready');

    await request(server).delete(`/api/projects/live/members/${ids.dev}`).set(auth('root')).expect(200);

    await Promise.race([conn.closed, sleep(HEARTBEAT_MS * 4)]);
    expect(conn.isClosed()).toBe(true);
    await waitFor(() => registry.activeFor(ids.dev) === 0);
  });
});
```

Notes for the implementer:
- Keep the removal test last: it takes `dev` out of the project.
- The member-removal endpoint's success status comes from Slice 4 (`ProjectMembersController`); if it is `204`, change `.expect(200)` to match the controller, not the other way round.
- `app.listen(0, '127.0.0.1')` on a `NathApplication` returns once the server is bound. If `NathApplication` lacks `listen`, call `await app.getHttpServer().listen(0, '127.0.0.1')` and wait for its `listening` event.
- `afterEach` closes every stream and waits for the registry to drain, so later tests start at zero. If that wait times out, client aborts are not reaching Nest's `socket.on('close')` path: investigate before loosening the test.

- [ ] **Step 3: Run the integration test**

Run: `cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/live`
Expected: PASS (7 tests). The first run may expose a wiring problem that unit tests could not (for example `JwtAuthProvider` not resolvable in `LiveModule`); fix it in the Task 3 files.

- [ ] **Step 4: Run the full API integration suite**

Run: `cd apps/api && bun run test:integration`
Expected: PASS, with the same test counts as `main` plus this slice's new tests (Slice 4 ended at 95 suites / 1600 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/helpers/sse-client.ts apps/api/test/integration/live
git commit -m "test(api): live stream end to end over HTTP on Postgres"
```

---

### Task 5: Web — abort-aware SSE proxy route

**Files:**
- Create: `apps/web/server/utils/live-proxy.ts`
- Create: `apps/web/server/api/projects/[slug]/events.get.ts`
- Create: `apps/web/tests/server/live-proxy.spec.ts`

**Interfaces:**
- Consumes: `resolveProxyTarget(path, { apiInternalUrl })` (`apps/web/server/utils/proxy-target.ts`).
- Produces:
  - `buildLiveUpstreamUrl(slug: string, apiInternalUrl: string): string | null`
  - `LIVE_STREAM_HEADERS: Readonly<Record<string, string>>`
  - `interface LiveProxyRequest { slug: string; cookie: string | undefined; apiInternalUrl: string; onClientClose: (cb: () => void) => void; fetchImpl?: typeof fetch }`
  - `type LiveProxyResult = { kind: 'stream'; body: ReadableStream<Uint8Array> } | { kind: 'error'; status: number; body: string }`
  - `openLiveUpstream(req: LiveProxyRequest): Promise<LiveProxyResult>`
  - Browser URL: `GET /api/projects/:slug/events`

Why a dedicated route: the catch-all `server/api/[...].ts` uses h3 `proxyRequest`, which streams fine but passes no `AbortSignal` upstream, so a closed tab would keep its API stream (and one of the user's 5 slots) open. Nitro routes a more specific file ahead of the `[...]` catch-all, the same way `server/api/auth/*` already does.

Client-close detection uses the **response** `close` event. `IncomingMessage` `close` fires as soon as a bodiless GET request has been read (Node 16+), which would abort every stream immediately.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/server/live-proxy.spec.ts`:

```ts
import { describe, expect, jest, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildLiveUpstreamUrl, LIVE_STREAM_HEADERS, openLiveUpstream } from '~/server/utils/live-proxy'

const API = 'http://api:3100'

function streamResponse(): Response {
  return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('buildLiveUpstreamUrl', () => {
  test('targets the API events endpoint for a valid slug', () => {
    expect(buildLiveUpstreamUrl('my-project', API)).toBe('http://api:3100/api/projects/my-project/events')
  })

  test.each([
    ['a traversal attempt', '..%2F..%2Fadmin%2Fusers'],
    ['a decoded traversal', '../admin'],
    ['a nested path', 'a/b'],
    ['uppercase', 'Project'],
    ['a query injection', 'p?x=1'],
    ['empty', ''],
    ['a leading hyphen', '-p'],
  ])('rejects %s', (_label, slug) => {
    expect(buildLiveUpstreamUrl(slug, API)).toBeNull()
  })
})

describe('openLiveUpstream', () => {
  test('forwards the cookie and asks for an event stream', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => streamResponse())
    const result = await openLiveUpstream({
      slug: 'p1', cookie: 'koda_token=abc', apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.kind).toBe('stream')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://api:3100/api/projects/p1/events')
    expect(init?.headers).toEqual({ accept: 'text/event-stream', cookie: 'koda_token=abc' })
  })

  test('aborts the upstream request when the client goes away', async () => {
    let signal: AbortSignal | undefined
    let clientClosed: () => void = () => undefined
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return streamResponse()
    })
    await openLiveUpstream({
      slug: 'p1', cookie: undefined, apiInternalUrl: API,
      onClientClose: (cb) => { clientClosed = cb },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(signal?.aborted).toBe(false)
    clientClosed()
    expect(signal?.aborted).toBe(true)
  })

  test('passes an upstream refusal through with its status', async () => {
    const fetchImpl = jest.fn(async () => new Response('{"ret":40003}', { status: 403 }))
    const result = await openLiveUpstream({
      slug: 'p1', cookie: undefined, apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ kind: 'error', status: 403, body: '{"ret":40003}' })
  })

  test('maps an unreachable API to 502', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNREFUSED') })
    const result = await openLiveUpstream({
      slug: 'p1', cookie: undefined, apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 502 }))
  })

  test('rejects an invalid slug with 400 without calling the API', async () => {
    const fetchImpl = jest.fn(async () => streamResponse())
    const result = await openLiveUpstream({
      slug: '../admin', cookie: undefined, apiInternalUrl: API, onClientClose: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual(expect.objectContaining({ kind: 'error', status: 400 }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('LIVE_STREAM_HEADERS', () => {
  test('disables caching, transforms and proxy buffering', () => {
    expect(LIVE_STREAM_HEADERS).toEqual(expect.objectContaining({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    }))
  })
})

describe('events.get.ts route', () => {
  const source = readFileSync(path.join(__dirname, '../../server/api/projects/[slug]/events.get.ts'), 'utf-8')

  test('streams through openLiveUpstream with the live headers', () => {
    expect(source).toContain('openLiveUpstream')
    expect(source).toContain('sendStream')
    expect(source).toContain('LIVE_STREAM_HEADERS')
  })

  test('detects client disconnect on the response, not the request', () => {
    expect(source).toContain("node.res.on('close'")
    expect(source).not.toContain("node.req.on('close'")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/server/live-proxy.spec.ts`
Expected: FAIL with "Cannot find module '~/server/utils/live-proxy'".

- [ ] **Step 3: Implement the helper**

`apps/web/server/utils/live-proxy.ts`:

```ts
/**
 * Track 1 Slice 5: the live (SSE) proxy core. Kept free of Nitro auto-import
 * globals so unit tests can import it directly.
 *
 * Unlike the catch-all proxyRequest, this aborts the upstream request when the
 * browser goes away, so a closed tab releases its API stream (and the user's
 * per-user stream slot) at once.
 */
import { resolveProxyTarget } from './proxy-target'

// Same rule as the API's CreateProjectDto slug.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const LIVE_STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
})

export interface LiveProxyRequest {
  slug: string
  cookie: string | undefined
  apiInternalUrl: string
  onClientClose: (cb: () => void) => void
  fetchImpl?: typeof fetch
}

export type LiveProxyResult =
  | { kind: 'stream'; body: ReadableStream<Uint8Array> }
  | { kind: 'error'; status: number; body: string }

export function buildLiveUpstreamUrl(slug: string, apiInternalUrl: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return null
  return resolveProxyTarget(`/projects/${slug}/events`, { apiInternalUrl })
}

export async function openLiveUpstream(req: LiveProxyRequest): Promise<LiveProxyResult> {
  const url = buildLiveUpstreamUrl(req.slug, req.apiInternalUrl)
  if (!url) return { kind: 'error', status: 400, body: 'invalid project slug' }

  const controller = new AbortController()
  req.onClientClose(() => controller.abort())
  const headers: Record<string, string> = req.cookie
    ? { accept: 'text/event-stream', cookie: req.cookie }
    : { accept: 'text/event-stream' }

  let upstream: Response
  try {
    upstream = await (req.fetchImpl ?? fetch)(url, { headers, signal: controller.signal })
  }
  catch {
    return { kind: 'error', status: 502, body: 'live upstream unavailable' }
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '')
    return { kind: 'error', status: upstream.ok ? 502 : upstream.status, body }
  }
  return { kind: 'stream', body: upstream.body }
}
```

- [ ] **Step 4: Implement the route**

`apps/web/server/api/projects/[slug]/events.get.ts`:

```ts
/**
 * Track 1 Slice 5: browser live-updates stream for one project. More specific
 * than server/api/[...].ts, so Nitro routes it here instead of proxyRequest.
 * A non-200 upstream answer is passed through with its status, which makes the
 * browser EventSource stop (readyState CLOSED) instead of retrying blindly.
 */
import { LIVE_STREAM_HEADERS, openLiveUpstream } from '../../../utils/live-proxy'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const result = await openLiveUpstream({
    slug: getRouterParam(event, 'slug') ?? '',
    cookie: getRequestHeader(event, 'cookie'),
    apiInternalUrl: String(config.apiInternalUrl ?? ''),
    // Response 'close' = the browser connection went away. Request 'close'
    // fires as soon as a bodiless GET has been read, so it must not be used.
    onClientClose: cb => event.node.res.on('close', cb),
  })
  if (result.kind === 'error') {
    setResponseStatus(event, result.status)
    return result.body
  }
  setResponseHeaders(event, { ...LIVE_STREAM_HEADERS })
  return sendStream(event, result.body)
})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/server`
Expected: PASS (the existing `api-proxy.spec.ts` and `forward-to-api.spec.ts` included).

Run: `cd apps/web && bun run type-check`
Expected: no errors.

- [ ] **Step 6: Check streaming through the real proxy by hand**

With Postgres up (`cd apps/api && bun run test:db:up`), a local API on its usual dev port and `cd apps/web && bunx nuxt dev`, log in in a browser, open a project board, then in DevTools → Network, select the `events` request: it stays pending with type `eventsource`, and the EventStream tab shows `ready` then a `ping` every 25 s. Close the tab and confirm in the API log that no error is thrown. (Automated proof comes in Task 9.) Record the outcome in the commit message body if anything deviates.

- [ ] **Step 7: Commit**

```bash
git add apps/web/server/utils/live-proxy.ts "apps/web/server/api/projects/[slug]/events.get.ts" apps/web/tests/server/live-proxy.spec.ts
git commit -m "feat(web): abort-aware SSE proxy route for project live events"
```

---

### Task 6: Web — `EventSource` client core and `useProjectEvents`

**Files:**
- Create: `apps/web/lib/project-event-stream.ts`
- Create: `apps/web/composables/useProjectEvents.ts`
- Create: `apps/web/tests/lib/project-event-stream.spec.ts`
- Create: `apps/web/tests/composables/useProjectEvents.spec.ts`

**Interfaces:**
- Consumes: the SSE wire format from Task 3 (`ticket` events whose `data` is a `LiveEvent` JSON), the route from Task 5, `useAuth().refresh(): Promise<boolean>` (`composables/useAuth.ts`).
- Produces:
  - `type LiveAction = 'created' | 'updated' | 'transitioned' | 'assigned' | 'commented' | 'deleted'`
  - `interface LiveTicketEvent { id: string; type: 'ticket'; action: LiveAction; projectId: string; ticketId: string; actorId: string; at: string }`
  - `interface ProjectEventHandlers { onEvent: (event: LiveTicketEvent) => void; onResync: () => void }`
  - `createProjectEventStream(url: string, handlers: ProjectEventHandlers, deps: ProjectEventStreamDeps): { close(): void }`
  - `useProjectEvents(slug: string, handlers: ProjectEventHandlers): void` (client-only; opens on mount, closes on unmount)

- [ ] **Step 1: Write the failing core test**

`apps/web/tests/lib/project-event-stream.spec.ts`:

```ts
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import {
  backoffMs,
  createProjectEventStream,
  EVENT_SOURCE_CLOSED,
  MAX_TERMINAL_FAILURES,
  type EventSourceLike,
  type LiveTicketEvent,
  type ProjectEventStreamDeps,
} from '~/lib/project-event-stream'

class FakeEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  private listeners: Record<string, Array<(ev: { data: string }) => void>> = {}

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners = { ...this.listeners, [type]: [...(this.listeners[type] ?? []), listener] }
  }

  close(): void {
    this.closed = true
    this.readyState = EVENT_SOURCE_CLOSED
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) })
  }

  transientError(): void {
    this.readyState = 0
    this.onerror?.({})
  }

  terminalError(): void {
    this.readyState = EVENT_SOURCE_CLOSED
    this.onerror?.({})
  }
}

const liveEvent = (id: string, action: LiveTicketEvent['action'] = 'created'): LiveTicketEvent => ({
  id, type: 'ticket', action, projectId: 'p1', ticketId: 't1', actorId: 'u1', at: '2026-09-26T00:00:00.000Z',
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function setup(refreshResults: boolean[] = []) {
  const sources: FakeEventSource[] = []
  let timers: Array<{ fn: () => void; ms: number }> = []
  const refreshQueue = [...refreshResults]
  const deps: ProjectEventStreamDeps = {
    createEventSource: (url) => {
      const es = new FakeEventSource(url)
      sources.push(es)
      return es
    },
    refreshAuth: jest.fn(async () => refreshQueue.shift() ?? true),
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers = [...timers, timer]
      return timer
    },
    clearTimer: (handle) => {
      timers = timers.filter(t => t !== handle)
    },
  }
  const onEvent = jest.fn()
  const onResync = jest.fn()
  const stream = createProjectEventStream('/api/projects/p1/events', { onEvent, onResync }, deps)
  const runTimers = (): number[] => {
    const due = timers
    timers = []
    due.forEach(t => t.fn())
    return due.map(t => t.ms)
  }
  return { sources, deps, onEvent, onResync, stream, runTimers, latest: () => sources[sources.length - 1] }
}

describe('backoffMs', () => {
  test('doubles from 1 s and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('createProjectEventStream', () => {
  let s: ReturnType<typeof setup>

  beforeEach(() => {
    s = setup()
  })

  test('opens the given URL and delivers ticket events', () => {
    expect(s.latest().url).toBe('/api/projects/p1/events')
    s.latest().open()
    s.latest().emit('ticket', liveEvent('e1'))
    expect(s.onEvent).toHaveBeenCalledWith(liveEvent('e1'))
  })

  test('drops duplicate ids (outbox re-delivery)', () => {
    s.latest().open()
    s.latest().emit('ticket', liveEvent('e1'))
    s.latest().emit('ticket', liveEvent('e1'))
    expect(s.onEvent).toHaveBeenCalledTimes(1)
  })

  test('forgets ids beyond the 200-entry window', () => {
    s.latest().open()
    for (let i = 0; i <= 200; i += 1) s.latest().emit('ticket', liveEvent(`e${i}`))
    s.latest().emit('ticket', liveEvent('e0'))
    expect(s.onEvent).toHaveBeenCalledTimes(202)
  })

  test('ignores malformed payloads and ready/ping events', () => {
    s.latest().open()
    s.latest().emit('ticket', { id: 'x', type: 'ticket', action: 'exploded' })
    s.latest().emit('ticket', 'not an object')
    s.latest().emit('ready', {})
    s.latest().emit('ping', {})
    expect(s.onEvent).not.toHaveBeenCalled()
  })

  test('does not resync on the first open', () => {
    s.latest().open()
    expect(s.onResync).not.toHaveBeenCalled()
  })

  test('resyncs once when the browser reopens after a transient error', () => {
    s.latest().open()
    s.latest().transientError()
    s.latest().open()
    expect(s.onResync).toHaveBeenCalledTimes(1)
    expect(s.sources).toHaveLength(1)
  })

  test('after a terminal failure it refreshes auth, waits the backoff, reopens and resyncs', async () => {
    s.latest().open()
    s.latest().terminalError()
    await flush()
    expect(s.deps.refreshAuth).toHaveBeenCalledTimes(1)
    expect(s.sources[0].closed).toBe(true)

    expect(s.runTimers()).toEqual([1000])
    expect(s.sources).toHaveLength(2)
    s.latest().open()
    expect(s.onResync).toHaveBeenCalledTimes(1)
  })

  test('backs off 1 s, 2 s, 4 s … across consecutive terminal failures', async () => {
    const delays: number[] = []
    for (let i = 0; i < 3; i += 1) {
      s.latest().terminalError()
      await flush()
      delays.push(...s.runTimers())
    }
    expect(delays).toEqual([1000, 2000, 4000])
  })

  test(`stops after ${MAX_TERMINAL_FAILURES} consecutive terminal failures`, async () => {
    for (let i = 0; i < MAX_TERMINAL_FAILURES; i += 1) {
      s.latest().terminalError()
      await flush()
      s.runTimers()
    }
    const opened = s.sources.length
    s.latest().terminalError()
    await flush()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(opened)
  })

  test('a successful open resets the failure count', async () => {
    for (let i = 0; i < MAX_TERMINAL_FAILURES - 1; i += 1) {
      s.latest().terminalError()
      await flush()
      s.runTimers()
    }
    s.latest().open()
    s.latest().terminalError()
    await flush()
    expect(s.runTimers()).toEqual([1000])
  })

  test('stops at once when the auth refresh fails', async () => {
    const failing = setup([false])
    failing.latest().terminalError()
    await flush()
    expect(failing.runTimers()).toEqual([])
    expect(failing.sources).toHaveLength(1)
  })

  test('close() stops everything, including a pending reopen', async () => {
    s.latest().terminalError()
    await flush()
    s.stream.close()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
  })

  test('close() during an in-flight auth refresh prevents the reopen', async () => {
    let resolveRefresh: (ok: boolean) => void = () => undefined
    ;(s.deps.refreshAuth as jest.Mock).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveRefresh = resolve }))
    s.latest().terminalError()
    s.stream.close()
    resolveRefresh(true)
    await flush()
    expect(s.runTimers()).toEqual([])
    expect(s.sources).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx jest tests/lib/project-event-stream.spec.ts`
Expected: FAIL with "Cannot find module '~/lib/project-event-stream'".

- [ ] **Step 3: Implement the core**

`apps/web/lib/project-event-stream.ts`:

```ts
/**
 * Track 1 Slice 5: framework-free client for GET /api/projects/:slug/events.
 *
 * Transient drops: the browser EventSource reconnects by itself; the next
 * open fires onResync so pages refetch what they may have missed.
 * Terminal failures (readyState CLOSED, e.g. 401 after the access cookie
 * expired, 403, 429): refresh auth, then reopen with backoff. Give up after
 * MAX_TERMINAL_FAILURES in a row or when the refresh fails; the page keeps
 * working as a static page.
 */
export const LIVE_ACTIONS = ['created', 'updated', 'transitioned', 'assigned', 'commented', 'deleted'] as const
export type LiveAction = typeof LIVE_ACTIONS[number]

export interface LiveTicketEvent {
  id: string
  type: 'ticket'
  action: LiveAction
  projectId: string
  ticketId: string
  actorId: string
  at: string
}

export interface ProjectEventHandlers {
  onEvent: (event: LiveTicketEvent) => void
  onResync: () => void
}

export interface EventSourceLike {
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  addEventListener: (type: string, listener: (ev: { data: string }) => void) => void
  close: () => void
}

export interface ProjectEventStreamDeps {
  createEventSource: (url: string) => EventSourceLike
  refreshAuth: () => Promise<boolean>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export const EVENT_SOURCE_CLOSED = 2
export const MAX_TERMINAL_FAILURES = 5
export const BACKOFF_CAP_MS = 30_000
const DEDUPE_WINDOW = 200

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, BACKOFF_CAP_MS)
}

export function parseLiveEvent(raw: string): LiveTicketEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveTicketEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'ticket' || typeof value.id !== 'string' || typeof value.ticketId !== 'string') return null
    if (!LIVE_ACTIONS.includes(value.action as LiveAction)) return null
    return value as LiveTicketEvent
  }
  catch {
    return null
  }
}

export function createProjectEventStream(
  url: string,
  handlers: ProjectEventHandlers,
  deps: ProjectEventStreamDeps,
): { close: () => void } {
  let source: EventSourceLike | null = null
  let timer: unknown = null
  let stopped = false
  let hadError = false
  let failures = 0
  let seen: readonly string[] = []

  const isNew = (id: string): boolean => {
    if (seen.includes(id)) return false
    seen = [...seen, id].slice(-DEDUPE_WINDOW)
    return true
  }

  const recover = async (): Promise<void> => {
    if (failures >= MAX_TERMINAL_FAILURES) {
      stopped = true
      return
    }
    const delay = backoffMs(failures)
    failures += 1
    const ok = await deps.refreshAuth()
    if (stopped) return
    if (!ok) {
      stopped = true
      return
    }
    timer = deps.setTimer(() => {
      timer = null
      open()
    }, delay)
  }

  const open = (): void => {
    if (stopped) return
    const es = deps.createEventSource(url)
    source = es
    es.onopen = () => {
      failures = 0
      if (hadError) {
        hadError = false
        handlers.onResync()
      }
    }
    es.addEventListener('ticket', (ev) => {
      const event = parseLiveEvent(ev.data)
      if (event && isNew(event.id)) handlers.onEvent(event)
    })
    es.onerror = () => {
      hadError = true
      if (stopped || es.readyState !== EVENT_SOURCE_CLOSED) return
      es.close()
      source = null
      void recover()
    }
  }

  open()

  return {
    close: () => {
      stopped = true
      if (timer !== null) deps.clearTimer(timer)
      timer = null
      source?.close()
      source = null
    },
  }
}
```

- [ ] **Step 4: Run the core test to verify it passes**

Run: `cd apps/web && bunx jest tests/lib/project-event-stream.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the composable and its source-level test**

`apps/web/composables/useProjectEvents.ts`:

```ts
import { onBeforeUnmount, onMounted } from 'vue'
import {
  createProjectEventStream,
  type EventSourceLike,
  type ProjectEventHandlers,
} from '~/lib/project-event-stream'

/**
 * Live ticket updates for one project (Track 1 Slice 5). Client-only: opens
 * the stream on mount and closes it on unmount, so it never runs during SSR.
 */
export function useProjectEvents(slug: string, handlers: ProjectEventHandlers): void {
  const { refresh } = useAuth()
  let stream: { close: () => void } | null = null

  onMounted(() => {
    if (typeof EventSource === 'undefined') return
    stream = createProjectEventStream(`/api/projects/${encodeURIComponent(slug)}/events`, handlers, {
      createEventSource: url => new EventSource(url) as unknown as EventSourceLike,
      refreshAuth: refresh,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
  })

  onBeforeUnmount(() => {
    stream?.close()
    stream = null
  })
}
```

`apps/web/tests/composables/useProjectEvents.spec.ts` (the web Jest setup runs in a node environment without a Nuxt runtime; composables that call Nuxt auto-imports are pinned at source level, as `tests/pages/*` already do):

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(__dirname, '../../composables/useProjectEvents.ts'), 'utf-8')

describe('useProjectEvents', () => {
  test('opens the stream only on mount (never during SSR) and closes on unmount', () => {
    expect(source).toMatch(/onMounted\(\(\) => \{[\s\S]*createProjectEventStream/)
    expect(source).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*stream\?\.close\(\)/)
  })

  test('targets the proxied events route with an encoded slug', () => {
    expect(source).toContain('`/api/projects/${encodeURIComponent(slug)}/events`')
  })

  test('refreshes auth through useAuth, resolved during setup', () => {
    expect(source).toContain('const { refresh } = useAuth()')
    expect(source).toContain('refreshAuth: refresh')
  })

  test('guards environments without EventSource', () => {
    expect(source).toContain("typeof EventSource === 'undefined'")
  })
})
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && bunx jest tests/lib/project-event-stream.spec.ts tests/composables/useProjectEvents.spec.ts && bun run type-check`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/project-event-stream.ts apps/web/composables/useProjectEvents.ts apps/web/tests/lib/project-event-stream.spec.ts apps/web/tests/composables/useProjectEvents.spec.ts
git commit -m "feat(web): project live event stream client with dedupe, resync and auth-aware backoff"
```

---

### Task 7: Web — live board and ticket detail

**Files:**
- Create: `apps/web/lib/debounce.ts`, `apps/web/tests/lib/debounce.spec.ts`
- Modify: `apps/web/composables/useTicketBoardPages.ts`, `apps/web/tests/composables/useTicketBoardPages.spec.ts`
- Modify: `apps/web/pages/[project]/index.vue`
- Modify: `apps/web/pages/[project]/tickets/[ref].vue`
- Modify: `apps/web/components/TicketBoard.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Create: `apps/web/tests/i18n/live-locale-parity.spec.ts`
- Create: `apps/web/tests/pages/live-wiring.spec.ts`

**Interfaces:**
- Consumes: `useProjectEvents(slug, { onEvent, onResync })` and `LiveTicketEvent` (Task 6).
- Produces:
  - `createDebouncer(fn: () => void, ms: number): { trigger(): void; cancel(): void }`
  - `useTicketBoardPages(...)` additionally returns `reloadLoaded(): Promise<boolean>`
  - `data-testid="board-column-<STATUS>"` on each board column (used by Task 9)
  - `data-testid="ticket-deleted-notice"` on ticket detail (used by Task 9)
  - i18n key `tickets.live.deleted`

- [ ] **Step 1: Write the failing debounce and board-pages tests**

`apps/web/tests/lib/debounce.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { createDebouncer } from '~/lib/debounce'

describe('createDebouncer', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('runs once after the quiet period, however many triggers', () => {
    const fn = jest.fn()
    const d = createDebouncer(fn, 300)
    d.trigger()
    jest.advanceTimersByTime(200)
    d.trigger()
    jest.advanceTimersByTime(299)
    expect(fn).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('cancel drops a pending run', () => {
    const fn = jest.fn()
    const d = createDebouncer(fn, 300)
    d.trigger()
    d.cancel()
    jest.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})
```

Append to `apps/web/tests/composables/useTicketBoardPages.spec.ts`, inside `describe('useTicketBoardPages', …)` (it already defines `page()` and `deferred()`):

```ts
  test('reloadLoaded refetches every loaded page and keeps the extra pages', async () => {
    let version = 1
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], true))
    const fetchPage = jest.fn(async (current: number) =>
      current === 1 ? page(1, [`a${version}`], true) : page(2, [`b${version}`], false))
    const board = useTicketBoardPages(firstPage, fetchPage, jest.fn())
    await board.loadMoreTickets()
    expect(board.tickets.value.map(t => t.id)).toEqual(['a', 'b1'])

    version = 2
    await expect(board.reloadLoaded()).resolves.toBe(true)

    expect(fetchPage).toHaveBeenCalledWith(1)
    expect(board.tickets.value.map(t => t.id)).toEqual(['a2', 'b2'])
    expect(board.hasNext.value).toBe(false)
  })

  test('reloadLoaded with only the first page fetches page 1 only', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], false))
    const fetchPage = jest.fn(async (_current: number) => page(1, ['a-new'], false))
    const board = useTicketBoardPages(firstPage, fetchPage, jest.fn())

    await board.reloadLoaded()

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(board.tickets.value.map(t => t.id)).toEqual(['a-new'])
  })

  test('a failed reload keeps the current tickets and reports nothing', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], false))
    const reportError = jest.fn()
    const board = useTicketBoardPages(firstPage, async () => { throw new Error('offline') }, reportError)

    await expect(board.reloadLoaded()).resolves.toBe(false)

    expect(board.tickets.value.map(t => t.id)).toEqual(['a'])
    expect(reportError).not.toHaveBeenCalled()
  })

  test('an older reload that finishes last is discarded', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], false))
    const slow = deferred<TicketPage<Ticket>>()
    const fetchPage = jest.fn()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => page(1, ['newest'], false))
    const board = useTicketBoardPages(firstPage, fetchPage as (current: number) => Promise<TicketPage<Ticket>>, jest.fn())

    const older = board.reloadLoaded()
    await board.reloadLoaded()
    slow.resolve(page(1, ['stale'], false))
    await expect(older).resolves.toBe(false)

    expect(board.tickets.value.map(t => t.id)).toEqual(['newest'])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/debounce.spec.ts tests/composables/useTicketBoardPages.spec.ts`
Expected: FAIL ("Cannot find module '~/lib/debounce'"; `board.reloadLoaded is not a function`).

- [ ] **Step 3: Implement `createDebouncer` and `reloadLoaded`**

`apps/web/lib/debounce.ts`:

```ts
/** Trailing-edge debouncer: `fn` runs once, `ms` after the last trigger. */
export function createDebouncer(fn: () => void, ms: number): { trigger: () => void; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (handle !== null) clearTimeout(handle)
    handle = null
  }
  return {
    trigger: () => {
      cancel()
      handle = setTimeout(() => {
        handle = null
        fn()
      }, ms)
    },
    cancel,
  }
}
```

In `apps/web/composables/useTicketBoardPages.ts`, add below `loadMoreTickets`:

```ts
  let reloadGeneration = 0

  /**
   * Live refresh (Track 1 Slice 5): refetch page 1 and every page already
   * loaded, then swap them in together, so a live update neither collapses the
   * board back to page 1 nor flips useAsyncData's `pending` (which would show
   * the loading state). Failures are silent: the next event or resync retries.
   */
  async function reloadLoaded(): Promise<boolean> {
    reloadGeneration += 1
    const generation = reloadGeneration
    const loadedThrough = (lastPage.value ?? firstPage.value)?.current ?? 1
    try {
      const pages = await Promise.all(Array.from({ length: loadedThrough }, (_, i) => fetchPage(i + 1)))
      if (generation !== reloadGeneration) return false
      firstPage.value = pages[0]
      moreTickets.value = pages.slice(1).flatMap(p => p.records)
      lastPage.value = pages.length > 1 ? pages[pages.length - 1] : null
      return true
    }
    catch {
      return false
    }
  }

  return { tickets, hasNext, loadingMore, loadMoreTickets, reloadLoaded }
```

(and remove the old `return` line). Assigning `firstPage.value` runs the existing sync watcher, which clears the extra pages and bumps `firstPageGeneration`; the next two lines then put the refreshed extra pages back, and any in-flight `loadMoreTickets` is discarded by its generation check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && bunx jest tests/lib/debounce.spec.ts tests/composables/useTicketBoardPages.spec.ts`
Expected: PASS (existing tests included).

- [ ] **Step 5: Write the failing wiring and i18n tests**

`apps/web/tests/pages/live-wiring.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const board = read('pages', '[project]', 'index.vue')
const detail = read('pages', '[project]', 'tickets', '[ref].vue')
const ticketBoard = read('components', 'TicketBoard.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('board live wiring', () => {
  test('subscribes to project events and reloads loaded pages, debounced', () => {
    expect(board).toContain('useProjectEvents(slug')
    expect(board).toContain('reloadLoaded')
    expect(board).toContain('createDebouncer(')
  })

  test('ignores comments and never calls the pending-flipping refresh() from live handlers', () => {
    const handlers = liveHandlers(board)
    expect(handlers).toContain("'commented'")
    expect(handlers).not.toContain('refresh(')
  })

  test('cancels the pending reload on unmount', () => {
    expect(board).toMatch(/onBeforeUnmount\(\(\) => liveReload\.cancel\(\)\)/)
  })

  test('board columns carry a status test id', () => {
    expect(ticketBoard).toContain(':data-testid="`board-column-${status}`"')
  })
})

describe('ticket detail live wiring', () => {
  test('only reacts to events for the open ticket', () => {
    expect(liveHandlers(detail)).toContain('event.ticketId !== ticket.value.id')
  })

  test('updates the ticket in place instead of refresh() (keeps an open edit form)', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).not.toContain('refresh(')
    expect(detail).toMatch(/ticketData\.value = await/)
  })

  test('refreshes comments through the CommentThread cache key without touching the component', () => {
    expect(detail).toContain('useNuxtData(`comments-${slug}-${ref}`)')
  })

  test('shows a notice instead of refetching a deleted ticket', () => {
    expect(detail).toContain("event.action === 'deleted'")
    expect(detail).toContain('data-testid="ticket-deleted-notice"')
    expect(detail).toContain("t('tickets.live.deleted')")
  })
})
```

`apps/web/tests/i18n/live-locale-parity.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as { tickets: { live?: Record<string, string> } }
const zh = require('../../i18n/locales/zh.json') as { tickets: { live?: Record<string, string> } }

describe('Slice 5 locale parity (tickets.live)', () => {
  test('en and zh define the same non-empty keys', () => {
    expect(en.tickets.live).toBeDefined()
    expect(Object.keys(zh.tickets.live ?? {}).sort()).toEqual(Object.keys(en.tickets.live ?? {}).sort())
    for (const value of Object.values(zh.tickets.live ?? {})) expect(value.trim()).not.toBe('')
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/pages/live-wiring.spec.ts tests/i18n/live-locale-parity.spec.ts`
Expected: FAIL (no `useProjectEvents` in the pages, no test ids, no `tickets.live`).

- [ ] **Step 7: Wire the board**

In `apps/web/pages/[project]/index.vue` `<script setup>`:
- add `import { createDebouncer } from '~/lib/debounce'` with the other imports;
- destructure `reloadLoaded` from `useTicketBoardPages(...)`: `const { tickets, hasNext, loadingMore, loadMoreTickets, reloadLoaded } = useTicketBoardPages(`;
- after that call, add:

```ts
// Track 1 Slice 5: live updates. Comments do not change the board.
const LIVE_RELOAD_DEBOUNCE_MS = 300
const liveReload = createDebouncer(() => { void reloadLoaded() }, LIVE_RELOAD_DEBOUNCE_MS)
onBeforeUnmount(() => liveReload.cancel())

useProjectEvents(slug, {
  onEvent: (event) => {
    if (event.action !== 'commented') liveReload.trigger()
  },
  onResync: () => liveReload.trigger(),
})
```

(`onBeforeUnmount` and `useProjectEvents` are Nuxt auto-imports, like `useRoute` and `useApi` in this file.)

In `apps/web/components/TicketBoard.vue`, add this attribute to the column `div` that has `v-for="status in COLUMNS"`:

```vue
        :data-testid="`board-column-${status}`"
```

- [ ] **Step 8: Wire the ticket detail**

In `apps/web/pages/[project]/tickets/[ref].vue` `<script setup>`:
- add `import { createDebouncer } from '~/lib/debounce'` with the other imports;
- after the `const ticket = computed(...)` line, add:

```ts
// Track 1 Slice 5: live updates for the open ticket. Never refresh(): it flips
// `pending`, which swaps the page for LoadingState and unmounts an open edit form.
const LIVE_RELOAD_DEBOUNCE_MS = 300
const ticketDeleted = vueRef(false)
const { data: liveComments } = useNuxtData(`comments-${slug}-${ref}`)

async function reloadTicketSilently() {
  try {
    ticketData.value = await ($api.get(`/projects/${slug}/tickets/${ref}`) as Promise<Ticket>)
  }
  catch {
    // The next live event or a resync retries.
  }
}

async function reloadCommentsSilently() {
  try {
    liveComments.value = await $api.get(`/projects/${slug}/tickets/${ref}/comments`)
  }
  catch {
    // The next live event or a resync retries.
  }
}

const liveTicketReload = createDebouncer(() => { void reloadTicketSilently() }, LIVE_RELOAD_DEBOUNCE_MS)
onBeforeUnmount(() => liveTicketReload.cancel())

useProjectEvents(slug, {
  onEvent: (event) => {
    if (!ticket.value || event.ticketId !== ticket.value.id) return
    if (event.action === 'deleted') {
      ticketDeleted.value = true
      return
    }
    liveTicketReload.trigger()
    if (event.action === 'commented') void reloadCommentsSilently()
  },
  onResync: () => {
    if (ticketDeleted.value) return
    liveTicketReload.trigger()
    void reloadCommentsSilently()
  },
})
```

In the template, make the notice the first child of `<div class="md:col-span-2 space-y-6">`:

```vue
        <div
          v-if="ticketDeleted"
          role="status"
          data-testid="ticket-deleted-notice"
          class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {{ t('tickets.live.deleted') }}
        </div>
```

The page's own actions (`saveEdit`, `onTransition`) keep calling `refresh()`; the user's own action triggers a live event too, and the resulting second fetch is harmless.

- [ ] **Step 9: Add the i18n key**

In `apps/web/i18n/locales/en.json`, inside `"tickets": { … }`, add `"live": { "deleted": "This ticket was deleted." },`. In `apps/web/i18n/locales/zh.json`, inside `"tickets": { … }`, add `"live": { "deleted": "此工单已被删除。" },`. Keep both files valid JSON.

- [ ] **Step 10: Run the web suite**

Run: `cd apps/web && bunx jest tests/pages/live-wiring.spec.ts tests/i18n tests/composables tests/lib && bun run test && bun run type-check && bun run lint`
Expected: PASS. Existing source-level page tests (`tests/pages/project-board.spec.ts`, `ticket-detail.spec.ts`, `loading-states.spec.ts`) must stay green; if one asserts an exact destructuring such as `const { tickets, hasNext, loadingMore, loadMoreTickets }`, update that assertion to the new shape rather than dropping it.

- [ ] **Step 11: Commit**

```bash
git add apps/web/lib/debounce.ts apps/web/tests/lib/debounce.spec.ts apps/web/composables/useTicketBoardPages.ts apps/web/tests/composables/useTicketBoardPages.spec.ts "apps/web/pages/[project]/index.vue" "apps/web/pages/[project]/tickets/[ref].vue" apps/web/components/TicketBoard.vue apps/web/i18n/locales apps/web/tests/i18n/live-locale-parity.spec.ts apps/web/tests/pages/live-wiring.spec.ts
git commit -m "feat(web): live ticket board and detail via project event stream"
```

---

### Task 8: Repair the web e2e suite

**Files:**
- Create: `apps/web/tests/e2e/fixtures/session.ts`
- Modify: `apps/web/tests/e2e/fixtures/api-client.ts` (`login` uses the session cache)
- Modify: `apps/web/tests/e2e/fixtures/page-helpers.ts` (`webLogin` uses the session cache, gains `opts.fresh`)
- Modify: `apps/web/tests/e2e/auth.spec.ts` (logout test uses a fresh session and forgets it)
- Modify: `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` (no `networkidle` on the ticket detail page)
- Modify: `apps/web/playwright.config.ts` (`E2E_WEB_MODE=build`)
- Plus whatever the suite run in Step 6 shows is broken (test-side fixes only; see Step 6)

**Interfaces:**
- Produces:
  - `interface E2ESession { accessToken: string; refreshToken: string; userId: string; obtainedAt: number }`
  - `getSession(email: string, password: string, opts?: { fresh?: boolean }): Promise<E2ESession>`
  - `forgetSession(email: string): void`
  - `webLogin(page: Page, email?: string, password?: string, opts?: { fresh?: boolean }): Promise<void>` (existing positional parameters unchanged)
  - Playwright env `E2E_WEB_MODE=build`: web server runs from `apps/web/.output/server/index.mjs`

Why the suite is red: login is throttled at 5 per minute per IP (`apps/api/src/auth/auth.controller.ts:56`). Every spec file logs in through `login()` in `beforeAll`, and five of them call `webLogin()` in `beforeEach`, all from 127.0.0.1, so the suite trips 429 within the first minute. The fix is one cached login per user per worker, not a looser throttle.

Why `networkidle` must go on stream pages: Playwright's `networkidle` waits for no open requests for 500 ms. From Task 7 on, the board and ticket detail keep an `EventSource` open, so `networkidle` never settles there and the wait times out.

Session cache safety: `POST /auth/refresh` does not bump `tokenVersion` (`auth.service.ts` `refresh`), so the refresh test can keep using a cached session. `POST /auth/logout` does bump it, which revokes every cached token of that user: the logout test must use its own fresh session and then drop the cached one.

- [ ] **Step 1: Confirm the baseline**

Run: `cd apps/api && bun run test:db:up` then `cd apps/web && bun run test:e2e 2>&1 | tail -40`
Expected: failures, including `Login failed: 429` / `Login API failed: 429`. Save the list of failing tests (file and title); Step 6 compares against it.

- [ ] **Step 2: Write the session cache**

`apps/web/tests/e2e/fixtures/session.ts`:

```ts
/**
 * One API login per user per Playwright worker. The API throttles login to
 * 5/min per IP (all e2e traffic is 127.0.0.1), so logging in per test trips
 * 429. Tokens are reused for up to 10 minutes (access tokens live 15).
 *
 * POST /auth/logout bumps the user's tokenVersion and revokes every cached
 * token: a test that logs out must use { fresh: true } and call
 * forgetSession() afterwards.
 */
const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const MAX_AGE_MS = 10 * 60_000;

export interface E2ESession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  obtainedAt: number;
}

let cache: ReadonlyMap<string, E2ESession> = new Map();

async function loginOnce(email: string, password: string): Promise<E2ESession> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 429) {
    throw new Error(
      'Login throttled (429): more than 5 logins/min from this IP. Reuse getSession() instead of logging in per test.',
    );
  }
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { accessToken?: string; refreshToken?: string; user?: { id?: string } };
  };
  const accessToken = body.data?.accessToken;
  const refreshToken = body.data?.refreshToken;
  const userId = body.data?.user?.id;
  if (!accessToken || !refreshToken || !userId) {
    throw new Error('Login response missing accessToken, refreshToken or user id');
  }
  return { accessToken, refreshToken, userId, obtainedAt: Date.now() };
}

export async function getSession(
  email: string,
  password: string,
  opts: { fresh?: boolean } = {},
): Promise<E2ESession> {
  const cached = cache.get(email);
  if (!opts.fresh && cached && Date.now() - cached.obtainedAt < MAX_AGE_MS) return cached;
  const session = await loginOnce(email, password);
  cache = new Map([...cache, [email, session]]);
  return session;
}

export function forgetSession(email: string): void {
  const next = new Map(cache);
  next.delete(email);
  cache = next;
}
```

- [ ] **Step 3: Route `login()` and `webLogin()` through the cache**

In `apps/web/tests/e2e/fixtures/api-client.ts`, add `import { getSession } from './session';` and replace the body of `login`:

```ts
export async function login(email: string, password: string): Promise<LoginResult> {
  const session = await getSession(email, password);
  return { token: session.accessToken, userId: session.userId };
}
```

In `apps/web/tests/e2e/fixtures/page-helpers.ts`, add `import { getSession } from './session';`, change the signature to

```ts
export async function webLogin(
  page: Page,
  email = E2E_ADMIN.email,
  password = E2E_ADMIN.password,
  opts: { fresh?: boolean } = {},
) {
```

and replace step 1 (the `page.request.post(.../api/auth/login)` call, the `response.ok()` check, the body parsing and the `if (!accessToken)` check) with:

```ts
  const webUrl = process.env['E2E_WEB_URL'] ?? 'http://localhost:3103';

  // 1. One cached API login per user per worker (see fixtures/session.ts)
  const { accessToken, refreshToken } = await getSession(email, password, opts);
```

Remove the now-unused `apiUrl` constant. Steps 2-4 (cookie injection, navigate to `/`, hydration retry) stay as they are; the cookie value `refreshToken ?? ''` becomes `refreshToken`.

- [ ] **Step 4: Make the logout test use its own session**

In `apps/web/tests/e2e/auth.spec.ts`:
- change the import to `import { webLogin } from './fixtures/page-helpers';` plus `import { forgetSession } from './fixtures/session';` and `import { E2E_ADMIN } from './fixtures/api-client';`;
- in `test('logout clears session and redirects to login', …)`, change `await webLogin(page);` to `await webLogin(page, undefined, undefined, { fresh: true });`;
- directly after `await page.getByRole('button', { name: 'Logout' }).first().click();` add:

```ts
    // Logout bumped tokenVersion: every cached admin token is now revoked.
    forgetSession(E2E_ADMIN.email);
```

- [ ] **Step 5: Replace `networkidle` on the ticket detail page**

In `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts`, each of the three `await page.waitForLoadState('networkidle');` lines that follow `await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);` becomes:

```ts
    // The page holds a live EventSource open, so 'networkidle' never settles.
    await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible({ timeout: 10000 });
```

Then search the rest of the suite: `grep -rn "networkidle" apps/web/tests/e2e`. Any remaining `networkidle` wait that runs on a board (`/${slug}`) or ticket detail (`/${slug}/tickets/...`) page gets the same treatment, with a locator for something that page renders. Waits on `/`, `/login`, `/${slug}/labels` or `/${slug}/settings` can stay (no stream there).

- [ ] **Step 6: Add the build mode to the Playwright config**

In `apps/web/playwright.config.ts`, above `export default defineConfig`, add:

```ts
// E2E_WEB_MODE=build (CI): serve the production build instead of `nuxt dev`.
// Build first: `bunx turbo run build --filter=@nathapp/koda-web`.
const WEB_BUILD_MODE = process.env['E2E_WEB_MODE'] === 'build';
const WEB_DEV_COMMAND = `bash -lc "bunx nuxt dev --port ${WEB_PORT} 2>&1 | grep -Ev 'Two component files resolving to the same name|/components/ui/.*/index.ts|/components/ui/.*/[A-Za-z]+\\\\.vue|MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module because module syntax was detected|To eliminate this warning, add \"type\": \"module\"'"`;
const WEB_BUILD_COMMAND = `bash -c "test -f .output/server/index.mjs || { echo 'E2E_WEB_MODE=build needs a web build first' >&2; exit 1; }; node .output/server/index.mjs"`;
```

Move the existing web `command` string into `WEB_DEV_COMMAND` exactly as it is today (copy it from the file rather than from this plan, since the escaping must stay identical), then in the web `webServer` entry use:

```ts
      command: WEB_BUILD_MODE ? WEB_BUILD_COMMAND : WEB_DEV_COMMAND,
```

and extend its `env` with `PORT: String(WEB_PORT),` (Nitro's node server reads `PORT`; `nuxt dev` ignores it because `--port` wins).

- [ ] **Step 7: Run the suite and fix what remains**

Run: `cd apps/web && bun run test:e2e`
Expected: no 429s. For every remaining failure:
1. Reproduce it alone: `bunx playwright test <file> -g "<title>"`.
2. Decide: a test bug (stale selector, wrong expectation, timing) or a product bug.
3. Fix test bugs in the test. For a product bug, **stop and report it to the user** with the failing test, the observed and expected behavior; do not change product code under this task, and do not skip or delete the test without the user's decision.

Also run the build mode once: `cd apps/web && bunx turbo run build --filter=@nathapp/koda-web && E2E_WEB_MODE=build bun run test:e2e`.
Expected: the same result as dev mode.

The KB specs honor `SKIP_KB_E2E=1`; they need a reachable embeddings provider. If they fail locally only because Ollama is not running, note it and move on (CI sets `SKIP_KB_E2E=1`, Task 9).

- [ ] **Step 8: Commit**

```bash
git add apps/web/tests/e2e apps/web/playwright.config.ts
git commit -m "test(web): e2e suite green again — cached logins, no networkidle on live pages, build mode"
```

List in the commit body each test that was failing in Step 1 and what fixed it.

---

### Task 9: Live e2e proof and the CI `e2e` job

**Files:**
- Modify: `apps/web/tests/e2e/fixtures/api-client.ts` (`createUser`, `addProjectMember`, `createComment`)
- Create: `apps/web/tests/e2e/live-board.spec.ts`
- Modify: `.github/workflows/ci.yml` (new `e2e` job)

**Interfaces:**
- Consumes: Tasks 5-8 (`data-testid="board-column-<STATUS>"`, `webLogin(page, email, password)`, `confirmTransitionDialog`), Slice 4 endpoints `POST /api/admin/users` and `POST /api/projects/:slug/members`.
- Produces: `createUser(token, { email, name, password }): Promise<void>` (tolerates 409), `addProjectMember(token, slug, email, role): Promise<void>` (tolerates 409), `createComment(token, slug, ref, body): Promise<void>`.

- [ ] **Step 1: Add the fixture helpers**

Append to `apps/web/tests/e2e/fixtures/api-client.ts`:

```ts
export async function createUser(
  token: string,
  data: { email: string; name: string; password: string },
): Promise<void> {
  const res = await fetch(`${API_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...data, role: 'MEMBER' }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Create user failed: ${res.status} ${await res.text()}`);
}

export async function addProjectMember(
  token: string,
  projectSlug: string,
  email: string,
  role: 'ADMIN' | 'DEVELOPER' | 'VIEWER',
): Promise<void> {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Add member failed: ${res.status} ${await res.text()}`);
}

export async function createComment(
  token: string,
  projectSlug: string,
  ticketRef: string,
  body: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/tickets/${ticketRef}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body, type: 'GENERAL' }),
  });
  if (!res.ok) throw new Error(`Create comment failed: ${res.status} ${await res.text()}`);
}
```

`ticket-detail-operations.e2e.spec.ts` has a local `createComment` with the same signature; leave it (removing it is outside this slice).

- [ ] **Step 2: Write the live e2e spec**

`apps/web/tests/e2e/live-board.spec.ts`:

```ts
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  addProjectMember,
  createComment,
  createProject,
  createTicket,
  createUser,
  deleteProject,
  login,
  transitionTicket,
  E2E_ADMIN,
} from './fixtures/api-client';
import { confirmTransitionDialog, generateUniqueProjectKey, webLogin } from './fixtures/page-helpers';

/**
 * Track 1 Slice 5 proof: live updates stream through the real Nuxt proxy.
 * A (admin) and B (a project DEVELOPER) use separate browser contexts.
 */
const MEMBER = { email: 'live-member@koda-e2e.test', name: 'Live Member', password: 'E2ePassword1!' };

interface Session {
  context: BrowserContext;
  page: Page;
}

async function openAs(browser: Browser, email: string, password: string): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await webLogin(page, email, password);
  return { context, page };
}

/** Navigate and resolve once this page's live stream answered 200. */
async function gotoLive(page: Page, url: string, slug: string): Promise<void> {
  const streamOpen = page.waitForResponse(
    (res) => res.url().includes(`/api/projects/${slug}/events`) && res.status() === 200,
    { timeout: 10000 },
  );
  await page.goto(url);
  await streamOpen;
}

test.describe('Live updates (SSE through the Nuxt proxy)', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    const project = await createProject(token, {
      name: 'E2E Live Board',
      slug: `e2elive${suffix}`,
      key: generateUniqueProjectKey('LV'),
    });
    projectSlug = project.slug;
    await createUser(token, MEMBER);
    await addProjectMember(token, projectSlug, MEMBER.email, 'DEVELOPER');
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('A verifies a ticket; the card moves on B\'s board without a reload', async ({ browser }) => {
    const ticket = await createTicket(token, projectSlug, { title: `Live move ${Date.now()}`, type: 'BUG' });
    const a = await openAs(browser, E2E_ADMIN.email, E2E_ADMIN.password);
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      await gotoLive(b.page, `/${projectSlug}`, projectSlug);
      await expect(b.page.getByTestId('board-column-CREATED').getByText(ticket.title)).toBeVisible();
      await b.page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

      await gotoLive(a.page, `/${projectSlug}/tickets/${ticket.ref}`, projectSlug);
      await a.page.getByRole('button', { name: 'Verify' }).click();
      await confirmTransitionDialog(a.page, 'verified while B watches');

      await expect(b.page.getByTestId('board-column-VERIFIED').getByText(ticket.title)).toBeVisible({ timeout: 5000 });
      expect(await b.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    }
    finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('B on ticket detail sees a new comment appear', async ({ browser }) => {
    const ticket = await createTicket(token, projectSlug, { title: `Live comment ${Date.now()}`, type: 'BUG' });
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      await gotoLive(b.page, `/${projectSlug}/tickets/${ticket.ref}`, projectSlug);
      const body = `live comment ${Date.now()}`;

      await createComment(token, projectSlug, ticket.ref, body);

      await expect(b.page.getByText(body)).toBeVisible({ timeout: 5000 });
    }
    finally {
      await b.context.close();
    }
  });

  test('leaving the board releases the stream: after 6 visits live updates still arrive', async ({ browser }) => {
    const ticket = await createTicket(token, projectSlug, { title: `Live leak ${Date.now()}`, type: 'BUG' });
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      for (let visit = 0; visit < 6; visit += 1) {
        await gotoLive(b.page, `/${projectSlug}`, projectSlug);
        await b.page.goto('/');
      }
      await gotoLive(b.page, `/${projectSlug}`, projectSlug);

      await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'verified after many visits' });

      await expect(b.page.getByTestId('board-column-VERIFIED').getByText(ticket.title)).toBeVisible({ timeout: 5000 });
    }
    finally {
      await b.context.close();
    }
  });
});
```

The third test is Review Focus 1: if the proxy leaked upstream streams, visits 6 and 7 would get 429 from the 5-stream cap and `gotoLive` would time out.

If the "Verify" button or dialog labels differ from `ticket-lifecycle.spec.ts` (which uses the same `Verify` button and `confirmTransitionDialog`), follow that spec.

- [ ] **Step 3: Run the live spec**

Run: `cd apps/web && bunx playwright test tests/e2e/live-board.spec.ts`
Expected: PASS (3 tests). Then the full suite: `bun run test:e2e`, expected green.

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`, add after the `integration` job (same indentation as the other jobs):

```yaml
  # ─── Web e2e (Playwright, Postgres, built web) ─────────────────────────────
  e2e:
    name: e2e
    runs-on: ubuntu-latest
    timeout-minutes: 30
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: koda
          POSTGRES_PASSWORD: koda
          POSTGRES_DB: koda_e2e
        ports:
          - 5433:5432
        options: >-
          --health-cmd "pg_isready -U koda -d koda_e2e"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.11"

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Cache bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Generate Prisma client
        run: bun run db:generate

      - name: Build web
        run: bunx turbo run build --filter=@nathapp/koda-web

      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('bun.lock') }}

      - name: Install Playwright Chromium
        run: cd apps/web && bunx playwright install --with-deps chromium

      - name: Playwright
        run: cd apps/web && bun run test:e2e
        env:
          CI: "true"
          E2E_WEB_MODE: build
          E2E_DATABASE_URL: postgresql://koda:koda@localhost:5433/koda_e2e
          # Dummy secrets for the e2e API only (env validation requires them).
          JWT_SECRET: e2e-jwt-secret-not-a-real-secret
          JWT_REFRESH_SECRET: e2e-jwt-refresh-secret-not-a-real-secret
          API_KEY_SECRET: e2e-api-key-secret-not-a-real-secret
          RAG_IN_MEMORY_ONLY: "true"
          SKIP_KB_E2E: "1"

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            apps/web/playwright-report
            apps/web/test-results
          retention-days: 7
```

Playwright's `webServer.env` is merged over `process.env`, so the API server receives these variables; `NODE_ENV` stays unset there, so the outbox relay polls (1 s) and live events flow as in production.

- [ ] **Step 5: Lint the workflow**

Run: `bunx --bun yaml-lint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"`
Expected: `ok` (or no yaml-lint errors).

- [ ] **Step 6: Commit**

```bash
git add apps/web/tests/e2e/fixtures/api-client.ts apps/web/tests/e2e/live-board.spec.ts .github/workflows/ci.yml
git commit -m "test(web): live board e2e through the Nuxt proxy; ci: add Playwright e2e job"
```

The job's first real run happens on the PR. Making `e2e` a required check is a branch-protection setting on GitHub: tell the user it is ready once the job has passed on `main`; do not change repository settings yourself.

---

### Task 10: Docs and final verification

**Files:**
- Modify: `docs/architecture.md` (new section after "Users, registration and membership (Track 1 Slice 4)")
- Modify: `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` (status line)

- [ ] **Step 1: Architecture section**

Insert after the Slice 4 section in `docs/architecture.md`:

```markdown
### Live updates (Track 1 Slice 5)

- **Source**: `TicketLiveSubscriber` (`apps/api/src/live/`) is one more handler on the
  outbox fan-out for `ticket_event`. It maps the action (`TICKET_CREATED`, `TICKET_UPDATED`,
  `status_changed`, `assigned`, `COMMENT_ADDED`, `TICKET_DELETED`) to a content-free
  `LiveEvent` and publishes it on the in-process `ProjectEventBus`. Latency is the relay
  poll (1 s) plus the batch ahead of it; delivery is at-least-once, and clients drop
  duplicates by event id.
- **Stream**: `GET /projects/:slug/events` (SSE, browser users only, project members only,
  at most 5 streams per user). It sends `ready`, then `ticket` events, and a `ping` every
  `LIVE_HEARTBEAT_MS` (25 s) after re-checking the token (`tokenVersion`, `disabled`, 60 s
  cache) and membership (live). It closes on lost access and at token expiry. Excluded
  from `openapi.json`.
- **Web**: `server/api/projects/[slug]/events.get.ts` proxies the stream and aborts the
  upstream request when the browser disconnects (the catch-all proxy cannot).
  `useProjectEvents` wraps `EventSource` with dedupe, resync-on-reconnect and
  auth-refresh backoff. The board and ticket detail refetch silently (never through
  `useAsyncData` `refresh()`).
- **Single instance**: the bus is in memory; a multi-instance API would need a shared bus.
```

- [ ] **Step 2: Spec status line**

In the spec, change the `**Status:**` line to: `**Status:** Approved design. Slices 1-4 merged (#133, #134, #137, #139). Slice 5 implemented on \`feat/track1-sse\`.`

- [ ] **Step 3: Full verification**

From the repo root:

```bash
bun run lint
bun run type-check
bun run test
(cd apps/api && bun run test:db:up && bun run test:integration)
(cd apps/web && bun run test:e2e)
bun run generate && git status --short openapi.json apps/cli
```

Expected: all green; `openapi.json` unchanged. Paste the pass counts into the PR description later.

- [ ] **Step 4: Manual check on the Bun production runtime**

No automated suite runs the API under Bun (production `CMD` is `bun /app/apps/runtime/dist/main`) or the web under `bun .output/server/index.mjs`. From the repo root: `docker compose up --build -d`, create an admin (first registration on an empty DB), create a project and a ticket, and open the board in two browser windows (the second one private, logged in as a second user added as a project member). Move the ticket in one window; it must move in the other within a few seconds, without reloading. In DevTools → Network, the `events` request shows `ready` and then `ping`s. Close one window and confirm the API log shows no error.

If this fails, the slice is blocked: report it to the user with what you observed. Do not merge around it.

- [ ] **Step 5: Track 1 success criteria (read-only)**

The spec's success criteria also require M4, M6, M14 and M20 (defined in `docs/20260925-review-whole-repo.md`) re-verified closed at the final HEAD. For each, read the finding, locate the code that closed it (M4: `src/outbox/fan-out-publisher.ts` and the relay backoff; M6: `runWithTicketNumberRetry` in all ticket-number allocators; M14: `getProjectCodeDocuments` reading `GraphNode`, no raw SQL in `apps/api/src`; M20: `KodaPageQuery` / `parseQuery` on the list endpoints) and confirm it still holds. Report the result per item in the PR description. The `koda-local` Postgres cutover criterion is a deployment step that needs the user's approval; list it as pending.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md docs/superpowers/specs/2026-09-25-track-1-foundations-design.md
git commit -m "docs: live updates architecture (Track 1 Slice 5)"
```

Then stop. Do not push or open the PR until the user approves.

---

## Out of scope (recorded, not fixed here)

- CLI or agent subscribers on the stream (agent principals get 403).
- Live events for comment edit/delete, labels, links, memory, timeline and agents.
- `Last-Event-ID` replay; multi-instance fan-out (Redis).
- Refactoring `TicketsService.recordTicketEvent`, `TicketTransitionsService.recordStatusChangedEvent` and the new comment recorder into one shared recorder (three copies of the same two calls now exist).
- The duplicate local `createComment` in `ticket-detail-operations.e2e.spec.ts`.
- The `koda-local` Postgres cutover and the other open follow-ups listed in the fleet design doc §9.5.
