import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Permissions P1d US-001: the action context, an early slice of P2's `ActionContext`.
 *
 * The context is module-level state carried by an `AsyncLocalStorage` — the same shape as
 * `writeLayerContext` in `policy/policy-gate.service.ts` — so a service reads the request's actor
 * without a constructor parameter and without the caller threading it through.
 *
 * Today it answers one question: *which principal is this write attributed to?* P2 adds the rest
 * (on-behalf-of, the approval block, the correlation id, system actor ids, `AuditEntry`).
 */
export type ActorType = 'USER' | 'AGENT';

export interface ActionActor {
  type: ActorType;
  id: string;
}

export interface ActionContext {
  actor: ActionActor;
}

const storage = new AsyncLocalStorage<ActionContext>();

/** Runs fn with actor as the current actor; nested runs replace it for their extent. */
export function runWithActor<T>(actor: ActionActor, fn: () => T): T {
  return storage.run({ actor }, fn);
}

/** The current actor, or undefined outside any request or runWithActor. */
export function currentActor(): ActionActor | undefined {
  return storage.getStore()?.actor;
}

/** 'AGENT' when the current actor is the agent with this id; otherwise 'USER' (every fleet actor id was a user's before this feature). */
export function actorTypeFor(actorId: string): ActorType {
  const actor = currentActor();
  return actor !== undefined && actor.id === actorId ? actor.type : 'USER';
}
