/**
 * P3 approval core (US-007): the deferred run is a command registry.
 *
 * Each approvable key registers one executor — a `parse` that validates and freezes the input, an
 * `execute` that performs the action — and a caller runs `ApprovalGate.gate(key, input, …)`. When the
 * action needs approval the caller gets a pending request; when it does not (or an approver decided)
 * the engine runs the executor, so one mechanism serves REST, MCP and threads.
 *
 * The registry holds no database access and no business rules: `register` only refuses a key that
 * cannot be approvable, a malformed variant and a second command for one `(key, variant)` pair.
 * Owning modules register in `onModuleInit`, so this feature registers none in production; specs
 * register a command under an approvable key.
 *
 * Commands are keyed by `(key, variant ?? null)`: a key has at most one primary command (no variant)
 * and any number of named variants beside it. A variant is how one key serves several entry points
 * with different input — a REST route and the assistant tool both write `ticket.create`, and each
 * parses its own body. A primary and a variant of one key never answer for each other.
 */
import { Injectable } from '@nestjs/common';
import type { ApprovalRequestRecord } from './domain/approval.domain';
import { findCatalogEntry } from '../permissions/catalog';

/** The longest variant the registry accepts, in characters. */
const VARIANT_MAX_LENGTH = 100;

/**
 * The redeem mode of an approvable command (US-001 of the `gate-secret` rollout).
 *
 * A command carrying `redeem` cannot execute when its request is approved: the approval only releases
 * the request, and the requester repeats the call with the full input to redeem it. Its stored input is
 * the redacted form, so no secret reaches `ApprovalRequest.input`, the hash or a decider.
 */
export interface ApprovalRedeem<TInput> {
  /** The stored, hashed form of the parsed input; absent stores it whole. Never throws for parse's output. */
  redact?(input: TInput): unknown;
}

export interface ApprovalCommand<TInput = unknown, TResult = unknown, TDecision = unknown> {
  /** Read-only, GET-only request enrichment; failures do not hide the request. */
  details?(request: ApprovalRequestRecord): Promise<Record<string, unknown> | null>;
  /** A catalog key with `approval.approvable === true`. */
  key: string;
  /**
   * This command's name within its key, e.g. `rest:labels.delete`. Absent for the key's primary
   * command, which is what a request opened without a variant runs. Never empty, at most 100
   * characters.
   */
  variant?: string;
  /**
   * Validates the caller's input. The returned value must be JSON-serialisable, and `parse` must
   * accept its own output: an approved request re-parses the input frozen when it was opened.
   *
   * A redeem command's stored input is the redacted one and is never re-parsed: approving its request
   * runs nothing, and the requester redeems it by re-sending the full input, which the engine parses
   * afresh. So `precheck` and the frozen-input re-parse are never reached for a redeem row (its command
   * carries no `parseDecision` or `onReject` either).
   */
  parse(input: unknown): TInput;
  /**
   * Present: an approval only releases the request; the requester redeems it with the full input.
   * The gate stores this command's redacted input, and approving its request runs nothing.
   */
  redeem?: ApprovalRedeem<TInput>;
  /**
   * Validates a decider's params for this request. Absent: a decision may carry no params. The
   * returned value must be JSON-serialisable, and `parseDecision` must accept its own output: the
   * execution re-parses the value stored on the approving decision. Throws to refuse.
   */
  parseDecision?(decision: 'approve' | 'reject', params: unknown, input: TInput): TDecision;
  /**
   * Runs inside the decide transaction after a principal's reject is recorded; a throw rolls it back.
   * It writes rows and may queue `committedEffect`s (the fleet answer's runner wake): the decision
   * service owns that transaction, so those effects run only once the decision and these rows commit.
   */
  onReject?(input: TInput, decision: TDecision | undefined): Promise<void>;
  /**
   * External read-only work before the execution transaction. May also perform work in a store the
   * execution transaction cannot roll back, when that work maintains its own cross-store consistency.
   * Such completed store work is not undone if the post-prepare key re-check refuses execution.
   * Returns an ephemeral mutation callback; it must re-read targets before writing. Never persisted,
   * including any credentials it closes over. Immediate callers use execute, which performs the same
   * preparation itself.
   */
  prepare?(input: TInput, decision?: TDecision): Promise<() => Promise<TResult>>;
  /** `decision` is the approving decision's parsed params, or undefined when none were parsed. */
  execute(input: TInput, decision?: TDecision): Promise<TResult>;
  /** Optional cross-store resource boundary around the entire execution transaction (not prepare).
   * Must release/resolve resources after commit or rollback; it must not open an outer PG transaction.
   */
  withExecution?<T>(input: TInput, transaction: () => Promise<T>): Promise<T>;
  /** What `ApprovalRequest.result` stores; omitted means null. */
  toResult?(result: TResult): unknown;
  /** Runs after the execution transaction committed, under the request's context; a throw is logged only. */
  afterCommit?(input: TInput, decision: TDecision | undefined, result: TResult): Promise<void>;
  /**
   * The command re-checks its own authorisation when it runs, so the execution's "the actor still
   * holds the key" pre-check does not apply to its requests. Only the REST decision command sets it:
   * `recordDecision` re-runs the engine's decide eligibility — the self-confirmation exception
   * included — inside the decision transaction, which is stricter than the key re-check. Without it
   * a requester that may only confirm its own request would be refused as `permission-revoked` for
   * not holding `approval.decide`, after a human approved the decision.
   */
  skipKeyRecheck?: boolean;
}

@Injectable()
export class ApprovalCommandRegistry {
  /**
   * Keyed by the command's key, then by its variant (`null` for the primary command). Two maps, not
   * one joined string: a joined key would let a primary key spelled like `<key>#<variant>` answer
   * another pair's command.
   */
  private readonly commands = new Map<string, Map<string | null, ApprovalCommand>>();

  register(command: ApprovalCommand): void {
    const entry = findCatalogEntry(command.key);
    if (entry === undefined || !entry.approval.approvable) {
      throw new Error(`approval command key is not approvable: ${command.key}`);
    }
    const { variant } = command;
    if (variant !== undefined && (variant.length === 0 || variant.length > VARIANT_MAX_LENGTH)) {
      throw new Error(`approval command variant is invalid: ${command.key}`);
    }
    const registered = this.commands.get(command.key);
    if (registered?.has(variant ?? null) === true) {
      throw new Error(
        `approval command already registered: ${variant === undefined ? command.key : `${command.key}#${variant}`}`,
      );
    }

    if (registered === undefined) this.commands.set(command.key, new Map([[variant ?? null, command]]));
    else registered.set(variant ?? null, command);
  }

  /** The command registered for `(key, variant ?? null)`; undefined when that pair has none. */
  get(key: string, variant?: string): ApprovalCommand | undefined {
    return this.commands.get(key)?.get(variant ?? null);
  }
}
