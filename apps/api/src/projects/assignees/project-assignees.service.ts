import { PermissionService } from '../../permissions/permission.service';
import { Inject, Injectable } from '@nestjs/common';
import { AssigneeDto, AssigneeListDto } from './dto/assignee.dto';
import { AssigneeQuery } from './dto/assignee.query';
import {
  IProjectAssigneesRepository,
  PROJECT_ASSIGNEES_REPOSITORY,
} from './domain/project-assignee.domain';

/**
 * S4c US-004: the assignee typeahead. Membership is enforced by
 * `ProjectMembershipGuard` on the route, which also resolved the project, so
 * the service enumerates project.read holders and maps the rows.
 */
@Injectable()
export class ProjectAssigneesService {
  constructor(
    @Inject(PROJECT_ASSIGNEES_REPOSITORY)
    private readonly assignees: IProjectAssigneesRepository,
    private readonly permissions: PermissionService,
  ) {}

  async search(projectId: string, query: AssigneeQuery): Promise<AssigneeListDto> {
    const [userIds, agentIds] = await Promise.all([
      this.permissions.principalIdsWithKey('USER', projectId, 'project.read'),
      this.permissions.principalIdsWithKey('AGENT', projectId, 'project.read'),
    ]);
    const items = await this.assignees.search(projectId, query.q, query.limit, { userIds, agentIds });
    return { items: items.map(AssigneeDto.from) };
  }
}
