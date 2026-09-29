import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetActivityRecord } from '../domain/fleet-activity.domain';

export class FleetActivityDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: ['USER', 'RUNNER', 'SYSTEM'] }) declare actorType: 'USER' | 'RUNNER' | 'SYSTEM';
  @ApiProperty() declare actorId: string;
  @ApiProperty() declare action: string;
  @ApiProperty() declare entityType: string;
  @ApiProperty() declare entityId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare jobId: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) declare responsibleUserId: string | null;
  @ApiProperty({ type: Object }) declare payload: Record<string, unknown>;
  @ApiProperty() declare createdAt: string;

  static from(r: FleetActivityRecord): FleetActivityDto {
    return Object.assign(new FleetActivityDto(), {
      id: r.id,
      actorType: r.actorType as FleetActivityDto['actorType'],
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      jobId: r.jobId,
      responsibleUserId: r.responsibleUserId,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    });
  }
}
