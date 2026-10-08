import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketWatchersRepository } from './ticket-watchers.repository';
import type { WatchStateDto } from './dto/watch-state.dto';

/** Fleet S4a §3 (D502): the caller's watch on one ticket. Unwatch is a sticky mute. */
@Injectable()
export class TicketWatchService {
  constructor(private readonly repo: TicketWatchersRepository) {}

  async state(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    return this.repo.state(await this.ticketId(projectId, ref), userId);
  }

  async watch(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    const ticketId = await this.ticketId(projectId, ref);
    await this.repo.watch(ticketId, userId);
    return this.repo.state(ticketId, userId);
  }

  async unwatch(projectId: string, ref: string, userId: string): Promise<WatchStateDto> {
    const ticketId = await this.ticketId(projectId, ref);
    await this.repo.unwatch(ticketId, userId);
    return this.repo.state(ticketId, userId);
  }

  private async ticketId(projectId: string, ref: string): Promise<string> {
    const id = await this.repo.findTicketIdByRef(projectId, ref);
    if (!id) throw new NotFoundAppException({}, 'tickets');
    return id;
  }
}
