import { Inject, Injectable } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus } from '../../common/enums';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetJobTicketDto } from './dto/ticket-fleet-job.dto';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import { parseDispatchRefs } from './ticket-refs';

/** Who a RUN dispatch moves tickets as (spec §3.1, D452). */
export interface TicketActor {
  principal: KodaPrincipal;
  projectSlug: string;
}

export interface DispatchTicket {
  id: string;
  ref: string;
  title: string;
  status: string;
}

const NOT_LINKABLE: ReadonlySet<string> = new Set([TicketStatus.CLOSED, TicketStatus.REJECTED]);

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.dispatchInput');
}

/** Fleet C9: ticket links of fleet jobs (spec §2). */
@Injectable()
export class FleetTicketsService {
  constructor(
    private readonly repo: PrismaFleetTicketsRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** D450: validated before the dispatch transaction; throws 400 naming the first bad ref. */
  async resolveForDispatch(projectId: string, refs: readonly string[] | undefined): Promise<DispatchTicket[]> {
    if (!refs || refs.length === 0) return [];
    const project = await this.repo.findProject(projectId);
    if (!project) fail('project');
    const parsed = parseDispatchRefs(refs, project.key);
    const rows = await this.repo.findTicketsByNumbers(projectId, parsed.map((p) => p.number));
    return parsed.map((p) => {
      const row = rows.find((r) => r.number === p.number);
      if (!row || row.deletedAt !== null || NOT_LINKABLE.has(row.status)) fail(`ticket ${p.ref}`);
      return { id: row.id, ref: p.ref, title: row.title, status: row.status };
    });
  }

  /** Call inside the dispatch transaction (D450). */
  async link(jobId: string, tickets: readonly DispatchTicket[]): Promise<void> {
    await this.repo.linkTickets(jobId, tickets.map((t) => t.id));
  }

  async forJob(jobId: string): Promise<FleetJobTicketDto[]> {
    const rows = await this.repo.findTicketsForJob(jobId);
    return rows.map((t) => Object.assign(new FleetJobTicketDto(), { ref: t.ref, title: t.title, status: t.status }));
  }
}
