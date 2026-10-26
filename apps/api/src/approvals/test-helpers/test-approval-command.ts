/**
 * P3 approval core (US-007): the reusable command a spec registers under an approvable key.
 *
 * The registry is a singleton that refuses a second registration for a key, so a spec file registers
 * one command per key in `beforeAll` and calls `reset()` in `beforeEach`; the spec then turns on just
 * the behaviour the case needs through `state`.
 *
 * The command's input is an object of string values (the shape most approvable keys take: an id, or
 * an id and a name). `execute` records the input and returns `'done'`, and can additionally write a
 * `Label` row and record an audit entry — both through the dependencies a database spec passes in:
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
import type { ApprovalCommand } from '../approval-command.registry';

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
}

/**
 * The switches a case flips. `reset()` turns every one of them off (and empties `calls`), so a case
 * never inherits the previous case's behaviour.
 */
export interface TestCommandState {
  /** Every input `execute` ran with, in order. */
  calls: TestCommandInput[];
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
    parse(input: unknown): TestCommandInput {
      parseCount += 1;
      if (state.parseThrows || exceededParseBudget(state, parseCount)) throw new TypeError(PARSE_REFUSED);
      if (state.parseReturnsUndefined) return undefined as unknown as TestCommandInput;

      return copyOf(input);
    },
    async execute(input: TestCommandInput): Promise<string> {
      state.calls.push({ ...input });
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

function freshState(): TestCommandState {
  return {
    calls: [],
    parseThrows: false,
    parseThrowsAfter: null,
    parseReturnsUndefined: false,
    executeThrows: false,
    writeLabel: null,
    recordAudit: false,
    toResult: null,
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
