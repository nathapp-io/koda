import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { timelineControllerGetTimeline, memoryControllerRecordDecision, memoryControllerCreateMemory, projectsControllerFindBySlug } from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

/**
 * The memory write endpoints take a project *ID*, not a slug — unlike most
 * of the API which resolves the slug server-side from the URL path.
 */
async function resolveProjectId(slug: string): Promise<string> {
  const response = await projectsControllerFindBySlug({ slug });
  const project = unwrap<{ id: string }>(response);
  return project.id;
}

export function memoryCommand(program: Command): void {
  const memory = program.command('memory');
  memory.description('View project memory and timeline');

  memory
    .command('timeline')
    .description('List the event timeline for a project')
    .option('--project <slug>', 'Project slug')
    .option('--actor-id <id>', 'Filter by actor (user or agent) ID')
    .option('--ticket-id <id>', 'Filter by ticket ID')
    .option('--from <iso>', 'Start of time range (ISO 8601)')
    .option('--to <iso>', 'End of time range (ISO 8601)')
    .option('--limit <n>', 'Maximum number of events to return (default: 50)', '50')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await timelineControllerGetTimeline({
          slug: ctx.projectSlug,
          actorId: options.actorId,
          ticketId: options.ticketId,
          from: options.from,
          to: options.to,
          limit: options.limit,
          cursor: options.cursor,
        });
        const raw = unwrap<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(response);
        const items: Array<Record<string, unknown>> = Array.isArray(raw)
          ? raw
          : ((raw as { items?: Array<Record<string, unknown>> }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((e) => [
            String(e['type'] ?? e['action'] ?? ''),
            String(e['actorId'] ?? e['actorUserId'] ?? e['actorAgentId'] ?? ''),
            String(e['ticketId'] ?? ''),
            String(e['createdAt'] ?? ''),
          ]);
          table(['Type', 'Actor', 'Ticket', 'Time'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  memory
    .command('decisions')
    .description('Record a decision to project memory')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--actor-id <id>', 'ID of the user or agent making the decision')
    .requiredOption('--topic <topic>', 'Short topic/subject of the decision')
    .requiredOption('--decision <text>', 'The decision that was made')
    .option('--rationale <text>', 'Why the decision was made')
    .option('--source-id <id>', 'ID of the source record this decision came from')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const projectId = await resolveProjectId(ctx.projectSlug);

        const response = await memoryControllerRecordDecision({
          requestBody: {
            projectId,
            actorId: options.actorId,
            topic: options.topic,
            decision: options.decision,
            rationale: options.rationale,
            sourceId: options.sourceId,
          },
        });
        const result = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('Decision recorded.');
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  memory
    .command('create')
    .description('Write a memory item (fact, decision, preference, constraint, or incident pattern)')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--kind <kind>', 'Memory kind: FACT, DECISION, PREFERENCE, CONSTRAINT, or INCIDENT_PATTERN')
    .requiredOption('--subject <subject>', 'Subject of the memory item')
    .requiredOption('--predicate <predicate>', 'Predicate — the relationship or statement about the subject')
    .option('--object <object>', 'Object — the value/target of the predicate')
    .option('--source-type <type>', 'Where this memory item came from (defaults to "manual")')
    .option('--source-id <id>', 'ID of the source record this memory item came from')
    .option('--confidence <n>', 'Confidence score between 0 and 1 (defaults to 0.8)')
    .option('--owner-id <id>', 'ID of the user/agent who owns this memory item (defaults to the caller)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });
        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const projectId = await resolveProjectId(ctx.projectSlug);

        const response = await memoryControllerCreateMemory({
          requestBody: {
            projectId,
            kind: options.kind,
            subject: options.subject,
            predicate: options.predicate,
            object: options.object,
            sourceType: options.sourceType,
            sourceId: options.sourceId,
            confidence: options.confidence !== undefined ? Number(options.confidence) : undefined,
            ownerId: options.ownerId,
          },
        });
        const result = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('Memory item created.');
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
