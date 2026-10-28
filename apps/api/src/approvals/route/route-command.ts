import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { ApprovalCommand } from '../approval-command.registry';

/** The one thing a route command needs from `ActorPrincipalLoader`. */
export interface RoutePrincipalLoader {
  forContext(): Promise<UserPrincipal | AgentPrincipal>;
}

/**
 * US-003: one REST entry point's view of an approvable write — the key it asks under, the command
 * variant it runs, how it parses the body, and the action itself.
 */
export interface RouteCommandSpec<TInput, TResult> {
  /** A catalog key with `approval.approvable === true`. */
  key: string;
  /** This route's command name within the key, e.g. `rest:roles.create`. */
  variant: string;
  /** Validates the route body; `parseBody` with the route's DTO is the usual answer. */
  parse(input: unknown): TInput;
  /** The action, as the principal the loader rebuilt from the action context. */
  run(principal: UserPrincipal | AgentPrincipal, input: TInput): Promise<TResult>;
  /** What `ApprovalRequest.result` stores; omitted means null. */
  toResult?(result: TResult): unknown;
  /**
   * The route's `run` re-checks its own authorisation, so the engine's execution pre-check ("the
   * actor still holds the key") does not apply to its requests. Only the decision route sets it; see
   * `ApprovalCommand.skipKeyRecheck`.
   */
  skipKeyRecheck?: boolean;
}

/**
 * Adapts a route's spec to the registry's command shape.
 *
 * `execute` loads the principal from the action context every time — on the immediate path (no policy
 * needs approval) and on the deferred one (the execution service re-enters the request's context, so
 * the same call answers the requester's principal). One path, at the cost of a read per gated write.
 */
export function routeCommand<TInput, TResult>(
  spec: RouteCommandSpec<TInput, TResult>,
  loader: RoutePrincipalLoader,
): ApprovalCommand<TInput, TResult> {
  const command: ApprovalCommand<TInput, TResult> = {
    key: spec.key,
    variant: spec.variant,
    parse: (input) => spec.parse(input),
    execute: async (input) => spec.run(await loader.forContext(), input),
  };
  const { toResult } = spec;
  if (toResult !== undefined) command.toResult = (result) => toResult(result);
  if (spec.skipKeyRecheck === true) command.skipKeyRecheck = true;

  return command;
}
