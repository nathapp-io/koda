/**
 * P3 approval core (US-007): the reusable command a spec registers under an approvable key.
 *
 * The registry is a singleton that refuses a second registration for a key, so a spec file registers
 * one command per key in `beforeAll` and calls `reset()` in `beforeEach`; the spec then turns on just
 * the behaviour the case needs through `state`.
 *
 * A key production already registers — the two fleet asks — cannot be registered again, so a spec
 * that boots `AppModule` installs its double over the registered command instead
 * (`installOverRegisteredCommand`).
 *
 * The command's input is an object of string values (the shape most approvable keys take: an id, or
 * an id and a name). `execute` records the input and the decision it was handed, returns `'done'`,
 * and can additionally write a `Label` row and record an audit entry — both through the dependencies
 * a database spec passes in:
 *
 * ```ts
 * const { command, state, reset } = configurableTestCommand('label.delete', {
 *   prisma: app.get(PrismaService, { strict: false }),
 *   audit: app.get(AuditRecorder, { strict: false }),
 * });
 * ```
 *
 * `execute` writes through the `PrismaService` (not a raw client) so that the row joins the ambient
 * transaction: an execution that fails rolls the label back with it.
 */
import type { ApprovalCommand, ApprovalRedeem, ApprovalCommandRegistry } from '../approval-command.registry';

/** The input shape `parse` accepts and returns a copy of: a flat object of string values. */
export type TestCommandInput = Record<string, string>;

/** What a failed `parse` reports: the gate must not swallow it, and no request is written. */
const PARSE_REFUSED = 'test parse refused';
const INPUT_REFUSED = 'test command input must be an object of string values';
const EXECUTION_FAILED = 'boom';

/** The part of the app's `PrismaService` this helper writes through. */
export interface TestCommandPrisma {
  client: {
    label: {
      create(args: { data: { projectId: string; name: string } }): PromiseLike<unknown>;
    };
  };
}

/** The part of `AuditRecorder` this helper records through. */
export interface TestCommandAudit {
  record(input: { key: string; resourceType: string; resourceId: string }): Promise<unknown>;
}

/** The collaborators `execute` needs only when the matching state field is on. */
export interface TestCommandDeps {
  prisma?: TestCommandPrisma;
  audit?: TestCommandAudit;
  /**
   * The variant this command registers under, e.g. `rest:labels.delete`. Absent registers the key's
   * primary command; a spec that needs both registers one of each.
   */
  variant?: string;
}

/** The `parseDecision` switch: while set, the command carries the hook with this behaviour. */
export interface TestParseDecisionState {
  /** Every call, in order, with the arguments the decision service passed. */
  calls: Array<{ decision: 'approve' | 'reject'; params: unknown; input: TestCommandInput }>;
  /** The value the hook answers; `undefined` answers undefined. */
  result: unknown;
  /** The hook throws `TypeError('test parse refused')` instead of answering. */
  throws: boolean;
}

/** The `afterCommit` switch: while set, the command carries the hook with this behaviour. */
export interface TestAfterCommitState {
  /** Every call, in order, with the arguments the execution service passed. */
  calls: Array<{ input: TestCommandInput; decision: unknown; result: unknown }>;
  /** The hook records its call, then throws this error. */
  throws: Error | null;
}

/** The `onReject` switch: while set, the command carries the hook with this behaviour. */
export interface TestRejectState {
  /** Every call, in order, with the arguments the decision service passed. */
  calls: Array<{ input: TestCommandInput; decision: unknown }>;
  /** The hook records its call, then throws this error. */
  throws: Error | null;
}

/**
 * The `redeem` switch: while set, the command declares the redeem mode (US-001 of `gate-secret`), so
 * the gate stores and hashes the redacted input and marks the request redeemable.
 */
export interface TestRedeemState {
  /** Every input `redact` ran with, in order. */
  calls: TestCommandInput[];
  /** The keys `redact` removes from its copy of the input. */
  drop: readonly string[];
  /**
   * Set to make `redact` answer this value instead of the redacted copy: `null` and `undefined`
   * exercise a broken redaction, which must refuse rather than store the secret.
   */
  answer: { value: unknown } | null;
  /** The command declares `redeem` with no `redact`: the input is stored whole and still redeemable. */
  withoutRedact: boolean;
}

