import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { AstIndexService, type SymbolIndexResult } from './ast-index.service';
import { IndexCommitDto } from './dto/index-commit.dto';

export const CODE_INTEL_ROUTE_VARIANTS = { index: 'rest:code-intel.index' } as const;

@Injectable()
export class CodeIntelRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly astIndex: AstIndexService,
    private readonly audit: AuditRecorder,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ projectId: string; index: IndexCommitDto }, SymbolIndexResult>({
      key: 'codeintel.index.write', variant: CODE_INTEL_ROUTE_VARIANTS.index,
      parse: (input) => {
        const { projectId } = parseRouteInput(input, ['projectId']);
        const source = input as Record<string, unknown>;
        return { projectId, index: parseBody(IndexCommitDto, source.index ?? {}) };
      },
      run: (_principal, { projectId, index }) => this.astIndex.indexCommit(
        index.repoId, index.commitHash, index.files, projectId,
        (indexed) => this.audit.record({
          key: 'codeintel.index.write',
          resourceType: 'code-repo',
          resourceId: index.repoId,
          projectId,
          summary: `indexed ${indexed.symbolsIndexed} symbols in ${indexed.filesIndexed} files`,
        }),
      ),
      toResult: (result) => result,
    }, this.loader));
  }
}
