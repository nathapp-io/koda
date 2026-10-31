import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetRepoRecord } from '../domain/fleet-repo.domain';

export class FleetRepoDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty({ enum: ['github', 'gitlab'] }) declare provider: 'github' | 'gitlab';
  @ApiProperty() declare owner: string;
  @ApiProperty() declare name: string;
  @ApiProperty() declare defaultBranch: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'GitHub App installation id (BigInt as string)' })
  declare githubInstallationId: string | null;
  @ApiProperty() declare createdAt: string;
  @ApiProperty() declare autoReview: boolean;
  @ApiProperty({ type: [String] }) declare autoReviewProfiles: string[];
  @ApiProperty() declare autoReviewMaxCostUsd: string;
  @ApiPropertyOptional({ nullable: true }) declare autoReviewEnabledById: string | null;
  @ApiPropertyOptional({ enum: ['USER', 'AGENT'], nullable: true }) declare autoReviewEnabledByType: 'USER' | 'AGENT' | null;
  @ApiPropertyOptional({ nullable: true }) declare autoReviewEnabledAt: string | null;

  static from(r: FleetRepoRecord): FleetRepoDto {
    return Object.assign(new FleetRepoDto(), {
      id: r.id, projectId: r.projectId, provider: r.provider as FleetRepoDto['provider'], owner: r.owner, name: r.name,
      defaultBranch: r.defaultBranch, githubInstallationId: r.githubInstallationId === null ? null : r.githubInstallationId.toString(),
      createdAt: r.createdAt.toISOString(), autoReview: r.autoReview, autoReviewProfiles: r.autoReviewProfiles,
      autoReviewMaxCostUsd: Number(r.autoReviewMaxCostUsd).toFixed(4), autoReviewEnabledById: r.autoReviewEnabledById,
      autoReviewEnabledByType: r.autoReviewEnabledByType,
      autoReviewEnabledAt: r.autoReviewEnabledAt?.toISOString() ?? null,
    });
  }
}
