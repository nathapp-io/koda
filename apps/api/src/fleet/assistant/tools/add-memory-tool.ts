import { MemoryKind } from '../../../common/enums';
import type { MemoryItem } from '../../../memory/memory-item-repository';
import type { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import { noteFieldError } from '../../../memory/memory-note';
import { memoryAuditHook } from '../../../memory/memory-audit';
import type { AuditRecorder } from '../../../audit/audit-recorder.service';
import {
  MemoryReplaceRefusedError,
  ownerTypeFor,
  type MemoryWriteGuard,
} from '../../../memory/memory-write.guard';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_ADD_MEMORY } from '../koda-tool-descriptors';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { asRecord } from './tool-input';

/**
 * Fleet S5b 2b1 US-006 (2b1-D4 to D7, 2b-R5): `koda_add_memory` proposes one non-decision memory item of the thread's
 * project and, once the user approves the proposal, stores it as the requester. A decision is never written here: it
 * goes through `koda_record_decision` (US-007), whose subject is the actor rather than a caller-chosen string. The
 * preview reads the item it would replace, so the user sees what the approval changes; a preview never writes.
 */

/** 2b1-D5: the memory kinds this tool accepts, in the descriptor's order — the four triples, plus the note
 * memory-notes US-002 added. DECISION is not one of them. */
const MEMORY_WRITE_KINDS = [
  MemoryKind.FACT,
  MemoryKind.PREFERENCE,
  MemoryKind.CONSTRAINT,
  MemoryKind.INCIDENT_PATTERN,
  MemoryKind.NOTE,
] as const;
export type MemoryWriteKind = (typeof MEMORY_WRITE_KINDS)[number];

/** 2b1-D5: `subject` and `predicate` are judged on their trimmed length; `object` only on its own. The descriptor
 * carries the same numbers. A note is judged by the note limits instead (`memory-note.ts`), not these. */
const MAX_KEY_CHARS = 200;
const MAX_OBJECT_CHARS = 4_000;

/** 2b1-D7: the confidence every memory a thread proposes is stored with. */
const THREAD_CONFIDENCE = 0.8;

/** One proposed memory item, as the parser accepted it. Every field is kept as written. */
export interface AddMemoryInput {
  kind: MemoryWriteKind;
  subject: string;
  predicate: string;
  object?: string;
  /** memory-notes US-002: a note's index line; a triple carries none. */
  description?: string;
}

const isMemoryWriteKind = (value: unknown): value is MemoryWriteKind =>
  typeof value === 'string' && (MEMORY_WRITE_KINDS as readonly string[]).includes(value);

/** Whether an item of this kind is a note, so the note limits replace the triple ones (US-002). */
const isNote = (kind: MemoryWriteKind): boolean => kind === MemoryKind.NOTE;

/**
 * `koda_add_memory` (2b1-D3): the memory item to remember in the thread's project. `execute` is what an approve runs:
 * it upserts through `PrismaMemoryItemRepository`, so the usual active-key supersession happens and the item is
 * readable by `koda_memory_search`.
 *
 * Permissions P2 US-003: `deps.audit` is the recorder the write records through. The tool sets no actor, approval or
 * `onBehalfOf` of its own: an approved action already runs as the assistant with the requester on behalf of, an MCP
 * call as the agent itself, and `record` copies whichever context it finds.
 */
