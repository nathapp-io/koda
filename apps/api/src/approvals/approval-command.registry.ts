/**
 * P3 approval core (US-007): the deferred run is a command registry.
 *
 * Each approvable key registers one executor — a `parse` that validates and freezes the input, an
 * `execute` that performs the action — and a caller runs `ApprovalGate.gate(key, input, …)`. When the
 * action needs approval the caller gets a pending request; when it does not (or an approver decided)
 * the engine runs the executor, so one mechanism serves REST, MCP and threads.
 *
 * The registry holds no database access and no business rules: `register` only refuses a key that
 * cannot be approvable and a second command for a key. Owning modules register in `onModuleInit`, so
 * this feature registers none in production; specs register a command under an approvable key.
 */
import { Injectable } from '@nestjs/common';
import { findCatalogEntry } from '../permissions/catalog';

export interface ApprovalCommand<TInput = unknown, TResult = unknown> {
  /** A catalog key with `approval.approvable === true`. */
  key: string;
  /**
   * Validates the caller's input. The returned value must be JSON-serialisable, and `parse` must
   * accept its own output: an approved request re-parses the input frozen when it was opened.
   */
  parse(input: unknown): TInput;
  /** Runs the action under the caller's (or the request's) action context. */
  execute(input: TInput): Promise<TResult>;
  /** What `ApprovalRequest.result` stores; omitted means null. */
  toResult?(result: TResult): unknown;
}

@Injectable()
export class ApprovalCommandRegistry {
  private readonly commands = new Map<string, ApprovalCommand>();

  register(command: ApprovalCommand): void {
    const entry = findCatalogEntry(command.key);
    if (entry === undefined || !entry.approval.approvable) {
      throw new Error(`approval command key is not approvable: ${command.key}`);
    }
    if (this.commands.has(command.key)) {
      throw new Error(`approval command already registered: ${command.key}`);
    }

    this.commands.set(command.key, command);
  }

  get(key: string): ApprovalCommand | undefined {
    return this.commands.get(key);
  }
}
