import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus } from '../../common/enums';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetJobTicketDto } from './dto/ticket-fleet-job.dto';
import { TicketFleetJobDto } from './dto/ticket-fleet-job.dto';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import type { OpenVcsPrLink } from './prisma-fleet-tickets.repository';
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
    private readonly events: FleetTicketEventRecorder,
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

  /** #231: open VCS PR links on the given ticket ids, so a RUN dispatch can refuse to add a second PR. */
  async findOpenVcsPrLinks(ticketIds: readonly string[]): Promise<OpenVcsPrLink[]> {
    return this.repo.findOpenVcsPrLinks(ticketIds);
  }

  async forJob(jobId: string): Promise<FleetJobTicketDto[]> {
    const rows = await this.repo.findTicketsForJob(jobId);
    return rows.map((t) => Object.assign(new FleetJobTicketDto(), { ref: t.ref, title: t.title, status: t.status }));
  }

  static readonly LIST_LIMIT = 50;   // D460

  async listForTicket(projectId: string, ref: string): Promise<TicketFleetJobDto[]> {
    const ticketId = await this.ticketIdOf(projectId, ref);
    const rows = await this.repo.findJobsForTicket(ticketId, FleetTicketsService.LIST_LIMIT);
    return rows.map(TicketFleetJobDto.from);
  }

  /** D459: the join row and that job's fleet links on this ticket; history stays. */
  async unlink(projectId: string, ref: string, jobId: string, actorId: string): Promise<void> {
    const ticketId = await this.ticketIdOf(projectId, ref);
    await this.txManager.run(async () => {
      if (!(await this.repo.unlink(jobId, ticketId))) throw new NotFoundAppException({}, 'fleet.ticketJobs');
      await this.events.record({ projectId, ticketId, action: 'TICKET_UPDATED', actorId, data: { fleetJobUnlinked: jobId } });
    });
  }

  private async ticketIdOf(projectId: string, ref: string): Promise<string> {
    const project = await this.repo.findProject(projectId);
    const ticket = project ? await this.repo.findTicketByRef(projectId, project.key, ref) : null;
    if (!ticket) throw new NotFoundAppException({}, 'tickets');
    return ticket.id;
  }
}