export function addMemoryTool(deps: {
  memory: PrismaMemoryItemRepository;
  guard: MemoryWriteGuard;
  audit: AuditRecorder;
}): AssistantTool<AddMemoryInput> {
  return {
    descriptor: KODA_ADD_MEMORY,
    key: 'memory.create',
    // 2b1-D4: the memory write routes check project membership (`memory.controller.ts`), so this tool does too.
    kind: 'write',
    /**
     * 2b1-D5, 2b-R5: only the fields of the item are returned — a caller-supplied `ownerId` (or any other
     * key) is dropped here, before the value can reach a proposal, so the item can only ever be written as the
     * requester.
     *
     * memory-notes US-002: a note (slug, type, body, index line) is judged by `noteFieldError` — the one note
     * validator `POST /memory` also calls — so both write paths refuse the same field for the same bad input. Its
     * body is capped in UTF-8 bytes by the note limit, never by the triple tool's 4000-character one; a triple can
     * never carry an index line.
     */
    parse(input: unknown): AddMemoryInput {
      const raw = asRecord(input);
      const kind = raw['kind'];
      if (!isMemoryWriteKind(kind)) throw new ToolInputError('kind');
      const note = isNote(kind);
      const subject = raw['subject'];
      if (typeof subject !== 'string' || (!note && !withinChars(subject, 1, MAX_KEY_CHARS))) {
        throw new ToolInputError('subject');
      }
      const predicate = raw['predicate'];
      if (typeof predicate !== 'string' || (!note && !withinChars(predicate, 1, MAX_KEY_CHARS))) {
        throw new ToolInputError('predicate');
      }
      const object = optionalObject(raw['object'], note);
      const description = optionalDescription(raw['description']);
      const candidate = { kind, subject, predicate, object, description };
      if (note) {
        const problem = noteFieldError(candidate);
        if (problem !== null) throw new ToolInputError(problem);
        return { kind, subject, predicate, ...(object === undefined ? {} : { object }), description };
      }
      // The index line is a note's alone: any supplied description is refused, exactly as the REST write refuses it.
      if (noteFieldError(candidate) !== null) throw new ToolInputError('description');
      return { kind, subject, predicate, ...(object === undefined ? {} : { object }) };
    },
    /**
     * 2b1-D6: the text the user approves — the project slug, the key and then the object. When the project already
     * holds an active item of that key, the last line shows the item this approval replaces, so the user can see
     * what changes. The whole text is masked, because the key and the object are user-written.
     *
     * Permissions P1 US-008: the preview of a write that would supersede another principal's item is refused here,
     * before a proposal exists — `memory.update` with that item's owner is what an approval would need. The refusal is
     * a `forbidden` answer naming the key, not a proposal the user could approve into a failed action.
     */
    async preview(ctx: ToolContext, input: AddMemoryInput): Promise<string> {
      try {
        await deps.guard.assertMayReplace(ctx.actor, ctx.projectId, {
          kind: input.kind,
          subject: input.subject,
          predicate: input.predicate,
        });
      } catch (error) {
        if (error instanceof MemoryReplaceRefusedError) throw new ToolForbiddenError('memory.update');
        throw error;
      }
      const lines = [`Remember in ${ctx.projectSlug}: ${input.kind} ${input.subject} / ${input.predicate}`];
      // A note's index line comes before its body, the order the note itself is written in (US-002).
      if (input.description !== undefined) lines.push(input.description);
      if (input.object !== undefined) lines.push(input.object);
      const active = await deps.memory.findActive(ctx.projectId, input.kind, input.subject, input.predicate);
      if (active) lines.push(replacedLine(active));
      return maskSecrets(lines.join('\n'));
    },
    /**
     * 2b1-D7, 2b-R5: the item is stored in the action's project — never the thread's home project — as the requester,
     * from this thread, with the confidence a proposal carries. Task 2b-R2 keeps `koda_add_kb_doc` out of the catalog:
     * this table, not the legacy RAG table, is what `koda_memory_search` reads back.
     *
     * Permissions P1 US-008: the write runs the same in-transaction replace check the REST route runs, and records the
     * actor's owner type. A supersede the check refuses is the action's failure, not an exception the executor logs: a
     * concurrent write can forbid between the preview and the approve.
     */
    async execute(ctx: ToolContext, input: AddMemoryInput): Promise<string> {
      let item: MemoryItem;
      try {
        item = await deps.memory.upsert({
          projectId: ctx.projectId,
          kind: input.kind,
          subject: input.subject,
          predicate: input.predicate,
          ...(input.object === undefined ? {} : { object: input.object }),
          ...(input.description === undefined ? {} : { description: input.description }),
          sourceType: ctx.threadId === null ? 'mcp' : 'thread',
          sourceId: ctx.threadId ?? ctx.actor.id,
          confidence: THREAD_CONFIDENCE,
          ownerId: ctx.actor.id,
          ownerType: ownerTypeFor(ctx.actor),
        }, {
          beforeSupersede: deps.guard.replaceCheck(ctx.actor, ctx.projectId),
          // Permissions P2 US-003: the entry is recorded inside the upsert's own transaction, so a refused one
          // rolls the write back.
          onWritten: memoryAuditHook(deps.audit, 'memory.create'),
        });
      } catch (error) {
        if (error instanceof MemoryReplaceRefusedError) {
          throw new ToolActionError(`forbidden: memory:${error.itemId} needs memory.update`);
        }
        throw error;
      }
      return `memory:${item.id} saved`;
    },
  };
}

/**
 * The last line of a preview: the item this approval replaces. A triple shows its value, because that is what the
 * user compares; a note is named by its id alone, because its body is Markdown the approval text does not need to
 * repeat (US-002).
 */
function replacedLine(active: MemoryItem): string {
  // An item with no object is named alone; an empty string is no object (the read tool reads it the same way).
  return active.kind === MemoryKind.NOTE || !active.object
    ? `Replaces memory:${active.id}`
    : `Replaces memory:${active.id}: ${active.object}`;
}

/**
 * An absent object, or a string judged after trim; anything else is the named refusal (2b1-D5). A triple's value is
 * capped here; a note's body is judged in UTF-8 bytes by `noteFieldError` instead (US-002).
 */
function optionalObject(value: unknown, note: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (!note && !withinChars(value, 0, MAX_OBJECT_CHARS))) {
    throw new ToolInputError('object');
  }
  return value;
}

/** An absent description, or the string a note's index line is judged from; `null` is how JSON spells "no value". */
function optionalDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError('description');
  return value;
}

/** 2b1-D5: the trimmed length is what is judged; the value itself is stored as written. */
const withinChars = (text: string, min: number, max: number): boolean => {
  const length = text.trim().length;
  return length >= min && length <= max;
};
