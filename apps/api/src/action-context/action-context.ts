import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { LoggerContext } from '@nathapp/nestjs-logging';
import type { FleetActorType } from '../common/enums';
import { PERMISSION_CATALOG, type ApprovalMode } from '../permissions/catalog';
import { SYSTEM_WRITER_METADATA } from '../permissions/system-writer.decorator';
import { runInAuditScope } from './audit-coverage';

/**
 * Permissions P1d US-001 introduced the action context as an early slice of P2's `ActionContext`;
 * Permissions P2 US-001 gives it the full shape (design
 * `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` §5).
 *
 * The context is module-level state carried by an `AsyncLocalStorage` — the same shape as
 * `writeLayerContext` in `policy/policy-gate.service.ts` — so a service reads the request's actor
 * without a constructor parameter and without the caller threading it through.
 *
 * It answers *who is this write attributed to, on whose behalf, from which entry point, under which
 * approval and in which request*: `actor`, `onBehalfOf`, `origin`, `approval` and `correlationId`.
 * An `AuditEntry` reads all five; nothing here writes one.
 */

/** The principal types `actorTypeFor` can answer. A runner or a system component is not a principal. */
export type ActorType = 'USER' | 'AGENT';

/** Who a write is attributed to: a principal, a runner, or a named system component. */
export type ActionActorType = FleetActorType;

export interface ActionActor {
  type: ActionActorType;
  id: string;
}

/** The entry point the write came through. */
export type ActionOrigin = 'rest' | 'mcp' | 'thread' | 'runner' | 'system';

/**
 * What policy demanded, and how the caller met it. `requiredMode` is the floor the catalog or policy
 * set; `satisfiedBy` is how the action was approved. An unapproved action carries `NO_APPROVAL`.
 */
export interface ActionApproval {
  requiredMode: ApprovalMode;
  satisfiedBy: ApprovalMode;
  approverType?: ActorType;
  approverId?: string;
  requestId?: string;
}

export interface ActionContext {
  actor: ActionActor;
  /** Set when the actor is not the principal the action belongs to (a system component or the assistant). */
  onBehalfOf?: { type: ActorType; id: string };
  origin: ActionOrigin;
  approval: ActionApproval;
  /** One id for a request or tick, shared by every nested context. */
  correlationId: string;
}

/** What a caller supplies: `approval` and `correlationId` are filled when absent. */
export type ActionContextInput = Omit<ActionContext, 'approval' | 'correlationId'> &
  Partial<Pick<ActionContext, 'approval' | 'correlationId'>>;

/** The approval block of an action that needed none — and of every action until P3 sets a floor. */
export const NO_APPROVAL: ActionApproval = Object.freeze({ requiredMode: 'none', satisfiedBy: 'none' });

/**
 * Ids with no `system.*` key family: the assistant (thread tool calls, design §4), a public HTTP
 * request before any principal exists, boot-time seeders, and the context-guard feature's production
 * fallback for a context-less write.
 */
const KEYLESS_SYSTEM_ACTOR_IDS: readonly string[] = ['assistant', 'outbox', 'anonymous', 'seed', 'unknown'];

/**
 * System component ids, derived rather than copied: the second segment of every catalog key whose
 * access is `system` (`system.schedule.dispatch` → `schedule`, `system.budget.window-reset` →
 * `budget`), so each `system.*` key family owns exactly one id, plus the keyless ids above.
 */
export const SYSTEM_ACTOR_IDS: ReadonlySet<string> = new Set<string>([
  ...PERMISSION_CATALOG.filter((entry) => entry.access === 'system').map((entry) => entry.key.split('.')[1]),
  ...KEYLESS_SYSTEM_ACTOR_IDS,
]);

const storage = new AsyncLocalStorage<ActionContext>();

/** Runs fn with the input as the current context; a nested run replaces it for its extent. */
export function runWithActionContext<T>(input: ActionContextInput, fn: () => T): T {
  const context: ActionContext = {
    actor: input.actor,
    origin: input.origin,
    approval: input.approval ?? NO_APPROVAL,
    correlationId: input.correlationId ?? resolveCorrelationId(),
  };
  if (input.onBehalfOf !== undefined) context.onBehalfOf = input.onBehalfOf;

  return storage.run(context, fn);
}

/** The current context, or undefined outside any request or run. */
export function currentContext(): ActionContext | undefined {
  return storage.getStore();
}

/**
 * The correlation id of a context that has none of its own: the enclosing context's, so a nested run
 * stays in the same request or tick, else the logging request id, else a fresh one for a run that
 * started outside any request (a sweep, a test).
 */
function resolveCorrelationId(): string {
  const enclosing = storage.getStore();
  if (enclosing !== undefined) return enclosing.correlationId;

  const requestId: unknown = LoggerContext.current().requestId;
  if (typeof requestId === 'string' && requestId.length > 0) return requestId;

  return randomUUID();
}

/**
 * Runs fn as the system component `component` — a sweeper, a cron processor, a seeder. Refuses an id
 * outside `SYSTEM_ACTOR_IDS` before running fn, so a typo names itself instead of writing as a
 * component nothing else knows.
 */
export function runAsSystem<T>(
  component: string,
  fn: () => T,
  opts?: { onBehalfOf?: ActionContext['onBehalfOf']; correlationId?: string; surface?: string },
): T {
  if (!SYSTEM_ACTOR_IDS.has(component)) {
    throw new Error(`unknown system actor id: ${component}`);
  }

  const input: ActionContextInput = {
    actor: { type: 'SYSTEM', id: component },
    origin: 'system',
    correlationId: opts?.correlationId,
    onBehalfOf: opts?.onBehalfOf,
  };

  return runWithActionContext(input, () => runInAuditScope(opts?.surface ?? `system:${component}`, fn));
}

/**
 * Runs fn as the system component a `@SystemWriter` class declares: the second segment of its catalog
 * key (`system.schedule.dispatch` → `schedule`). Refuses a class without the key before running fn.
 */
export function runAsSystemWriter<T>(writer: object, fn: () => T): T {
  const key: unknown = Reflect.getMetadata(SYSTEM_WRITER_METADATA, writer.constructor);
  if (typeof key !== 'string') {
    throw new Error(`runAsSystemWriter needs a @SystemWriter class, got ${writer.constructor.name}`);
  }

  return runAsSystem(key.split('.')[1], fn, { surface: `writer:${writer.constructor.name}` });
}

/** Runs fn with actor as the current actor and origin `rest`; the compatibility helper of P1d US-001. */
export function runWithActor<T>(actor: { type: ActorType; id: string }, fn: () => T): T {
  return runWithActionContext({ actor, origin: 'rest' }, fn);
}

/** The current actor, or undefined outside any request or run. */
export function currentActor(): ActionActor | undefined {
  return storage.getStore()?.actor;
}

/**
 * 'AGENT' when the current actor is the agent with this id, or the action runs on that agent's behalf;
 * 'USER' otherwise (a runner, a system component, a user, or no context at all — every fleet actor id
 * was a user's before P1d).
 */
export function actorTypeFor(actorId: string): ActorType {
  const context = storage.getStore();
  if (context === undefined) return 'USER';

  const { actor, onBehalfOf } = context;
  if (actor.id === actorId && (actor.type === 'USER' || actor.type === 'AGENT')) return actor.type;
  if (onBehalfOf !== undefined && onBehalfOf.id === actorId) return onBehalfOf.type;

  return 'USER';
}
