import { ApiProperty } from '@nestjs/swagger';
import type { FleetPrRuling } from '../fleet-pr-ruling.domain';

export class FleetPrRulingDto implements FleetPrRuling {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare repoId: string;
  @ApiProperty() declare prNumber: number;
  @ApiProperty() declare jobId: string;
  @ApiProperty() declare itemId: string;
  @ApiProperty() declare itemKind: string;
  @ApiProperty() declare text: string;
  @ApiProperty({ enum: ['fixed', 'waived', 'overridden', 'confirmed', 'verified'] }) declare disposition: FleetPrRuling['disposition'];
  @ApiProperty({ enum: ['USER', 'AGENT'] }) declare actorType: FleetPrRuling['actorType'];
  @ApiProperty() declare actorId: string;
  @ApiProperty({ enum: ['pending', 'applied', 'skipped', 'replaced'] }) declare state: FleetPrRuling['state'];
  @ApiProperty({ type: String, nullable: true }) declare skipReason: string | null;
  @ApiProperty({ type: String, nullable: true }) declare appliedJobId: string | null;
  @ApiProperty({ type: String, nullable: true }) declare commentId: string | null;
  @ApiProperty({ type: String, nullable: true }) declare approvalRequestId: string | null;
  @ApiProperty() declare createdAt: Date;
  @ApiProperty() declare updatedAt: Date;

  static from(row: FleetPrRuling): FleetPrRulingDto { return Object.assign(new FleetPrRulingDto(), row); }
}
