import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppException } from '@nathapp/nestjs-common';
import type { AgentPrincipal, UserPrincipal } from '../../../auth/principal/koda-principal.types';
import { FleetPrRulingsService } from '../../rulings/fleet-pr-rulings.service';
import type { CreateRulingInput } from '../../rulings/fleet-pr-ruling.domain';
import { parseRulingText } from '../../rulings/ruling-keyword';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_LIST_PR_RULINGS, KODA_RULE_PR_ITEM } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool } from '../assistant-tool.types';
import { asRecord } from './tool-input';

interface JobInput { jobId: string }
interface RuleInput extends JobInput, CreateRulingInput {}

/** The command adapter gates this write once; the shared service owns eligibility and the transaction. */
@Injectable()
export class PrRulingTools implements OnModuleInit {
  constructor(private readonly registry: AssistantToolRegistry, private readonly rulings: FleetPrRulingsService) {}

  onModuleInit(): void {
    const read: AssistantTool<JobInput> = {
      descriptor: KODA_LIST_PR_RULINGS, key: 'fleet.job.read',
      parse(raw) { return { jobId: requiredString(asRecord(raw)['jobId'], 'jobId', 64) }; },
      execute: async (ctx, input) => {
        const rows = await this.rulings.list(ctx.projectId, input.jobId);
        return rows.map(r => ctx.data(`${r.itemId} ${r.disposition} ${r.state} ${r.actorType}:${r.actorId}`)).join('\n');
      },
    };
    const write: AssistantTool<RuleInput> = {
      descriptor: KODA_RULE_PR_ITEM, key: 'fleet.job.rule', kind: 'write',
      parse(raw) {
        const obj = asRecord(raw);
        const jobId = requiredString(obj['jobId'], 'jobId', 64);
        const itemId = requiredString(obj['itemId'], 'itemId', 64);
        if (!/^[A-Za-z0-9._:-]+$/.test(itemId)) throw new ToolInputError('itemId');
        const text = requiredString(obj['text'], 'text', 2000);
        if (!parseRulingText(text)) throw new ToolInputError('text');
        return { jobId, itemId, text };
      },
      preview: async (ctx, { jobId, ...dto }) => {
        try {
          await this.rulings.preflight(ctx.projectId, jobId, dto);
        } catch (error) {
          const reason = rulingRefusal(error);
          if (reason === null) throw error;
          throw new ToolInputError(reason);
        }
        const parsed = parseRulingText(dto.text);
        if (!parsed) throw new ToolInputError('text');
        return maskSecrets(`Rule job ${jobId}, item ${dto.itemId}: ${parsed.disposition}\n${dto.text}`);
      },
      execute: async (ctx, { jobId, ...dto }) => {
        await this.preflightInTool(ctx.projectId, jobId, dto);
        return this.createRuling(ctx.actor, ctx.projectSlug, jobId, dto);
      },
      /**
       * US-014 F1: a deferred (approval-held) ruling runs this before the engine opens its transaction, so the
       * item-index forge read never holds the approval lock. `create` still rechecks eligibility under it.
       */
      prepare: async (ctx, { jobId, ...dto }) => {
        await this.preflightInTool(ctx.projectId, jobId, dto);
        return () => this.createRuling(ctx.actor, ctx.projectSlug, jobId, dto);
      },
    };
    this.registry.register(read, write);
  }

  /** The tool's own preflight, refused the way an execution refusal reads. */
  private async preflightInTool(projectId: string, jobId: string, dto: CreateRulingInput): Promise<void> {
    try {
      await this.rulings.preflight(projectId, jobId, dto);
    } catch (error) {
      const reason = rulingRefusal(error);
      if (reason === null) throw error;
      throw new ToolActionError(reason);
    }
  }

  /** The ruling write; a refusal discovered inside `create` reads the same way. */
  private async createRuling(actor: UserPrincipal | AgentPrincipal, projectSlug: string, jobId: string, dto: CreateRulingInput): Promise<string> {
    try {
      const ruling = await this.rulings.create(actor, projectSlug, jobId, dto);
      return `ruling ${ruling.id}: ${ruling.state}`;
    } catch (error) {
      const reason = rulingRefusal(error);
      if (reason === null) throw error;
      throw new ToolActionError(reason);
    }
  }
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ToolInputError(field);
  return value;
}

function rulingRefusal(error: unknown): string | null {
  if (!(error instanceof AppException)) return null;
  switch (error.prefix) {
    case 'fleet.rulings.unknownItem': return 'unknown item';
    case 'fleet.rulings.notDraft': return 'job is not a draft RUN';
    case 'fleet.rulings.notLatest': return 'job is not the latest RUN';
    case 'fleet.rulings.settled': return 'item ruling is already applied';
    case 'fleet.rulings.notRulable': return 'CI items cannot be ruled';
    case 'fleet.rulings.noItemIndex': return 'pull request has no nax item index';
    case 'fleet.rulings.invalidText': return 'text';
    default: return null;
  }
}
