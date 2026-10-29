import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { committedEffect } from '../../common/committed-effects';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeIndexQueue } from './knowledge-index.queue';

/** Audited knowledge writes shared by immediate and approved route execution. */
@Injectable()
export class KnowledgeIndexAdmin {
  constructor(
    private readonly index: KnowledgeIndexService,
    private readonly queue: KnowledgeIndexQueue,
    private readonly audit: AuditRecorder,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'knowledgeIndexEnabled'>,
  ) {}

  async savePatterns(projectId: string, patterns: string[] | null) {
    const saved = await this.index.savePatterns(projectId, patterns);
    if (!this.config.knowledgeIndexEnabled) return { ...saved, queued: 0 };
    const repos = await this.index.listProjectRepos(projectId);
    for (const repo of repos) committedEffect(() => this.queue.enqueue(repo.id, 'admin'));
    return { ...saved, queued: repos.length };
  }

  async reindex(projectId: string, repoId: string) {
    // A request can wait across a kill-switch change; never settle executed for a dropped pass.
    if (!this.config.knowledgeIndexEnabled) throw new ConflictAppException({}, 'knowledge.disabled');
    const repo = await this.index.resolveProjectRepo(projectId, { repoId });
    if (!repo) throw new NotFoundAppException({}, 'knowledge.repoNotFound');
    await this.audit.audited(async () => undefined, () => ({
      key: 'fleet.knowledge.repo.reindex', resourceType: 'fleet-repo', resourceId: repo.id,
      projectId, summary: 'reindex queued',
    }));
    committedEffect(() => this.queue.enqueue(repo.id, 'admin'));
    return { queued: true };
  }
}
