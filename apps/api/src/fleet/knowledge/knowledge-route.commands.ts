import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { KnowledgeIndexAdmin } from './knowledge-index-admin.service';
import { parseKnowledgePatterns } from './knowledge-patterns';

export const KNOWLEDGE_ROUTE_VARIANTS = {
  patterns: 'rest:project-knowledge.patterns',
  reindex: 'rest:project-knowledge.reindex',
} as const;

type ProjectInput = { slug: string; projectId: string };

@Injectable()
export class KnowledgeRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly knowledgeAdmin: KnowledgeIndexAdmin,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<ProjectInput & { patterns: string[] | null }, Awaited<ReturnType<KnowledgeIndexAdmin['savePatterns']>>>({
      key: 'fleet.knowledge.patterns.update', variant: KNOWLEDGE_ROUTE_VARIANTS.patterns,
      parse: (input) => {
        const ids = parseRouteInput(input, ['slug', 'projectId']);
        const { patterns } = input as { patterns?: unknown };
        if (patterns === null) return { ...ids, patterns: null };
        // strictNullChecks is off in this app, so use the parser's common optional shape for narrowing.
        const parsed: { ok: boolean; value?: string[]; reason?: string } = parseKnowledgePatterns(patterns);
        if (!parsed.ok) throw new ValidationAppException({ reason: parsed.reason }, 'knowledge.input');
        return { ...ids, patterns: parsed.value ?? [] };
      },
      run: (_principal, input) => this.knowledgeAdmin.savePatterns(input.projectId, input.patterns),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<ProjectInput & { repoId: string }, Awaited<ReturnType<KnowledgeIndexAdmin['reindex']>>>({
      key: 'fleet.knowledge.repo.reindex', variant: KNOWLEDGE_ROUTE_VARIANTS.reindex,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'repoId']),
      run: (_principal, input) => this.knowledgeAdmin.reindex(input.projectId, input.repoId),
      toResult: (result) => result,
    }, this.loader));
  }
}
