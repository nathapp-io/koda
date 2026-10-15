import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MemoryKind } from '../../../common/enums';
import { MEMORY_STATUSES } from '../../../memory/dto/list-memory.query';
import { MemoryGovernanceService } from '../../../memory/memory-governance.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { KODA_MEMORY_SEARCH } from '../koda-tool-descriptors';
import { ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';

/**
 * Fleet S5b US-004: the knowledge read tools. The project is the thread's project (S5b-R7) — no tool takes a project
 * argument, and every read is scoped by `ctx.projectId`, so an item of another project can never be named. Input is
 * parsed by hand (1b-D5); the descriptor's `inputSchema` is what the model sees.
 */

/** Every list tool asks the API for one page of 20 (1b §Tool catalog). */
const PAGE_SIZE = 20;
const MAX_TEXT_CHARS = 100;
/** The memory statuses the REST list route accepts, in one place (`list-memory.query.ts`). */
type MemoryStatus = (typeof MEMORY_STATUSES)[number];

interface MemorySearchInput {
  text?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  page: number;
}

/** The input as a record; a missing key, a null and a non-object body all read as absent fields. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** An optional field that must be one of `allowed`; absent and null are both "not given". */
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], reason: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new ToolInputError(reason);
  return value as T;
}

/** An optional 1- to 100-character text with at least one non-whitespace character: blank text is no search. */
function optionalText(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT_CHARS) throw new ToolInputError(reason);
  if (value.trim().length === 0) throw new ToolInputError(reason);
  return value;
}

/** An optional 1-based page number. */
function optionalPage(value: unknown, reason: string): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolInputError(reason);
  return value;
}

/** The last line of a full page. */
const moreLine = (tool: string, nextPage: number): string => `more: call ${tool} with page ${nextPage}`;

/** `<subject> <predicate> <object>`, the object left out when the item has none. */
const memoryText = (item: { subject: string; predicate: string; object?: string }): string =>
  [item.subject, item.predicate, item.object].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');

/**
 * `koda_memory_search` (US-004): one page of the project's memory items, newest `updatedAt` first. Every user-written
 * field of an item — all three of `subject`, `predicate` and `object` — is fenced, so it can never read as
 * instructions. `status` is passed through only when given: without it the service applies its own default (active
 * and not expired by `ttlAt`).
 */
export function memorySearchTool(memory: MemoryGovernanceService): AssistantTool<MemorySearchInput> {
  return {
    descriptor: KODA_MEMORY_SEARCH,
    // 1b-D1: the memory REST routes are member-gated, so the tool declares membership rather than one ability.
    permission: { kind: 'member' },
    parse(input: unknown): MemorySearchInput {
      const raw = asRecord(input);
      return {
        text: optionalText(raw.text, 'text'),
        kind: optionalEnum(raw.kind, Object.values(MemoryKind), 'kind'),
        status: optionalEnum(raw.status, MEMORY_STATUSES, 'status'),
        page: optionalPage(raw.page, 'page'),
      };
    },
    async execute(ctx: ToolContext, input: MemorySearchInput): Promise<string> {
      const page = await memory.getProjectMemory(
        { projectId: ctx.projectId, text: input.text, kind: input.kind, status: input.status, orderBy: 'updatedAt' },
        { current: input.page, size: PAGE_SIZE },
      );
      if (page.records.length === 0) return 'no memory items';
      const lines: string[] = [];
      for (const item of page.records) {
        lines.push(
          `memory:${item.id} ${item.kind} ${item.status} confidence ${item.confidence.toFixed(2)} updated ${item.updatedAt.toISOString()}`,
        );
        lines.push(ctx.data(memoryText(item)));
      }
      if (page.hasNext) lines.push(moreLine(KODA_MEMORY_SEARCH.name, input.page + 1));
      return lines.join('\n');
    },
  };
}

/** The S5b US-004 tool group (1b-D7): registers the knowledge tools with the registry at bootstrap. */
@Injectable()
export class KnowledgeTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly memory: MemoryGovernanceService,
  ) {}

  onModuleInit(): void {
    this.registry.register(memorySearchTool(this.memory));
  }
}
