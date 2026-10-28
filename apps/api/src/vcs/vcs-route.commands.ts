import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { VCS_CFG, type IVcsConfig } from '../config/vcs.config';
import { VcsConnectionService } from './vcs-connection.service';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';

export const VCS_ROUTE_VARIANTS = { delete: 'rest:vcs.delete', test: 'rest:vcs.test' } as const;

@Injectable()
export class VcsRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly vcs: VcsConnectionService,
    private readonly loader: ActorPrincipalLoader,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ projectId: string }, null>({
      key: 'vcs.connection.delete', variant: VCS_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['projectId']),
      run: async (_principal, input) => {
        await this.vcs.delete(input.projectId);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ projectId: string }, TestConnectionResultDto>({
      key: 'vcs.connection.test', variant: VCS_ROUTE_VARIANTS.test,
      parse: (input) => parseRouteInput(input, ['projectId']),
      prepare: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.prepareTestConnection(input.projectId, key);
      },
      run: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.testConnection(input.projectId, key);
      },
      toResult: (result) => result,
    }, this.loader));
  }
}
