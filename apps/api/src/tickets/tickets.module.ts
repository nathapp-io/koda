import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';

@Module({
  controllers: [TicketsController],
  providers: [TicketsService, TicketTransitionsService],
  exports: [TicketsService, TicketTransitionsService],
})
export class TicketsModule {}