/**
 * The switches a case flips. `reset()` turns every one of them off (and empties `calls`), so a case
 * never inherits the previous case's behaviour.
 */
export interface TestCommandState {
  /** Every input `execute` ran with, in order. */
  calls: TestCommandInput[];
  /** The decision each `execute` received, in order (aligned with `calls`). */
  decisions: unknown[];
  /** Every `parse` throws `TypeError('test parse refused')`. */
  parseThrows: boolean;
  /** `parse` calls after the n-th throw (`1` lets the gate's parse pass and fails the re-parse). */
  parseThrowsAfter: number | null;
  parseReturnsUndefined: boolean;
  /** `execute` throws `Error('boom')` after its other effects. */
  executeThrows: boolean;
  /** `execute` first creates that `Label` row through Prisma. */
  writeLabel: { projectId: string; name: string } | null;
  /** `execute` records `AuditRecorder.record({ key, resourceType: 'test', resourceId: 'test' })`. */
  recordAudit: boolean;
  /** Used as the command's `toResult` while set; the command carries none otherwise. */
  toResult: ((result: string) => unknown) | null;
  /** Used as the command's `parseDecision` while set; the command carries none otherwise. */
  parseDecision: TestParseDecisionState | null;
  /** Used as the command's `onReject` while set; the command carries none otherwise. */
  onReject: TestRejectState | null;
  /** Used as the command's `afterCommit` while set; the command carries none otherwise. */
  afterCommit: TestAfterCommitState | null;
  /** Used as the command's `redeem` while set; the command carries none otherwise. */
  redeem: TestRedeemState | null;
}

export interface ConfigurableTestCommand {
  command: ApprovalCommand<TestCommandInput, string>;
  state: TestCommandState;
  reset(): void;
}

export function configurableTestCommand(key: string, deps: TestCommandDeps = {}): ConfigurableTestCommand {
  const state = freshState();
  // Kept outside `state`: the parse budget is bookkeeping, not a switch a case inspects.
  let parseCount = 0;

  const command: ApprovalCommand<TestCommandInput, string> = {
    key,
    // A getter alongside the hooks, not a spread of them: `deps.variant` is fixed for the command's
    // lifetime, and the registry reads it once at registration.
    get variant(): string | undefined {
      return deps.variant;
    },
    parse(input: unknown): TestCommandInput {
      parseCount += 1;
      if (state.parseThrows || exceededParseBudget(state, parseCount)) throw new TypeError(PARSE_REFUSED);
      if (state.parseReturnsUndefined) return undefined as unknown as TestCommandInput;

      return copyOf(input);
    },
    async execute(input: TestCommandInput, decision?: unknown): Promise<string> {
      state.calls.push({ ...input });
      state.decisions.push(decision);
      if (state.writeLabel !== null) await writeLabel(deps, state.writeLabel);
      if (state.recordAudit) await recordAudit(deps, key);
      if (state.executeThrows) throw new Error(EXECUTION_FAILED);

      return 'done';
    },
    // A getter, not a fixed method: the engine treats an absent `toResult` as "store null", so the
    // command must carry none until a case asks for one.
    get toResult(): ((result: string) => unknown) | undefined {
      return state.toResult ?? undefined;
    },
    // Getters for the same reason as `toResult`: the decision service refuses params unless the
    // command carries `parseDecision`, and only calls `onReject` when the command carries one.
    get parseDecision(): ((decision: 'approve' | 'reject', params: unknown, input: TestCommandInput) => unknown) | undefined {
      const switchState = state.parseDecision;
      if (switchState === null) return undefined;

      return (decision, params, input) => {
        switchState.calls.push({ decision, params, input });
        if (switchState.throws) throw new TypeError(PARSE_REFUSED);

        return switchState.result;
      };
    },
    get onReject(): ((input: TestCommandInput, decision: unknown) => Promise<void>) | undefined {
      const switchState = state.onReject;
      if (switchState === null) return undefined;

      return async (input, decision) => {
        switchState.calls.push({ input, decision });
        if (switchState.throws !== null) throw switchState.throws;
      };
    },
    get afterCommit(): ((input: TestCommandInput, decision: unknown, result: unknown) => Promise<void>) | undefined {
      const switchState = state.afterCommit;
      if (switchState === null) return undefined;

      return async (input, decision, result) => {
        switchState.calls.push({ input, decision, result });
        if (switchState.throws !== null) throw switchState.throws;
      };
    },
    // A getter, like the other switches: the gate reads `redeem.redact` when it opens a request, and a
    // case turns the mode on only for the cases that need it.
    get redeem(): ApprovalRedeem<TestCommandInput> | undefined {
      const switchState = state.redeem;
      if (switchState === null) return undefined;
      if (switchState.withoutRedact) return {};

      return {
        redact: (input) => {
          switchState.calls.push({ ...input });
          if (switchState.answer !== null) return switchState.answer.value;

          const copy: TestCommandInput = { ...input };
          for (const key of switchState.drop) delete copy[key];

          return copy;
        },
      };
    },
  };

  return {
    command,
    state,
    reset(): void {
      Object.assign(state, freshState());
      parseCount = 0;
    },
  };
}

