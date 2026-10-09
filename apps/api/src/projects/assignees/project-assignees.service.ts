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
 * the service only validates the query and maps the rows.
 */
@Injectable()
export class ProjectAssigneesService {
  constructor(
    @Inject(PROJECT_ASSIGNEES_REPOSITORY)
    private readonly assignees: IProjectAssigneesRepository,
  ) {}

  async search(projectId: string, query: AssigneeQuery): Promise<AssigneeListDto> {
    const items = await this.assignees.search(projectId, query.q, query.limit);
    return { items: items.map(AssigneeDto.from) };
  }
}
