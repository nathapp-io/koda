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
import { findCatalogEntry } from '../permissions/catalog';

/** The longest variant the registry accepts, in characters. */
const VARIANT_MAX_LENGTH = 100;

export interface ApprovalCommand<TInput = unknown, TResult = unknown, TDecision = unknown> {
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
   */
  parse(input: unknown): TInput;
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
  /** `decision` is the approving decision's parsed params, or undefined when none were parsed. */
  execute(input: TInput, decision?: TDecision): Promise<TResult>;
  /** What `ApprovalRequest.result` stores; omitted means null. */
  toResult?(result: TResult): unknown;
  /** Runs after the execution transaction committed, under the request's context; a throw is logged only. */
  afterCommit?(input: TInput, decision: TDecision | undefined, result: TResult): Promise<void>;
}

@Injectable()
export class ApprovalCommandRegistry {
  /** Keyed by `commandId(key, variant)`: the key alone for a primary, `key#variant` otherwise. */
  private readonly commands = new Map<string, ApprovalCommand>();

  register(command: ApprovalCommand): void {
    const entry = findCatalogEntry(command.key);
    if (entry === undefined || !entry.approval.approvable) {
      throw new Error(`approval command key is not approvable: ${command.key}`);
    }
    const { variant } = command;
    if (variant !== undefined && (variant.length === 0 || variant.length > VARIANT_MAX_LENGTH)) {
      throw new Error(`approval command variant is invalid: ${command.key}`);
    }
    const id = commandId(command.key, variant);
    if (this.commands.has(id)) {
      throw new Error(`approval command already registered: ${variant === undefined ? command.key : id}`);
    }

    this.commands.set(id, command);
  }

  /** The command registered for `(key, variant ?? null)`; undefined when that pair has none. */
  get(key: string, variant?: string): ApprovalCommand | undefined {
    return this.commands.get(commandId(key, variant));
  }
}

function commandId(key: string, variant: string | undefined): string {
  return variant === undefined ? key : `${key}#${variant}`;
}
