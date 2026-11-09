import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The repo a flow runs against: enough to build a PR link, and nothing else. */
export class FleetFlowRepoDto {
  @ApiProperty() declare provider: string;
  @ApiProperty() declare owner: string;
  @ApiProperty() declare name: string;
}

/** One job of a flow, as the flow page shows it. */
export class FleetFlowJobDto {
  @ApiProperty() declare id: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare feature: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare step: string | null;
  @ApiProperty() declare command: string;
  @ApiProperty() declare state: string;
  @ApiProperty({ description: 'Decimal as string' }) declare costUsd: string;
  @ApiProperty() declare queuedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishedAt: string | null;
}

/**
 * What the flow record does not hold: the repo the flow runs against, the ref of the ticket the flow
 * tracks, the flow's jobs and how many of them have no known cost.
 */
export class FleetFlowOverviewDto {
  @ApiPropertyOptional({ type: () => FleetFlowRepoDto, nullable: true }) declare repo: FleetFlowRepoDto | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare ticketRef: string | null;
  @ApiProperty({ type: () => [FleetFlowJobDto] }) declare jobs: FleetFlowJobDto[];
  @ApiProperty() declare truncated: boolean;
  @ApiProperty() declare unknownCostCount: number;
}
