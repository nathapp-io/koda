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

  static from(r: FleetRepoRecord): FleetRepoDto {
    return Object.assign(new FleetRepoDto(), {
      id: r.id, projectId: r.projectId, provider: r.provider as FleetRepoDto['provider'], owner: r.owner, name: r.name,
      defaultBranch: r.defaultBranch, githubInstallationId: r.githubInstallationId === null ? null : r.githubInstallationId.toString(),
      createdAt: r.createdAt.toISOString(),
    });
  }
}
