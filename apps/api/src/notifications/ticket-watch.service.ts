import { Injectable } from '@nestjs/common';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketWatchersRepository } from './ticket-watchers.repository';
import type { WatchStateDto } from './dto/watch-state.dto';

/** Fleet S4a §3 (D502): the caller's watch on one ticket. Unwatch is a sticky mute. */
@Injectable()
export class TicketWatchService {
  constructor(private readonly repo: TicketWatchersRepository, private readonly audit: AuditRecorder) {}

  async state(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    return this.repo.state(await this.ticketId(projectId, ref), userId);
  }

  async watch(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    const ticketId = await this.ticketId(projectId, ref);
    return this.audit.audited(async () => {
      await this.repo.watch(ticketId, userId);
      return this.repo.state(ticketId, userId);
    }, () => [{ key: 'ticket.watch.set', resourceType: 'ticket', resourceId: ticketId, projectId, summary: 'watching' }]);
  }

  async unwatch(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    const ticketId = await this.ticketId(projectId, ref);
    return this.audit.audited(async () => {
      await this.repo.unwatch(ticketId, userId);
      return this.repo.state(ticketId, userId);
    }, () => [{ key: 'ticket.watch.unset', resourceType: 'ticket', resourceId: ticketId, projectId, summary: 'muted' }]);
  }

  private async ticketId(projectId: string, ref: string): Promise<string> {
    const id = await this.repo.findTicketIdByRef(projectId, ref);
    if (!id) throw new NotFoundAppException({}, 'tickets');
    return id;
  }
}
