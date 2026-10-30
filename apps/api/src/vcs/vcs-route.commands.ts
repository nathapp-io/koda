import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { redactSecret } from '../approvals/route/redact-secret';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { VCS_CFG, type IVcsConfig } from '../config/vcs.config';
import { VcsConnectionService } from './vcs-connection.service';
import type { ApplyPrStatusesResult } from './vcs-pr-sync.service';
import { VcsManualSync } from './vcs-manual-sync.service';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { VcsConnectionCreatedResponseDto } from './dto/vcs-connection-response.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';

export const VCS_ROUTE_VARIANTS = { create: 'rest:vcs.create', delete: 'rest:vcs.delete', test: 'rest:vcs.test', syncIssue: 'rest:vcs.sync-issue', syncAll: 'rest:vcs.sync-all', syncPr: 'rest:vcs.sync-pr' } as const;

@Injectable()
export class VcsRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly vcs: VcsConnectionService,
    private readonly loader: ActorPrincipalLoader,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
    private readonly manualSync: VcsManualSync,
  ) {}

  onModuleInit(): void {
    // `gate-secret` (US-002): the request stores the redacted connection, so no token reaches the row,
    // the hash or a decider. Approving runs nothing; the requester redeems it by re-sending the body,
    // and the token that lands is the one in that re-sent body.
    this.commands.register(routeCommand<{ slug: string; projectId: string; connection: CreateVcsConnectionDto }, VcsConnectionCreatedResponseDto>({
      key: 'vcs.connection.create', variant: VCS_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug, projectId } = parseRouteInput(input, ['slug', 'projectId']);
        const source = input as Record<string, unknown>;
        return { slug, projectId, connection: parseBody(CreateVcsConnectionDto, source.connection ?? {}) };
      },
      redeem: {
        redact: ({ slug, projectId, connection }) => ({
          slug, projectId, connection: { ...connection, token: redactSecret(connection.token) },
        }),
      },
      run: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.create(input.projectId, key, input.connection);
      },
      // The generated secret leaves the server once, in this call's answer (M9); the request keeps the
      // connection alone.
      toResult: ({ webhookSecret: _webhookSecret, ...result }) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string }, ApplyPrStatusesResult>({
      key: 'vcs.sync.pr', variant: VCS_ROUTE_VARIANTS.syncPr,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId']),
      run: (_principal, input) => this.manualSync.syncPr(input.slug),
      prepare: (_principal, input) => this.manualSync.prepareSyncPr(input.slug),
      afterCommit: (_principal, _input, result) => this.manualSync.startPrExtractions(result),
      toResult: (result) => ({ updated: result.updated }),
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string; issueNumber: string }, SyncResultDto>({
      key: 'vcs.sync.issue', variant: VCS_ROUTE_VARIANTS.syncIssue,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'issueNumber']),
      run: (_principal, input) => this.manualSync.syncIssue(input.slug, input.issueNumber),
      prepare: (_principal, input) => this.manualSync.prepareSyncIssue(input.slug, input.issueNumber),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string }, SyncResultDto>({
      key: 'vcs.sync.all', variant: VCS_ROUTE_VARIANTS.syncAll,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId']),
      run: (_principal, input) => this.manualSync.syncAll(input.slug),
      prepare: (_principal, input) => this.manualSync.prepareSyncAll(input.slug),
      toResult: (result) => result,
    }, this.loader));
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
