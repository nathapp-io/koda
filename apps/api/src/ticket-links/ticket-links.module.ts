import { Module } from '@nestjs/common';
import { TicketLinksController } from './ticket-links.controller';
import { TicketLinksService } from './ticket-links.service';

@Module({
  controllers: [TicketLinksController],
  providers: [TicketLinksService],
})
export class TicketLinksModule {}
