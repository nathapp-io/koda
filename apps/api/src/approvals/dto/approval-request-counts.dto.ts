import { ApiProperty } from '@nestjs/swagger';

export class ProjectApprovalRequestCountDto {
  @ApiProperty() declare projectId: string;
  @ApiProperty({ type: String, nullable: true }) declare slug: string | null;
  @ApiProperty() declare pending: number;
}

export class ApprovalRequestCountsDto {
  @ApiProperty() declare total: number;
  @ApiProperty() declare unscoped: number;
  @ApiProperty({ type: [ProjectApprovalRequestCountDto] }) declare projects: ProjectApprovalRequestCountDto[];
}
