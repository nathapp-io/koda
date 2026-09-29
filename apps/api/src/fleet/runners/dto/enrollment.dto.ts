import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EnrollmentRecord } from '../domain/runner.domain';

export class EnrollmentDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare expiresAt: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare usedAt: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) declare runnerId: string | null;
  @ApiProperty() declare createdById: string;
  @ApiProperty() declare createdAt: string;

  static from(r: EnrollmentRecord): EnrollmentDto {
    return Object.assign(new EnrollmentDto(), {
      id: r.id, labels: r.labels, expiresAt: r.expiresAt.toISOString(), usedAt: r.usedAt?.toISOString() ?? null,
      runnerId: r.runnerId, createdById: r.createdById, createdAt: r.createdAt.toISOString(),
    });
  }
}

export class EnrollmentCreatedDto extends EnrollmentDto {
  @ApiProperty({ description: 'Shown once; koda stores only its hash' }) declare token: string;

  static from(r: EnrollmentRecord, token?: string): EnrollmentCreatedDto {
    return Object.assign(new EnrollmentCreatedDto(), EnrollmentDto.from(r), { token });
  }
}
