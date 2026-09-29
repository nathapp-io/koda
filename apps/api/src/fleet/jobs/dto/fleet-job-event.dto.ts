import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetJobEventRecord } from '../domain/fleet-job.domain';

export class FleetJobEventDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ description: 'Server timeline order' }) declare seq: number;
  @ApiProperty() declare leaseEpoch: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Runner sequence; null for server events' }) declare runnerSeq: number | null;
  @ApiProperty({ enum: ['state', 'snapshot', 'lifecycle', 'log'] }) declare type: string;
  @ApiProperty({ type: Object }) declare payload: unknown;
  @ApiProperty() declare createdAt: string;

  static from(r: FleetJobEventRecord): FleetJobEventDto {
    return Object.assign(new FleetJobEventDto(), {
      id: r.id, seq: r.seq, leaseEpoch: r.leaseEpoch, runnerSeq: r.runnerSeq, type: r.type, payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    });
  }
}
