import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Fleet S4b US-005: everything the anonymous invite page may learn before the
 * visitor has an account. Exactly six fields — no invite id, no token, no
 * project id.
 */
export class InvitePreviewDto {
  @ApiProperty() declare projectName: string;
  @ApiProperty() declare projectSlug: string;
  @ApiProperty() declare email: string;
  @ApiProperty() declare role: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare inviterName: string | null;
  @ApiProperty() declare expiresAt: Date;
}
