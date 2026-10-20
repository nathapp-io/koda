import { MemoryKind } from '../../../common/enums';
import type { ExtractionService } from '../../../memory/extraction.service';
import type { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import {
  MemoryReplaceRefusedError,
  ownerTypeFor,
  type MemoryWriteGuard,
} from '../../../memory/memory-write.guard';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_RECORD_DECISION } from '../koda-tool-descriptors';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { asRecord } from './tool-input';

/**
 * Fleet S5b 2b1 US-007 (2b1-D4 to D7, 2b-R5): `koda_record_decision` proposes one decision of the thread's project
 * and, once the user approves the proposal, records it as the requester through `ExtractionService.recordDecision`,
 * whose subject is the actor (`agent:<actorId>`) rather than a caller-chosen string, so a decision can only ever be
 * attributed to the requester. On approval the requester's previous decision on the same topic is superseded. The
 * preview reads that previous decision, so the user sees what the approval replaces; a preview never writes.
 */

/** 2b1-D5: the topic and the decision-plus-rationale text are judged on their trimmed length; the descriptor carries
 * the same numbers. */
const MAX_TOPIC_CHARS = 200;
const MAX_TEXT_CHARS = 4_000;

/** 2b1-D7: where the stored decision separates itself from its rationale — a blank line, where the preview uses one. */
const RATIONALE_SEPARATOR = '\n\n';
const PREVIEW_SEPARATOR = '\n';

/** One proposed decision, as the parser accepted it. Every field is kept as written. */
export interface RecordDecisionInput {
  topic: string;
  decision: string;
  rationale?: string;
}

/**
 * `koda_record_decision` (2b1-D3): the decision to record in the thread's project. `execute` is what an approve
 * runs: it records through `ExtractionService.recordDecision`, so the usual `DECISION` item is written, subject
 * `agent:<requester>` and predicate `topic`, and the requester's active decision on that topic is superseded.
 */
export function recordDecisionTool(deps: {
  memory: PrismaMemoryItemRepository;
  extraction: ExtractionService;
  guard: MemoryWriteGuard;
}): AssistantTool<RecordDecisionInput> {
  return {
    descriptor: KODA_RECORD_DECISION,
    key: 'memory.decision.record',
    // 2b1-D4: the memory write routes check project membership (`memory.controller.ts`), so this tool does too.
    permission: { kind: 'member' },
    kind: 'write',
    /**
     * 2b1-D5, 2b-R5: only the three fields of the decision are returned — a caller-supplied `actorId` (or any other
     * key) is dropped here, before the value can reach a proposal, so the decision can only ever be recorded as the
     * requester. `ExtractionService.recordDecision` derives the subject from that actor, not from the input.
     */
    parse(input: unknown): RecordDecisionInput {
      const raw = asRecord(input);
      const topic = raw['topic'];
      if (typeof topic !== 'string' || !withinChars(topic, 1, MAX_TOPIC_CHARS)) throw new ToolInputError('topic');
      const decision = raw['decision'];
      if (typeof decision !== 'string' || !withinChars(decision, 1, MAX_TEXT_CHARS)) {
        throw new ToolInputError('decision');
      }
      const rationale = optionalRationale(raw['rationale']);
      return { topic, decision, ...(rationale === undefined ? {} : { rationale }) };
    },
    /**
     * 2b1-D6: the text the user approves — the project slug, the quoted topic and the decision, then the rationale as
     * its own line when one was given. When the requester already holds an active decision on that topic, the last
     * line shows the decision this approval supersedes, read through the same project-scoped repository the approve
     * records into. The whole text is masked, because the topic, the decision and the rationale are user-written.
     */
    async preview(ctx: ToolContext, input: RecordDecisionInput): Promise<string> {
      // Permissions P1 US-008: the decision this approval supersedes is `agent:<requester>` / the topic, so a
      // proposal that would replace another principal's decision is refused before it exists.
      try {
        await deps.guard.assertMayReplace(ctx.actor, ctx.projectId, {
          kind: MemoryKind.DECISION,
          subject: `agent:${ctx.actor.id}`,
          predicate: input.topic,
        });
      } catch (error) {
        if (error instanceof MemoryReplaceRefusedError) throw new ToolForbiddenError('memory.update');
        throw error;
      }
      const lines = [`Record a decision in ${ctx.projectSlug} on "${input.topic}": ${input.decision}`];
      if (input.rationale !== undefined) lines.push(`Rationale: ${input.rationale}`);
      const active = await deps.memory.findActive(
        ctx.projectId,
        MemoryKind.DECISION,
        `agent:${ctx.actor.id}`,
        input.topic,
      );
      if (active) {
        // The decision itself is the item's object; an item without one is named alone, as `koda_add_memory` does.
        lines.push(active.object ? `Supersedes memory:${active.id}: ${active.object}` : `Supersedes memory:${active.id}`);
      }
      return maskSecrets(lines.join(PREVIEW_SEPARATOR));
    },
    /**
     * 2b1-D7, 2b-R5: the decision is recorded in the action's project — never the thread's home project — as the
     * requester, from this thread. `recordDecision` stores only `decision` as the item's object, so the approved
     * rationale is composed into it, one blank line below the decision (the same text the preview showed under
     * `Rationale: `), and no `rationale` field is passed.
     */
    async execute(ctx: ToolContext, input: RecordDecisionInput): Promise<string> {
      const decision =
        input.rationale === undefined
          ? input.decision
          : `${input.decision}${RATIONALE_SEPARATOR}Rationale: ${input.rationale}`;
      try {
        const recorded = await deps.extraction.recordDecision(
          {
            projectId: ctx.projectId,
            actorId: ctx.actor.id,
            topic: input.topic,
            decision,
            sourceId: ctx.threadId === null ? `mcp:${ctx.actor.id}` : `thread:${ctx.threadId}`,
            ownerType: ownerTypeFor(ctx.actor),
          },
          deps.memory,
          { beforeSupersede: deps.guard.replaceCheck(ctx.actor, ctx.projectId) },
        );
        return `decision memory:${recorded.memoryId} recorded`;
      } catch (error) {
        // Permissions P1 US-008: a supersede that became forbidden between the preview and the approve.
        if (error instanceof MemoryReplaceRefusedError) {
          throw new ToolActionError(`forbidden: memory:${error.itemId} needs memory.update`);
        }
        throw error;
      }
    },
  };
}

/** An absent rationale, or a string judged after trim; anything else is the named refusal (2b1-D5). */
function optionalRationale(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !withinChars(value, 0, MAX_TEXT_CHARS)) throw new ToolInputError('rationale');
  return value;
}

/** 2b1-D5: the trimmed length is what is judged; the value itself is stored as written. */
const withinChars = (text: string, min: number, max: number): boolean => {
  const length = text.trim().length;
  return length >= min && length <= max;
};
