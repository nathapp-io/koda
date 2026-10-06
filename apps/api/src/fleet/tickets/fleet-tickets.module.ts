import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetTicketsService } from './fleet-tickets.service';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

/** Fleet C9 (spec docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaFleetTicketsRepository, FleetTicketsService],
  exports: [PrismaFleetTicketsRepository, FleetTicketsService],
})
export class FleetTicketsModule {}