/** Every member of `ApprovalCommand` a spec may replace; `key` belongs to the registry entry. */
const OVERRIDABLE_MEMBERS = ['parse', 'execute', 'toResult', 'parseDecision', 'onReject', 'afterCommit'] as const;

/**
 * Installs `command`'s behaviour over the command the registry already holds for its key.
 *
 * A spec that boots `AppModule` inherits the commands a production module registers in
 * `onModuleInit` — the two fleet asks — and `register` refuses a second command for a key, so the
 * double cannot sit beside the production one. The registry hands out the instance it stores, so
 * writing the double's members onto that instance is enough: every ask, decide and execute resolves
 * the double, and the registry keeps its one-command-per-key rule instead of gaining a test-only
 * replacement path.
 *
 * The override lasts as long as the app it was installed in, which is the spec file: each file boots
 * its own application, and its commands are that application's instances.
 *
 * ```ts
 * const shell = configurableTestCommand('fleet.job.shell.escalate');
 * installOverRegisteredCommand(app.get(ApprovalCommandRegistry, { strict: false }), shell.command);
 * ```
 */
export function installOverRegisteredCommand(registry: ApprovalCommandRegistry, command: ApprovalCommand): void {
  const registered = registry.get(command.key);
  if (registered === undefined) {
    throw new Error(`installOverRegisteredCommand: no command registered for ${command.key}`);
  }

  // Descriptors, not values: the hooks are getters a spec switches per case, and a copied value would
  // freeze the switch at install time.
  for (const member of OVERRIDABLE_MEMBERS) {
    const descriptor = Object.getOwnPropertyDescriptor(command, member);
    if (descriptor !== undefined) Object.defineProperty(registered, member, descriptor);
  }
}

function freshState(): TestCommandState {
  return {
    calls: [],
    decisions: [],
    parseThrows: false,
    parseThrowsAfter: null,
    parseReturnsUndefined: false,
    executeThrows: false,
    writeLabel: null,
    recordAudit: false,
    toResult: null,
    parseDecision: null,
    onReject: null,
    afterCommit: null,
    redeem: null,
  };
}

function exceededParseBudget(state: TestCommandState, parseCount: number): boolean {
  return state.parseThrowsAfter !== null && parseCount > state.parseThrowsAfter;
}

/** A copy, so a caller mutating the input it passed cannot change what `execute` recorded. */
function copyOf(input: unknown): TestCommandInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError(INPUT_REFUSED);

  const entries = Object.entries(input);
  if (entries.some(([, value]) => typeof value !== 'string')) throw new TypeError(INPUT_REFUSED);

  return { ...(input as TestCommandInput) };
}

async function writeLabel(deps: TestCommandDeps, label: { projectId: string; name: string }): Promise<void> {
  if (deps.prisma === undefined) {
    throw new Error('configurableTestCommand: writeLabel needs a prisma dependency');
  }

  await deps.prisma.client.label.create({ data: { projectId: label.projectId, name: label.name } });
}

async function recordAudit(deps: TestCommandDeps, key: string): Promise<void> {
  if (deps.audit === undefined) {
    throw new Error('configurableTestCommand: recordAudit needs an audit dependency');
  }

  await deps.audit.record({ key, resourceType: 'test', resourceId: 'test' });
}
