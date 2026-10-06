import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { addUsd } from '../../budgets/money';
import type { TicketJobRow } from '../prisma-fleet-tickets.repository';

/** A ticket linked to a fleet job (spec §2.2). */
export class FleetJobTicketDto {
  @ApiProperty({ description: 'Ticket ref, KEY-N' }) declare ref: string;
  @ApiProperty() declare title: string;
  @ApiProperty() declare status: string;
}

/** A fleet job linked to a ticket, read live from FleetJob (spec §2.2, D460). */
export class TicketFleetJobDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) declare command: string;
  @ApiProperty() declare feature: string;
  @ApiProperty() declare state: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare stateReason: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare escalationReason: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultBranch: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultSha: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultPrUrl: string | null;
  @ApiProperty({ description: 'USD spent across all attempts (costSpentUsd + costCarriedUsd)' }) declare costUsd: string;
  @ApiProperty() declare queuedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishedAt: string | null;

  static from(r: TicketJobRow): TicketFleetJobDto {
    return Object.assign(new TicketFleetJobDto(), {
      id: r.id, command: r.command, feature: r.feature, state: r.state, stateReason: r.stateReason,
      escalationReason: r.escalationReason, resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl,
      costUsd: addUsd(r.costSpentUsd, r.costCarriedUsd), queuedAt: r.queuedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    });
  }
}
