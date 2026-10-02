import { ApiProperty } from '@nestjs/swagger';

export class ProjectApprovalCountDto {
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare slug: string;
  @ApiProperty() declare pending: number;
}

/** Plan D235: pending approvals over the caller's memberships; `unscoped` only for a global ADMIN. */
export class ApprovalCountsDto {
  @ApiProperty() declare total: number;
  @ApiProperty() declare unscoped: number;
  @ApiProperty({ type: [ProjectApprovalCountDto] }) declare projects: ProjectApprovalCountDto[];
}
