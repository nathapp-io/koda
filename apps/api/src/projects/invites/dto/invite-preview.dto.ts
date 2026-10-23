import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Everything the anonymous invite page may learn before the visitor has an
 * account. Exactly seven fields — no legacy role, invite id, token, or project id.
 */
export class InvitePreviewDto {
  @ApiProperty() declare projectName: string;
  @ApiProperty() declare projectSlug: string;
  @ApiProperty() declare email: string;
  @ApiProperty({ nullable: true, type: String }) declare roleKey: string | null;
  @ApiProperty({ nullable: true, type: String }) declare roleName: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) declare inviterName: string | null;
  @ApiProperty() declare expiresAt: Date;
}
